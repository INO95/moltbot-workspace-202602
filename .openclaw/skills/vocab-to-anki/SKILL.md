---
name: vocab-to-anki
description: Add vocabulary cards to Anki with AI-generated definitions and examples
version: 1.1.0
---

# Vocab to Anki Skill (TOEIC Focused)

This skill generates highly effective vocabulary cards for TOEIC preparation. It processes single words, multiple words, or word+meaning pairs provided by the user.

## Usage

**Trigger:**
- User types `/anki <word(s)>`
- User types "단어장 추가: <words>"

**Process:**
1. **Analyze**: Identify the target words. If multiple words, process each one sequentially or create a combined card if they form a phrase.
2. **Generate**: Create the content.
   - **Front**: The English word/phrase.
   - **Back**: A structured HTML explanation including:
     - **Meaning**: Korean translation (bold/emphasized).
     - **Example**: An English example sentence relevant to TOEIC business context.
     - **Translation**: Korean translation of the example sentence.
3. **Execute**: Call the centralized bridge `word` route (quality engine + fallback included).

**Format (Back Content):**
Use `\n` for line breaks (bridge script will convert to `<br>`).
Format: `**[뜻]**\n\nExample: *[예문]*\n([예문 해석])`

**Command:**
```bash
node /home/node/.openclaw/workspace/scripts/bridge.js word "<word(s)>"
```

**Examples:**

1. **User input:** `/anki epiphany`
   - **Command**: `node /home/node/.openclaw/workspace/scripts/bridge.js word "epiphany"`

2. **User input:** `/anki comply with / adhere to`
   - **Command**: `node /home/node/.openclaw/workspace/scripts/bridge.js word "comply with / adhere to"`

**Response:**
- "✅ Added to **TOEIC_AI** via quality pipeline"
