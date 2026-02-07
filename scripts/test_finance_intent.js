const fs = require('fs');
const path = require('path');
const engine = require('./molt_engine');

const CASES_PATH = path.join(__dirname, '../notes/fixtures/finance_intent_cases.json');

function loadCases() {
    return JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
}

function pick(obj, keys) {
    const out = {};
    for (const key of keys) {
        out[key] = obj[key];
    }
    return out;
}

function run() {
    const cases = loadCases();
    let passed = 0;
    const failures = [];

    for (const tc of cases) {
        const preview = engine.previewFinanceParse(tc.input);
        if (!preview.success) {
            failures.push({
                input: tc.input,
                reason: `preview failed: ${preview.error}`,
            });
            continue;
        }

        const actual = preview.data;
        const expected = tc.expect || {};
        const mismatch = {};

        for (const [key, value] of Object.entries(expected)) {
            const actualValue =
                key === 'isIncome' && typeof actual.isIncome === 'undefined'
                    ? Number(actual.amount) > 0
                    : actual[key];
            if (actualValue !== value) {
                mismatch[key] = { expected: value, actual: actualValue };
            }
        }

        if (Object.keys(mismatch).length > 0) {
            failures.push({
                input: tc.input,
                mismatch,
                actual: pick(actual, Object.keys(expected)),
            });
            continue;
        }

        passed += 1;
    }

    const report = {
        total: cases.length,
        passed,
        failed: failures.length,
        failures,
    };

    console.log(JSON.stringify(report, null, 2));
    if (failures.length > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    run();
}
