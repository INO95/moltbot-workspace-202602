const OPS_ALLOWED_TARGETS = {
  dev: 'moltbot-dev',
  anki: 'moltbot-anki',
  research: 'moltbot-research',
  daily: 'moltbot-daily',
  codex: 'moltbot-codex',
  dev_bak: 'moltbot-dev-bak',
  anki_bak: 'moltbot-anki-bak',
  research_bak: 'moltbot-research-bak',
  daily_bak: 'moltbot-daily-bak',
  // Legacy aliases
  main: 'moltbot-dev',
  sub1: 'moltbot-anki',
  main_bak: 'moltbot-dev-bak',
  sub1_bak: 'moltbot-anki-bak',
  proxy: 'moltbot-proxy',
  webproxy: 'moltbot-web-proxy',
  tunnel: 'moltbot-dev-tunnel',
  prompt: 'moltbot-prompt-web',
  web: ['moltbot-prompt-web', 'moltbot-web-proxy'],
  all: [
    'moltbot-dev',
    'moltbot-anki',
    'moltbot-research',
    'moltbot-daily',
    'moltbot-codex',
    'moltbot-dev-bak',
    'moltbot-anki-bak',
    'moltbot-research-bak',
    'moltbot-daily-bak',
    'moltbot-prompt-web',
    'moltbot-proxy',
    'moltbot-web-proxy',
    'moltbot-dev-tunnel',
  ],
};

function normalizeOpsAction(value) {
  const v = String(value || '').trim().toLowerCase();
  if (/(재시작|restart|reboot)/.test(v)) return 'restart';
  if (/(상태|status|health|check)/.test(v)) return 'status';
  if (/(파일|file|fs|git)/.test(v)) return 'file';
  if (/(실행|exec|shell|terminal|command)/.test(v)) return 'exec';
  if (/(코덱스|codex|openclaw)/.test(v)) return 'codex';
  if (/(메일|mail|email)/.test(v)) return 'mail';
  if (/(사진|photo|image|camera|cam)/.test(v)) return 'photo';
  if (/(일정|스케줄|schedule|calendar)/.test(v)) return 'schedule';
  if (/(브라우저|browser|웹자동화)/.test(v)) return 'browser';
  if (/(토큰조회|승인조회|토큰|token)/.test(v)) return 'token';
  if (/(승인|approve)/.test(v)) return 'approve';
  if (/(거부|deny)/.test(v)) return 'deny';
  return null;
}

const OPS_CAPABILITY_POLICY = Object.freeze({
  mail: Object.freeze({
    list: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
    summary: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
    send: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
  }),
  photo: Object.freeze({
    capture: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
    list: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
    cleanup: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
  }),
  schedule: Object.freeze({
    list: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
    create: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
    update: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
    delete: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
  }),
  browser: Object.freeze({
    open: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
    list: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
    click: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
    type: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
    wait: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
    screenshot: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
    checkout: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
    post: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
    send: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
  }),
  exec: Object.freeze({
    run: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
  }),
  codex: Object.freeze({
    start: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
    answer: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
    status: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
    cancel: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
  }),
});

function normalizeOpsCapabilityAction(capability, value) {
  const raw = String(value || '').trim().toLowerCase();
  if (capability === 'mail') {
    if (/(list|목록|조회|inbox|메일함)/.test(raw)) return 'list';
    if (/(summary|요약|digest)/.test(raw)) return 'summary';
    if (/(send|전송|발송|보내기)/.test(raw)) return 'send';
    return 'list';
  }
  if (capability === 'photo') {
    if (/(capture|snap|shoot|촬영|캡처)/.test(raw)) return 'capture';
    if (/(list|목록|조회)/.test(raw)) return 'list';
    if (/(cleanup|정리|clean|삭제)/.test(raw)) return 'cleanup';
    return 'list';
  }
  if (capability === 'schedule') {
    if (/(list|목록|조회)/.test(raw)) return 'list';
    if (/(create|add|등록|추가)/.test(raw)) return 'create';
    if (/(update|edit|수정|변경)/.test(raw)) return 'update';
    if (/(delete|remove|삭제)/.test(raw)) return 'delete';
    return 'list';
  }
  if (capability === 'browser') {
    if (/(open|열기|navigate|접속|이동)/.test(raw)) return 'open';
    if (/(list|목록|조회)/.test(raw)) return 'list';
    if (/(click|클릭)/.test(raw)) return 'click';
    if (/(type|입력)/.test(raw)) return 'type';
    if (/(wait|대기)/.test(raw)) return 'wait';
    if (/(screenshot|캡처|스크린샷)/.test(raw)) return 'screenshot';
    if (/(checkout|결제)/.test(raw)) return 'checkout';
    if (/(post|요청|전송요청)/.test(raw)) return 'post';
    if (/(send|보내기|발송)/.test(raw)) return 'send';
    return 'list';
  }
  if (capability === 'exec') {
    return 'run';
  }
  if (capability === 'codex') {
    if (/(start|run|new|시작|실행|요청)/.test(raw)) return 'start';
    if (/(answer|reply|resume|continue|답변|응답|재개|이어)/.test(raw)) return 'answer';
    if (/(status|state|조회|상태)/.test(raw)) return 'status';
    if (/(cancel|stop|abort|취소|중단)/.test(raw)) return 'cancel';
    return 'start';
  }
  return null;
}

