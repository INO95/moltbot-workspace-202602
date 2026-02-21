# API-Key Lane Activation Checklist

Last updated: 2026-02-14

## Current baseline (today)
- 운영 기본은 OAuth-only.
- `data/oai_api_routing_policy.json`에서 `guards.enableApiKeyLane=false`.
- API-Key lane은 코드 준비만 되어 있고 정책상 차단 상태.

## 0) 사전 확인 (읽기 전용)
```bash
npm run -s oai:lane:status
```

확인 포인트:
- `lane.enabled`가 `false`인지
- `env.hasOpenAiApiKey`, `env.paidApiApproved`, `env.rateLimitSafeMode`

## 1) 임시 활성화 (세션 한정, 권장)
정책 파일을 건드리지 않고, 이번 셸에서만 API-Key lane을 열어 테스트.

```bash
export MOLTBOT_ENABLE_API_KEY_LANE=true
export MOLTBOT_ALLOW_PAID_API=true
export OPENAI_API_KEY='sk-...'
npm run -s oai:lane:status
```

주의:
- `RATE_LIMIT_SAFE_MODE=true`면 여전히 차단됨.
- 셸 종료 시 자동으로 원복됨.

## 2) 영구 활성화 (정책 반영)
정책 파일에서 lane을 켬.

```bash
npm run -s oai:lane:enable
npm run -s oai:lane:status
```

동작:
- `guards.enableApiKeyLane=true`
- 키워드 자동전환(`api-key-required-keywords`)은 기본적으로 그대로 유지(현재 disabled 상태 유지)

## 3) 키워드 자동전환까지 켜기 (선택)
`realtime/webhook/batch` 키워드가 들어오면 자동으로 API-Key lane을 타게 함.

```bash
npm run -s oai:lane:enable:full
npm run -s oai:lane:status
```

## 4) 브리지 결과 확인
수동 override로 차단/허용 메타 확인.

```bash
node scripts/bridge.js work "요청: realtime 연동; 대상: x; 완료기준: y; API: key"
```

확인 필드:
- `apiLane`
- `apiBlocked`
- `apiBlockReason`
- `apiFallbackLane`

## 5) 프록시 경로 점검
```bash
node scripts/test_codex_proxy_routes.js
```

## 6) 롤백 (OAuth-only 복귀)
```bash
npm run -s oai:lane:disable
unset MOLTBOT_ENABLE_API_KEY_LANE
unset MOLTBOT_ALLOW_PAID_API
npm run -s oai:lane:status
```

## Troubleshooting
- `api_key_lane_disabled`:
  - 정책 lane 비활성(`enableApiKeyLane=false`) 또는 env override 미설정.
- `paid_api_approval_required`:
  - `MOLTBOT_ALLOW_PAID_API=true` 필요.
- `openai_api_key_missing`:
  - `OPENAI_API_KEY` 또는 `OPENCLAW_OPENAI_API_KEY` 필요.
- `rate_limit_safe_mode`:
  - `RATE_LIMIT_SAFE_MODE=true` 상태. 해제 전까지 API-Key lane 차단.
