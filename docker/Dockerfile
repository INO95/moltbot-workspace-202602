# Moltbot Docker Image
# Node.js 기반 OpenClaw 호환 환경

FROM node:22-alpine

# 보안: 비루트 사용자 생성
RUN addgroup -g 1001 -S moltbot && \
    adduser -u 1001 -S moltbot -G moltbot

# 작업 디렉토리 설정
WORKDIR /app

# 필수 패키지 설치
RUN apk add --no-cache \
    git \
    curl \
    tzdata \
    && rm -rf /var/cache/apk/*

# package.json 복사 및 의존성 설치
COPY --chown=moltbot:moltbot ../package*.json ./
RUN npm ci --only=production && npm cache clean --force

# 소스 코드 복사
COPY --chown=moltbot:moltbot ../scripts ./scripts/

# 비루트 사용자로 전환
USER moltbot

# 헬스체크
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('healthy')" || exit 1

# 기본 명령
CMD ["node", "scripts/molt_engine.js"]