function buildCapabilityPayload(fields = {}) {
  return {
    target: String(fields.대상 || '').trim(),
    reason: String(fields.사유 || '').trim(),
    path: String(fields.경로 || '').trim(),
    target_path: String(fields.대상경로 || '').trim(),
    pattern: String(fields.패턴 || '').trim(),
    account: String(fields.계정 || '').trim(),
    recipient: String(fields.수신자 || '').trim(),
    subject: String(fields.제목 || '').trim(),
    body: String(fields.본문 || '').trim(),
    content: String(fields.내용 || '').trim(),
    when: String(fields.시간 || '').trim(),
    attachment: String(fields.첨부 || '').trim(),
    device: String(fields.장치 || '').trim(),
    identifier: String(fields.식별자 || '').trim(),
    url: String(fields.URL || '').trim(),
    selector: String(fields.셀렉터 || '').trim(),
    key: String(fields.키 || '').trim(),
    value: String(fields.값 || '').trim(),
    method: String(fields.메서드 || '').trim(),
    command: String(fields.명령 || '').trim(),
    prompt: String(fields.요청 || '').trim(),
    answer: String(fields.답변 || '').trim(),
    thread_id: String(fields.스레드 || '').trim(),
  };
}

function normalizeOpsTarget(value) {
  const raw = String(value || '').trim().toLowerCase();
  const map = {
    dev: 'dev',
    개발: 'dev',
    main: 'dev',
    메인: 'dev',
    anki: 'anki',
    안키: 'anki',
    sub: 'anki',
    sub1: 'anki',
    서브: 'anki',
    research: 'research',
    리서치: 'research',
    리서쳐: 'research',
    daily: 'daily',
    일상: 'daily',
    codex: 'codex',
    코덱스: 'codex',
    openclaw: 'codex',
    오픈클로: 'codex',
    dev_bak: 'dev_bak',
    'dev-bak': 'dev_bak',
    main_bak: 'dev_bak',
    'main-bak': 'dev_bak',
    개발백업: 'dev_bak',
    anki_bak: 'anki_bak',
    'anki-bak': 'anki_bak',
    sub1_bak: 'anki_bak',
    'sub1-bak': 'anki_bak',
    안키백업: 'anki_bak',
    research_bak: 'research_bak',
    'research-bak': 'research_bak',
    리서쳐백업: 'research_bak',
    daily_bak: 'daily_bak',
    'daily-bak': 'daily_bak',
    일상백업: 'daily_bak',
    proxy: 'proxy',
    프록시: 'proxy',
    webproxy: 'webproxy',
    웹프록시: 'webproxy',
    tunnel: 'tunnel',
    터널: 'tunnel',
    prompt: 'prompt',
    프롬프트: 'prompt',
    web: 'web',
    웹: 'web',
    all: 'all',
    전체: 'all',
  };
  return map[raw] || null;
}

module.exports = {
  OPS_ALLOWED_TARGETS,
  OPS_CAPABILITY_POLICY,
  normalizeOpsAction,
  normalizeOpsCapabilityAction,
  buildCapabilityPayload,
  normalizeOpsTarget,
};
