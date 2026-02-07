---
name: expense-tracker
description: Google Sheets Expense Tracker & Habit Checklist Integration
version: 1.0.0
---

# Expense Tracker Skill

This skill allows you to manage expenses and track daily habits by interacting with a Google Sheet via `scripts/bridge.js`.

## 1. Expense & Income (`/spend`)

Record financial transactions. The system automatically parses amount, item, payment method, and category from natural language.

**Trigger:**
- User types `/spend <text>`
- User types natural expense log (e.g., "Lunch 1200 yen")

**Action:**
Run the bridge script:
```bash
node /home/node/.openclaw/workspace/scripts/bridge.js spend "<text>"
```

**Response:**
- Success: "💸 Recorded: <item> (<amount>) - <method> [<category>]"
- Error: "❌ Failed: <error message>"

## 2. Daily Checklist (`/check` or `/do`)

Record daily habits or activities. Supports shortcuts like "운완" (Workout done), "안키" (Anki done).

**Trigger:**
- User types `/check <activity>`
- User types `/do <activity>`

**Action:**
Run the bridge script:
```bash
node /home/node/.openclaw/workspace/scripts/bridge.js checklist "<activity>"
```

**Response:**
- Success: "📝 Checked: <activity>"

## 3. Balance Inquiry (`/balance`)

Check current account balances.

**Trigger:**
- User types `/balance`
- User types `/balance <account_name>`

**Action:**
Run the bridge script:
```bash
node /home/node/.openclaw/workspace/scripts/bridge.js balance "<account_name>"
```

**Response:**
- Show formatted balance list.

## 4. Daily Summary (`/summary`)

Show today's checklist status.

**Trigger:**
- User types `/summary`

**Action:**
Run the bridge script:
```bash
node /home/node/.openclaw/workspace/scripts/bridge.js summary
```
