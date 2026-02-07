const fs = require('fs');
const path = require('path');

const config = require('../data/config.json');
const localDbPath = path.join(__dirname, '../data/finance_db.json');
const backupRoot = path.join(__dirname, '../data/backup');
const reportRoot = path.join(__dirname, '../logs/reports');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function parseAmount(value) {
    const n = parseInt(String(value ?? '').replace(/[^0-9-]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
}

function parseDateToIso(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

    if (/^\d{2}\s\d{2}\s\d{2}/.test(s)) {
        const [yy, mm, dd] = s.split(/\s+/);
        return `20${yy}-${mm}-${dd}`;
    }
    if (/^\d{4}\s\d{2}\s\d{2}$/.test(s)) {
        return s.replace(/\s/g, '-');
    }
    return null;
}

function isIncomeLike(text) {
    const t = String(text || '').toLowerCase();
    const keywords = ['월급', '급여', '입금', '보너스', '수입', '이자', '환급', '받음'];
    return keywords.some(k => t.includes(k));
}

function findLatestBackupDir() {
    if (!fs.existsSync(backupRoot)) return null;
    const dirs = fs
        .readdirSync(backupRoot)
        .map(name => path.join(backupRoot, name))
        .filter(p => fs.statSync(p).isDirectory())
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return dirs[0] || null;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function analyzeSheetRows(rows) {
    const analysis = {
        totalRows: rows.length,
        emptyRows: 0,
        invalidDates: 0,
        duplicates: 0,
        signMismatch: 0,
        unknownPaymentMethod: 0,
        categoryMissing: 0,
    };

    const duplicates = [];
    const signMismatch = [];
    const unknownMethods = [];
    const categoryMissing = [];
    const seen = new Set();

    for (const row of rows) {
        const item = row['항목'] || '';
        const method = row['결제수단'] || '';
        const category = row['카테고리'] || '';
        const memo = row['메모'] || '';
        const amount = parseAmount(row['금액 (엔)']);
        const dateIso = parseDateToIso(row['날짜']);

        if (!item && !method && !category && !memo && amount === 0 && !row['날짜']) {
            analysis.emptyRows += 1;
            continue;
        }
        if (!dateIso) analysis.invalidDates += 1;

        const dupKey = `${dateIso || row['날짜']}|${item}|${amount}|${method}`;
        if (seen.has(dupKey)) {
            analysis.duplicates += 1;
            if (duplicates.length < 20) duplicates.push(dupKey);
        } else {
            seen.add(dupKey);
        }

        const looksIncome = isIncomeLike(`${item} ${category} ${memo}`);
        if ((looksIncome && amount < 0) || (!looksIncome && amount > 0)) {
            analysis.signMismatch += 1;
            if (signMismatch.length < 20) {
                signMismatch.push({
                    date: row['날짜'] || '',
                    item,
                    amount,
                    category,
                    memo,
                });
            }
        }

        if (method && !config.paymentMethods[method]) {
            // Known exceptional values from legacy sheets.
            const allowedLegacy = ['현금 인출', 'ATM', 'atm', '카드대금', '카드 대금'];
            const isLegacy = allowedLegacy.some(x => method.includes(x));
            if (!isLegacy) {
                analysis.unknownPaymentMethod += 1;
                if (unknownMethods.length < 20) unknownMethods.push(method);
            }
        }

        if (!category || category === '기타') {
            const predicted = Object.entries(config.categories).find(([, info]) =>
                (info.keywords || []).some(k => `${item} ${memo}`.toLowerCase().includes(String(k).toLowerCase())),
            );
            if (predicted && predicted[0] !== '기타') {
                analysis.categoryMissing += 1;
                if (categoryMissing.length < 20) {
                    categoryMissing.push({
                        date: row['날짜'] || '',
                        item,
                        amount,
                        current: category || '(empty)',
                        suggested: predicted[0],
                    });
                }
            }
        }
    }

    return { analysis, duplicates, signMismatch, unknownMethods, categoryMissing };
}

function buildMarkdownReport(input) {
    const { generatedAt, backupDir, sheetName, sheetPath, localTxCount, details } = input;
    const a = details.analysis;
    const lines = [
        `# Finance Audit (${generatedAt})`,
        '',
        `- Backup dir: ${backupDir || 'N/A'}`,
        `- Sheet source: ${sheetName} (${sheetPath || 'N/A'})`,
        `- Local DB transactions: ${localTxCount}`,
        '',
        '## Summary',
        `- Total rows: ${a.totalRows}`,
        `- Empty rows: ${a.emptyRows}`,
        `- Invalid dates: ${a.invalidDates}`,
        `- Duplicates: ${a.duplicates}`,
        `- Sign mismatch candidates: ${a.signMismatch}`,
        `- Unknown payment method: ${a.unknownPaymentMethod}`,
        `- Category missing/misclassified candidates: ${a.categoryMissing}`,
        '',
        '## Recommendations',
        '- Keep one canonical ledger (local DB + append-only).',
        '- Avoid re-running destructive migration scripts across legacy sheets.',
        '- Normalize date/sign once during ingest, not during downstream reporting.',
        '- Fix unknown payment methods in config before further automation.',
        '',
    ];

    if (details.signMismatch.length > 0) {
        lines.push('## Sign mismatch sample');
        for (const row of details.signMismatch.slice(0, 10)) {
            lines.push(`- ${row.date} | ${row.item} | ${row.amount} | ${row.category} | ${row.memo}`);
        }
        lines.push('');
    }

    if (details.categoryMissing.length > 0) {
        lines.push('## Category correction sample');
        for (const row of details.categoryMissing.slice(0, 10)) {
            lines.push(`- ${row.date} | ${row.item} | ${row.amount} | ${row.current} -> ${row.suggested}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

function runAudit() {
    ensureDir(reportRoot);

    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const generatedAt = now.toISOString();
    const backupDir = findLatestBackupDir();
    const localDb = fs.existsSync(localDbPath) ? readJson(localDbPath) : { transactions: [] };
    const localTxCount = Array.isArray(localDb.transactions) ? localDb.transactions.length : 0;

    let sheetPath = null;
    let sheetName = null;
    let rows = [];

    if (backupDir) {
        const v2Path = path.join(backupDir, '가계부_V2.json');
        const legacyPath = path.join(backupDir, '가계부.json');
        if (fs.existsSync(v2Path)) {
            sheetPath = v2Path;
            sheetName = '가계부_V2';
        } else if (fs.existsSync(legacyPath)) {
            sheetPath = legacyPath;
            sheetName = '가계부';
        }
        if (sheetPath) {
            const payload = readJson(sheetPath);
            rows = Array.isArray(payload.rows) ? payload.rows : [];
        }
    }

    const details = analyzeSheetRows(rows);
    const report = buildMarkdownReport({
        generatedAt,
        backupDir,
        sheetName,
        sheetPath,
        localTxCount,
        details,
    });

    const reportPath = path.join(reportRoot, `finance-audit-${stamp}.md`);
    fs.writeFileSync(reportPath, report, 'utf8');

    console.log(report);
    console.log(`Saved: ${reportPath}`);
}

if (require.main === module) runAudit();

module.exports = { runAudit };
