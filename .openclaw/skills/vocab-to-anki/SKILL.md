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
3. **Execute**: Call the bridge script. Use the `TOEIC_AI` deck.

**Format (Back Content):**
Use `\n` for line breaks (bridge script will convert to `<br>`).
Format: `**[뜻]**\n\nExample: *[예문]*\n([예문 해석])`

**Command:**
```bash
node /home/node/.openclaw/workspace/scripts/bridge.js anki add "TOEIC_AI" "<Front>" "<Back>" "toeic,ai"
```

**Examples:**

1. **User input:** `/anki epiphany`
   - **Front**: `epiphany`
   - **Back**: `**직관적인 통찰, 깨달음**\n\nExample: *It was a moment of sudden epiphany for the marketing team.* \n(그것은 마케팅 팀에게 갑작스러운 통찰의 순간이었다.)`
   - **Command**: `node /home/node/.openclaw/workspace/scripts/bridge.js anki add "TOEIC_AI" "epiphany" "**직관적인 통찰, 깨달음**\n\nExample: *It was a moment of sudden epiphany for the marketing team.* \n(그것은 마케팅 팀에게 갑작스러운 통찰의 순간이었다.)" "toeic,ai"`

2. **User input:** `/anki comply with / adhere to` (Multiple items - Handle one by one or ask user. Here, assume separate commands if possible, or distinct cards.)
   - If User says "comply with", treat as one phrase.

**Response:**
- "✅ Added to **TOEIC_AI**: **<Front>**\n\n<Back content simplified>"
