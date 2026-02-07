---
name: code-tutor
description: 코드 리뷰, 리팩토링 제안, 에러 로그 분석 (Java/Python 특화)
triggers:
  - pattern: "^/review\\s+"
    channel: telegram
  - pattern: "^/error\\s+"
    channel: telegram
  - pattern: "^/explain\\s+"
    channel: telegram
---

# Code Tutor (코딩 멘토)

Java와 Python 코드를 리뷰하고, 에러를 분석하며, 개선점을 제안합니다.

## 사용법

### 코드 리뷰
```
/review [코드 붙여넣기]
```

### 에러 분석
```
/error [에러 메시지 붙여넣기]
```

### 개념 설명
```
/explain Java Stream API
/explain Python decorator
```

## 기능

1. **코드 리뷰** - 스타일, 버그, 리팩토링 제안
2. **에러 분석** - 스택 트레이스 분석 및 해결책
3. **오답 노트** - 중요 피드백 자동 저장

## 저장 경로
`~/Documents/Moltbot_Workspace/notes/code-reviews/YYYY-MM-DD_topic.md`
