#!/usr/bin/env bash
set -euo pipefail

WORKDIR="/Users/inho-baek/Projects/Moltbot_Workspace"
LOGDIR="$WORKDIR/logs"
mkdir -p "$LOGDIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="$LOGDIR/gmail_night_report_${STAMP}.md"
STATE="$LOGDIR/gmail_night_state_${STAMP}.json"

QUERY="${QUERY:-in:inbox before:2025/01/01 -is:important -is:starred}"
LABEL_REVIEW="${LABEL_REVIEW:-OC/OldMail-Review}"
LABEL_IMPORTANT="${LABEL_IMPORTANT:-OC/Important-Review}"

# labels (ignore if already exists)
gog gmail labels create "$LABEL_REVIEW" >/dev/null 2>&1 || true
gog gmail labels create "$LABEL_IMPORTANT" >/dev/null 2>&1 || true

python3 - <<'PY' "$REPORT" "$QUERY"
import sys, datetime
p=sys.argv[1]
query=sys.argv[2]
with open(p,'w',encoding='utf-8') as f:
    f.write(f"# Gmail Night Sort Report\n\n")
    f.write(f"- started_utc: {datetime.datetime.utcnow().isoformat()}Z\n")
    f.write("- policy: query 기반 분류 / no delete / unread 유지\n")
    f.write(f"- query: {query}\n\n")
PY

TOTAL=0
IMPORTANT_TOTAL=0
MODE="${MODE:-until_done}"   # until_done | batch
ROUNDS="${ROUNDS:-60}"        # batch 모드에서만 사용
MAX_ROUNDS="${MAX_ROUNDS:-0}" # until_done 안전퓨즈(0=무제한)
BATCH="${BATCH:-100}"
SLEEP_SEC="${SLEEP_SEC:-45}"

STOP_REASON="unknown"
r=0
while true; do
  r=$((r+1))
  RAW="$LOGDIR/gmail_round_${STAMP}_${r}.json"
  gog gmail messages search "$QUERY" --max "$BATCH" --json --results-only > "$RAW" || true

  python3 - <<'PY' "$RAW" "$STATE" "$r"
import json,sys,re,collections
raw,state,r=sys.argv[1],sys.argv[2],int(sys.argv[3])
try:
    data=json.load(open(raw))
except Exception:
    data=[]
imp_kw=re.compile(r'(invoice|receipt|security|verify|verification|alert|account|billing|payment|bank|tax|visa|flight|hotel|예약|결제|청구|보안|인증|항공|숙소)',re.I)
important=[]
normal=[]
from_counter=collections.Counter()
for m in data:
    mid=m.get('id')
    if not mid: continue
    s=(m.get('subject') or '')+' '+(m.get('from') or '')
    from_counter[m.get('from') or 'unknown']+=1
    if imp_kw.search(s): important.append(mid)
    else: normal.append(mid)
out={"round":r,"count":len(data),"important":important,"normal":normal,"topFrom":from_counter.most_common(8)}
json.dump(out,open(state,'w'))
PY

  COUNT=$(python3 - <<'PY' "$STATE"
import json,sys
s=json.load(open(sys.argv[1]))
print(s.get('count',0))
PY
)
  if [ "$COUNT" -eq 0 ]; then
    echo "- round $r: 대상 없음(완료)" >> "$REPORT"
    STOP_REASON="done_no_targets"
    break
  fi

  NORMAL_IDS=$(python3 - <<'PY' "$STATE"
import json,sys
s=json.load(open(sys.argv[1]))
print(' '.join(s.get('normal',[])))
PY
)
  IMPORTANT_IDS=$(python3 - <<'PY' "$STATE"
import json,sys
s=json.load(open(sys.argv[1]))
print(' '.join(s.get('important',[])))
PY
)

  if [ -n "$NORMAL_IDS" ]; then
    # 분류(아카이브): 삭제 아님
    gog gmail batch modify $NORMAL_IDS --add "$LABEL_REVIEW" --remove INBOX >/dev/null || true
  fi

  if [ -n "$IMPORTANT_IDS" ]; then
    # 중요 후보는 보관 라벨만 추가 (unread 유지)
    gog gmail batch modify $IMPORTANT_IDS --add "$LABEL_IMPORTANT" >/dev/null || true
  fi

  IMP_N=$(python3 - <<'PY' "$STATE"
import json,sys
s=json.load(open(sys.argv[1]))
print(len(s.get('important',[])))
PY
)

  TOTAL=$((TOTAL + COUNT))
  IMPORTANT_TOTAL=$((IMPORTANT_TOTAL + IMP_N))

  echo "- round $r: 분류 $COUNT건 (중요후보 $IMP_N건)" >> "$REPORT"

  # 종료 조건(목표 기반)
  if [ "$MODE" = "batch" ] && [ "$r" -ge "$ROUNDS" ]; then
    STOP_REASON="batch_limit_reached"
    break
  fi

  if [ "$MODE" = "until_done" ] && [ "$MAX_ROUNDS" -gt 0 ] && [ "$r" -ge "$MAX_ROUNDS" ]; then
    STOP_REASON="safety_fuse_max_rounds"
    break
  fi

  # rate limit 완화
  sleep "$SLEEP_SEC"
done

{
  echo ""
  echo "## Summary"
  echo "- mode: $MODE"
  echo "- rounds_executed: $r"
  echo "- stop_reason: $STOP_REASON"
  echo "- total_classified: $TOTAL"
  echo "- important_candidates: $IMPORTANT_TOTAL"
  echo "- delete: 0 (정책상 미실행)"
  echo "- unread: 유지"
  echo "- labels: $LABEL_REVIEW, $LABEL_IMPORTANT"
} >> "$REPORT"

echo "$REPORT"
