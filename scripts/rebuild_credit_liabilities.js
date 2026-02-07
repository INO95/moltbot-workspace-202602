const fs = require('fs');
const path = require('path');
const config = require('../data/config.json');

const DB_PATH = path.join(__dirname, '../data/finance_db.json');

function readDB() {
    if (!fs.existsSync(DB_PATH)) return null;
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDB(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function sortedTransactions(transactions) {
    return [...transactions].sort((a, b) => {
        const ak = `${a.created_at || ''}-${a.id || 0}`;
        const bk = `${b.created_at || ''}-${b.id || 0}`;
        return ak.localeCompare(bk);
    });
}

function rebuild(db) {
    const liabilities = {};
    const creditCards =
        Array.isArray(config.financePolicy?.creditCards) && config.financePolicy.creditCards.length > 0
            ? config.financePolicy.creditCards
            : [];

    for (const tx of sortedTransactions(db.transactions || [])) {
        const amountAbs = Math.abs(parseInt(tx.amount || 0, 10));
        if (!amountAbs) continue;

        if (tx.transactionType === 'expense_credit') {
            const card = tx.paymentMethod || '신용카드';
            liabilities[card] = (liabilities[card] || 0) + amountAbs;
            continue;
        }

        if (tx.transactionType === 'credit_settlement') {
            let remaining = amountAbs;
            const referenced = Array.isArray(tx.meta?.referencedCards) && tx.meta.referencedCards.length > 0
                ? tx.meta.referencedCards
                : creditCards;

            for (const card of referenced) {
                if (remaining <= 0) break;
                const prev = liabilities[card] || 0;
                if (prev <= 0) continue;
                const consume = Math.min(prev, remaining);
                liabilities[card] = prev - consume;
                remaining -= consume;
            }

            if (remaining > 0) {
                liabilities['(unmatched-settlement)'] = (liabilities['(unmatched-settlement)'] || 0) + remaining;
            }
        }
    }

    db.liabilities = db.liabilities || {};
    db.liabilities.creditCards = liabilities;
    return db;
}

function run() {
    const db = readDB();
    if (!db) {
        console.error('finance_db.json not found');
        process.exit(1);
    }
    const updated = rebuild(db);
    writeDB(updated);
    console.log(
        JSON.stringify(
            {
                ok: true,
                liabilities: updated.liabilities.creditCards,
                txCount: (updated.transactions || []).length,
            },
            null,
            2,
        ),
    );
}

if (require.main === module) {
    run();
}
