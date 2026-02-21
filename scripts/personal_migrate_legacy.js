#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const storage = require('./personal_storage');

const ROOT = path.join(__dirname, '..');
const LEGACY_FINANCE_DB = path.join(ROOT, 'data', 'finance_db.json');
const LEGACY_EXPENSES_CSV = path.join(ROOT, 'data', 'expenses.csv');
const LEGACY_MEMO_JSONL = path.join(ROOT, 'data', 'runtime', 'memo_journal_entries.jsonl');

function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv.slice() : [];
    return {
        apply: args.includes('--apply'),
        dbPath: (() => {
            const idx = args.indexOf('--db');
            return idx >= 0 ? String(args[idx + 1] || '') : '';
        })(),
    };
}

function readJson(filePath, fallback = {}) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function readCsvRows(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= 1) return [];
    const header = lines[0].split(',').map((v) => String(v || '').trim());
    return lines.slice(1).map((line) => {
        const parts = line.split(',');
        const row = {};
        header.forEach((key, idx) => {
            row[key] = String(parts[idx] || '').trim();
        });
        return row;
    });
}

function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch (_) {
                return null;
            }
        })
        .filter(Boolean);
}

function toEntryType(raw) {
    const type = String(raw || '').trim().toLowerCase();
    if (type === 'income' || type === 'refund' || type === 'transfer' || type === 'expense') return type;
    return Number(raw) >= 0 ? 'income' : 'expense';
}

function toCurrency(raw) {
    const code = String(raw || '').trim().toUpperCase();
    if (!code) return 'JPY';
    return code;
}

function legacyFinanceRows() {
    const doc = readJson(LEGACY_FINANCE_DB, {});
    const tx = Array.isArray(doc.transactions) ? doc.transactions : [];
    return tx.map((row) => ({
        date: String(row.date || '').trim() || storage.toIsoDate(),
        item: String(row.item || row.memo || 'legacy-finance').trim(),
        amount: Number(row.amount),
        category: String(row.category || '').trim() || '기타',
        payment_method: String(row.paymentMethod || '').trim() || '미지정',
        entry_type: toEntryType(row.transactionType || row.amount),
        currency: toCurrency((doc.config && doc.config.currency) || 'JPY'),
        source_id: String(row.id || ''),
    })).filter((row) => Number.isFinite(row.amount));
}

function legacyExpenseRows() {
    return readCsvRows(LEGACY_EXPENSES_CSV).map((row, idx) => ({
        date: String(row.date || '').trim() || storage.toIsoDate(),
        item: String(row.item || row.memo || `legacy-expense-${idx + 1}`).trim(),
        amount: Number(row.amount),
        category: String(row.category || '').trim() || '기타',
        payment_method: String(row.payment_method || '').trim() || '미지정',
        entry_type: toEntryType(row.transaction_type || row.amount),
        currency: 'JPY',
        source_id: `${row.date || 'date'}:${row.item || 'item'}:${idx}`,
    })).filter((row) => Number.isFinite(row.amount));
}

function legacyMemoRows() {
    return readJsonl(LEGACY_MEMO_JSONL).map((row, idx) => ({
        raw_text: String(row.raw || row.text || '').trim(),
        normalized_text: String(row.text || row.raw || '').trim(),
        date: String(row.date || '').trim() || storage.toIsoDate(),
        expense_yen: Number(row.expense_yen || row.expenseYen || 0),
        categories: Array.isArray(row.categories) ? row.categories : [],
        source_id: String(row.hash || row.id || `${idx}`),
    })).filter((row) => row.raw_text || row.normalized_text);
}

function importFinance(rows, options = {}) {
    let inserted = 0;
    let duplicated = 0;

    for (const row of rows) {
        if (!options.apply) {
            inserted += 1;
            continue;
        }

        const event = storage.createEvent({
            route: 'finance',
            source: 'legacy',
            rawText: `${row.item} ${row.amount}`,
            normalizedText: `${row.date} ${row.item} ${row.amount} ${row.currency}`,
            payload: row,
            dedupeMaterial: `legacy-finance:${row.source_id}`,
        }, options);

        if (event.duplicate) {
            duplicated += 1;
            continue;
        }

        storage.insertLedgerEntry({
            eventId: event.eventId,
            entryDate: row.date,
            entryType: row.entry_type,
            item: row.item,
            amount: row.amount,
            currency: row.currency,
            category: row.category,
            paymentMethod: row.payment_method,
            memo: 'legacy-import',
        }, options);
        inserted += 1;
    }

    return { inserted, duplicated, total: rows.length };
}

function importMemos(rows, options = {}) {
    let inserted = 0;
    let duplicated = 0;
    let expenseDerived = 0;

    for (const row of rows) {
        if (!options.apply) {
            inserted += 1;
            if (Number(row.expense_yen || 0) > 0) expenseDerived += 1;
            continue;
        }

        const event = storage.createEvent({
            route: 'memo',
            source: 'legacy',
            rawText: row.raw_text,
            normalizedText: row.normalized_text,
            payload: row,
            dedupeMaterial: `legacy-memo:${row.source_id}`,
        }, options);

        if (event.duplicate) {
            duplicated += 1;
            continue;
        }

        inserted += 1;

        if (Number(row.expense_yen || 0) > 0) {
            storage.insertLedgerEntry({
                eventId: event.eventId,
                entryDate: row.date,
                entryType: 'expense',
                item: row.normalized_text || row.raw_text || 'legacy-memo-expense',
                amount: -Math.abs(Number(row.expense_yen)),
                currency: 'JPY',
                category: '기타',
                paymentMethod: '미지정',
                memo: 'legacy-memo-derived',
                tags: ['legacy', 'memo-derived'],
            }, options);
            expenseDerived += 1;
        }
    }

    return { inserted, duplicated, total: rows.length, expenseDerived };
}

function runMigration(options = {}) {
    storage.ensureStorage(options);

    const financeFromDb = legacyFinanceRows();
    const financeFromCsv = legacyExpenseRows();
    const memoRows = legacyMemoRows();

    const importedDb = importFinance(financeFromDb, options);
    const importedCsv = importFinance(financeFromCsv, options);
    const importedMemo = importMemos(memoRows, options);

    return {
        ok: true,
        apply: Boolean(options.apply),
        sources: {
            finance_db_json: { path: LEGACY_FINANCE_DB, rows: financeFromDb.length, ...importedDb },
            expenses_csv: { path: LEGACY_EXPENSES_CSV, rows: financeFromCsv.length, ...importedCsv },
            memo_jsonl: { path: LEGACY_MEMO_JSONL, rows: memoRows.length, ...importedMemo },
        },
        telegramReply: [
            `Legacy migration ${options.apply ? '적용' : 'DRY-RUN'} 완료`,
            `- finance_db.json: ${importedDb.inserted}/${financeFromDb.length}`,
            `- expenses.csv: ${importedCsv.inserted}/${financeFromCsv.length}`,
            `- memo_journal_entries: ${importedMemo.inserted}/${memoRows.length} (expense-derived ${importedMemo.expenseDerived})`,
        ].join('\n'),
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const result = runMigration({ apply: args.apply, dbPath: args.dbPath || undefined });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(String(error && error.stack ? error.stack : error));
        process.exit(1);
    }
}

module.exports = {
    runMigration,
    legacyFinanceRows,
    legacyExpenseRows,
    legacyMemoRows,
};
