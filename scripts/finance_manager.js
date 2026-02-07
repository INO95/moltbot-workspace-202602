const fs = require('fs');
const path = require('path');
const config = require('../data/config.json');

class FinanceManager {
    constructor() {
        this.dbPath = path.join(__dirname, '../data/finance_db.json');
        this.backupDir = path.join(__dirname, '../data/backups');
        if (!fs.existsSync(this.backupDir)) fs.mkdirSync(this.backupDir, { recursive: true });
        this.ensureDB();
    }

    defaultDB() {
        return {
            config: {
                schemaVersion: 2,
                currency: 'JPY',
                owner: 'BAEK INHO',
                last_updated: null,
            },
            transactions: [],
            liabilities: {
                creditCards: {},
            },
            categories: Object.keys(config.categories || {}),
        };
    }

    migrateDB(db) {
        const base = this.defaultDB();
        const out = { ...base, ...(db || {}) };
        out.config = { ...base.config, ...(out.config || {}) };
        out.transactions = Array.isArray(out.transactions) ? out.transactions : [];
        out.liabilities = typeof out.liabilities === 'object' && out.liabilities ? out.liabilities : {};
        out.liabilities.creditCards =
            typeof out.liabilities.creditCards === 'object' && out.liabilities.creditCards
                ? out.liabilities.creditCards
                : {};
        out.categories = Array.isArray(out.categories) ? out.categories : base.categories;
        return out;
    }

    ensureDB() {
        if (!fs.existsSync(this.dbPath)) {
            fs.writeFileSync(this.dbPath, JSON.stringify(this.defaultDB(), null, 2), 'utf8');
            return;
        }
        try {
            const current = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
            const migrated = this.migrateDB(current);
            fs.writeFileSync(this.dbPath, JSON.stringify(migrated, null, 2), 'utf8');
        } catch {
            fs.writeFileSync(this.dbPath, JSON.stringify(this.defaultDB(), null, 2), 'utf8');
        }
    }

    readDB() {
        this.ensureDB();
        const data = fs.readFileSync(this.dbPath, 'utf8');
        return this.migrateDB(JSON.parse(data));
    }

    writeDB(data) {
        if (fs.existsSync(this.dbPath)) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.copyFileSync(this.dbPath, path.join(this.backupDir, `finance_db_backup_${timestamp}.json`));
        }
        fs.writeFileSync(this.dbPath, JSON.stringify(this.migrateDB(data), null, 2), 'utf8');
    }

    addTransaction(item, amount, category = '기타', paymentMethod = '현금', memo = '', options = {}) {
        const db = this.readDB();
        const transaction = {
            id: Date.now(),
            date: new Date().toISOString().split('T')[0],
            item,
            amount: parseInt(amount, 10),
            category,
            paymentMethod,
            memo,
            transactionType: options.transactionType || null,
            tags: Array.isArray(options.tags) ? options.tags : [],
            meta: typeof options.meta === 'object' && options.meta ? options.meta : {},
            created_at: new Date().toISOString(),
        };

        db.transactions.push(transaction);
        db.config.last_updated = transaction.date;
        this.writeDB(db);
        return transaction;
    }

    registerCreditCharge(cardMethod, amountAbs) {
        const db = this.readDB();
        const key = String(cardMethod || '신용카드');
        const prev = parseInt(db.liabilities.creditCards[key] || 0, 10);
        db.liabilities.creditCards[key] = Math.max(0, prev + Math.abs(parseInt(amountAbs || 0, 10)));
        this.writeDB(db);
        return db.liabilities.creditCards[key];
    }

    registerCreditSettlement(amountAbs, cards = []) {
        const db = this.readDB();
        let remaining = Math.abs(parseInt(amountAbs || 0, 10));
        const orderedCards =
            cards.length > 0
                ? cards
                : (config.financePolicy && Array.isArray(config.financePolicy.creditCards)
                      ? config.financePolicy.creditCards
                      : Object.keys(db.liabilities.creditCards));

        for (const card of orderedCards) {
            if (remaining <= 0) break;
            const prev = parseInt(db.liabilities.creditCards[card] || 0, 10);
            if (prev <= 0) continue;
            const consumed = Math.min(prev, remaining);
            db.liabilities.creditCards[card] = prev - consumed;
            remaining -= consumed;
        }

        if (remaining > 0) {
            const unmatched = parseInt(db.liabilities.creditCards['(unmatched-settlement)'] || 0, 10);
            db.liabilities.creditCards['(unmatched-settlement)'] = unmatched + remaining;
        }

        this.writeDB(db);
        return {
            remainingUnmatched: remaining,
            liabilities: db.liabilities.creditCards,
        };
    }

    getCreditLiabilities() {
        const db = this.readDB();
        return { ...db.liabilities.creditCards };
    }

    getStats(year, month) {
        const db = this.readDB();
        const prefix = `${year}-${String(month).padStart(2, '0')}`;
        const filtered = db.transactions.filter(t => String(t.date || '').startsWith(prefix));
        const income = filtered.filter(t => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
        const expense = filtered.filter(t => t.amount < 0).reduce((sum, t) => sum + t.amount, 0);
        return { income, expense, balance: income + expense };
    }
}

module.exports = new FinanceManager();
