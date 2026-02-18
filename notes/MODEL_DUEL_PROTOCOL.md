# Model Duel Protocol (Codex × Antigravity)

Last updated: 2026-02-13

## Purpose
- Keep existing bridge queue behavior (`data/bridge/inbox.jsonl`) unchanged.
- Add a dedicated, append-only dialogue log for model-vs-model critique loops.
- Standardize a 2-pass loop:
  - `draft (codex) -> critique (antigravity) -> revision (codex) -> final (system)`.

## File paths
- Duel event log: `/Users/moltbot/Projects/Moltbot_Workspace/data/bridge/model_duel.jsonl`
- Duel writer lock: `/Users/moltbot/Projects/Moltbot_Workspace/data/locks/model_duel.lock`

## Event schema
Each line in `model_duel.jsonl` must be one JSON object.

Required fields:
- `eventId`: unique event ID
- `debateId`: unique debate session ID
- `taskId`: bridge task ID
- `ackId`: bridge ack ID
- `timestamp`: ISO 8601
- `round`: integer >= 0
- `speaker`: `codex | antigravity | system`
- `type`: `request | draft | critique | revision | final | error`
- `content`: text body
- `contentHash`: SHA-256 hash of `content`
- `replyToEventId`: parent event (`null` allowed)
- `status`: lifecycle state (`ok | completed | degraded | error`, etc.)

Additional fields for `critique` and `revision`:
- `rubric` object with integer scores `1~5`
  - `correctness`
  - `feasibility`
  - `risk`
  - `clarity`
  - `testability`
- `issues`: non-empty array of
  - `claim`
  - `evidence`
  - `suggestedFix`

Additional fields for `revision`:
- `decision`: `accepted | rejected | partially_accepted`
- `responses`: one response per issue
  - `issueRef`
  - `decision`
  - `rationale`

## Quality gates
- Critique must contain at least one explicit opposing point and one alternative fix.
  - Enforced via non-empty `issues[].claim/evidence/suggestedFix`.
- Revision must include issue-by-issue accept/reject rationale.
  - Enforced via `responses.length === issues.length`.

## Concurrency and safety
- All writes must go through `scripts/duel_log.js` (`appendEvent`).
- Direct writes from arbitrary scripts are forbidden.
- Lock file is required (`open(..., 'wx')`) to protect append atomicity.
- Redaction hook runs before write to mask common secrets/tokens.

## Loop and timeout policy
- Max rounds are fixed to `1`.
- Timeout default is `120000ms` per stage.
- Timeout/error path:
  - emit `type=error`
  - emit `type=final` with `status=degraded`

## State machine
1. `request` (system)
2. `draft` (codex)
3. `critique` (antigravity)
4. `revision` (codex)
5. `final` (system)

Degraded path:
1. `request`
2. (any stage fails or times out)
3. `error`
4. `final(status=degraded)`

## Integration points
- `scripts/bridge.js`
  - `작업:` route now emits `duelMode` metadata.
- `scripts/ag_bridge_client.js`
  - supports `--duel`
  - sends a dedicated structured critique request (`[DUEL_CRITIQUE_REQUEST:v1]`) to Antigravity.
  - expects JSON critique payload (`content`, `rubric`, `issues`) and parses it strictly.
  - `--allow-unstructured-critique` can relax strict parsing as fallback.
- `scripts/duel_orchestrator.js`
  - canonical implementation of the 2-pass execution.

## Basic examples
Create a normal event via code:
```js
appendEvent({
  debateId: 'debate-1',
  taskId: 'task-1',
  ackId: 'ack-1',
  round: 1,
  speaker: 'codex',
  type: 'draft',
  content: 'initial draft',
  replyToEventId: 'evt-req',
  status: 'ok',
});
```

Run duel mode via CLI:
```bash
node scripts/ag_bridge_client.js --duel "요청: ...; 대상: ...; 완료기준: ..."
```

Run full dry-run harness (structured outbox simulation):
```bash
node scripts/test_ag_bridge_duel_live_harness.js
```
