const fs = require('fs');
const https = require('https');
const { spawnSync } = require('child_process');

const STYLE_VERSION = 'v2';
const DEFAULT_POLICY = {
    enableHybridFallback: true,
    qualityThreshold: 0.82,
    tipStyle: 'part-focused',
    llmFallbackMode: 'auto',
};
const DEFAULT_LLM_THINKING = 'high';
const DEFAULT_LLM_AGENT = 'wordquality';
const DEFAULT_LLM_CONTAINERS = Object.freeze(['moltbot-anki', 'moltbot-dev']);
const DEFAULT_LLM_CORRECTION_TIMEOUT_MS = 18000;
const ALLOWED_LLM_FALLBACK_MODES = new Set(['auto', 'always']);

const TOEIC_CONTEXT_RE = /\b(company|employee|employees|manager|department|contract|policy|regulation|supplier|suppliers|client|customer|shipment|warehouse|invoice|budget|audit|sales|purchase|refund|training|schedule|meeting|report|service|agreement|renewal|support|technical|system|error|help desk|it|labor|union|overtime|applicant|startup|distributor|shipping|campaign|launch|technician|router|flight|flights|weather|benefit|benefits|retention|expense|expenses|travel|vendor|proposal|formatting|inquiry|billing|payment|reimbursement|delivery|logistics|inventory|program|mentoring|workshop|deadline|designers|server|network|job|posting|electronically)\b/i;
const TOEIC_TIP_DETAIL_RE = /(함정|콜로케이션|유사|혼동|vs|전치사|어순|수동태|빈출|자주)/i;
const GENERIC_EXAMPLE_TEMPLATE_RE = [
    /^Employees are encouraged to .+ to improve team performance this quarter\.$/i,
    /^The report highlighted .+ as a key factor in the quarterly results\.$/i,
    /^A .+ response helped the team resolve the customer issue quickly\.$/i,
    /^The proposal was reviewed .+ before being submitted to the client\.$/i,
    /^All employees are expected to .+ company policy during the annual audit\.$/i,
    /^The expression ".+" appears frequently in policy and contract documents\.$/i,
    /^The manager asked the team to .+ before the deadline\.$/i,
];
const KOREAN_PLACEHOLDER_EXAMPLE_RE = /(관련 예문입니다\.?$|예문 해석 필요|해석 보강 필요)/i;

const TRANSLATION_CACHE = new Map();

const TOEIC_HINTS = {
    'be willing to': '기꺼이 ~하다, ~할 의향이 있다',
    'comply with': '준수하다, 따르다',
    'adhere to': '고수하다, 준수하다',
    'conform to': '~에 부합하다, 따르다',
    'abide by': '~을 준수하다',
    'account for': '설명하다, (비율을) 차지하다',
    'result in': '~을 초래하다',
    'result from': '~에서 기인하다',
    'contribute to': '~에 기여하다',
    'be responsible for': '~을 책임지다',
    'be subject to': '~의 적용을 받다',
    'participate in': '~에 참여하다',
    'consist of': '~로 구성되다',
    'deal with': '~을 다루다, 처리하다',
    'apply for': '~을 신청하다',
    'apply to': '~에 적용되다',
    'in charge of': '~을 담당하는',
    'rely on': '~에 의존하다',
    'attribute a to b': 'A를 B의 원인으로 돌리다',
    'fragile': '취약한, 깨지기 쉬운',
    'prompt': '신속한, 즉각적인',
    'service agreement': '서비스 계약',
    'persist': '지속하다, 계속하다',
    'gain experience': '경험을 쌓다',
    'reach a compromise': '타협점에 이르다',
    'make an appointment': '약속을 잡다',
    'take responsibility': '책임을 지다',
    'meet the requirements': '요구사항을 충족하다',
    'improve performance': '성과를 향상시키다',
    'establish a partnership': '파트너십을 맺다',
    'face challenges': '도전에 직면하다',
    'conduct a survey': '설문조사를 실시하다',
    'increase sales': '매출을 늘리다',
    'develop skills': '기술을 개발하다',
    'meet a deadline': '마감일을 지키다',
    'solve a problem': '문제를 해결하다',
    'provide assistance': '도움을 제공하다',
    'establish a connection': '연결을 구축하다',
    'on account of': '~때문에',
    'thanks to': '~덕분에',
    'such as': '예를 들어',
    'as per': '~에 따라',
    'other than': '~을 제외하고',
    'in spite of': '~에도 불구하고',
    'as of': '~부로, 현재 기준으로',
    'aside from': '~을 제외하고',
    'along with': '~와 함께',
    'in light of': '~을 고려하여',
    'with regard to': '~에 관하여',
};
const KNOWN_TOEIC_TERMS = Object.freeze(Object.keys(TOEIC_HINTS));

const TOEIC_PROFILE_OVERRIDES = {
    'comply with': {
        partOfSpeech: 'phrase',
        meaningKo: '준수하다, 따르다',
        exampleEn: 'All employees must comply with the updated safety regulations before entering the warehouse.',
        exampleKo: '모든 직원은 창고에 들어가기 전에 개정된 안전 규정을 준수해야 합니다.',
        toeicTip: 'Part 5 함정: comply with + regulation/rule/policy. 유사표현은 adhere to, conform to, abide by이며 comply to는 오답으로 자주 나옵니다.',
    },
    'adhere to': {
        partOfSpeech: 'phrase',
        meaningKo: '준수하다, 고수하다',
        exampleEn: 'Suppliers are required to adhere to the delivery schedule stated in the contract.',
        exampleKo: '공급업체는 계약서에 명시된 납품 일정을 준수해야 합니다.',
        toeicTip: 'Part 5 함정: adhere to + schedule/guideline/policy. comply with와 의미는 유사하지만 전치사 패턴(adhere to)을 정확히 구분하는 문제가 자주 출제됩니다.',
    },
    'account for': {
        partOfSpeech: 'phrase',
        meaningKo: '설명하다, (비율을) 차지하다',
        exampleEn: 'Online orders now account for nearly 40 percent of the company\'s monthly sales.',
        exampleKo: '온라인 주문은 현재 회사 월간 매출의 거의 40%를 차지합니다.',
        toeicTip: 'Part 5 함정: account for는 explain/constitute 의미로 쓰입니다. account of와 혼동하거나 전치사를 바꾸는 오답이 자주 나옵니다.',
    },
    'result in': {
        partOfSpeech: 'phrase',
        meaningKo: '~을 초래하다',
        exampleEn: 'Any delay in customs clearance may result in additional storage charges.',
        exampleKo: '통관 지연이 발생하면 추가 보관료가 발생할 수 있습니다.',
        toeicTip: 'Part 5 함정: result in(결과를 낳다) vs result from(~에서 비롯되다) 방향 구분이 자주 출제됩니다.',
    },
    'result from': {
        partOfSpeech: 'phrase',
        meaningKo: '~에서 기인하다',
        exampleEn: 'The increase in returns resulted from unclear product descriptions on the website.',
        exampleKo: '반품 증가의 원인은 웹사이트의 불명확한 제품 설명에서 비롯되었습니다.',
        toeicTip: 'Part 5 함정: result from은 원인, result in은 결과를 나타냅니다. 전치사 방향을 바꾼 선택지가 자주 오답입니다.',
    },
    'contribute to': {
        partOfSpeech: 'phrase',
        meaningKo: '~에 기여하다',
        exampleEn: 'Regular customer feedback sessions contribute to higher service quality.',
        exampleKo: '정기적인 고객 피드백 세션은 서비스 품질 향상에 기여합니다.',
        toeicTip: 'Part 5 함정: contribute to + 명사(향상/성장/감소). contribute for 같은 비문 전치사 오답이 자주 나옵니다.',
    },
    'be responsible for': {
        partOfSpeech: 'phrase',
        meaningKo: '~을 책임지다',
        exampleEn: 'The finance manager is responsible for approving all travel expenses.',
        exampleKo: '재무 매니저는 모든 출장비 승인을 책임집니다.',
        toeicTip: 'Part 5 함정: responsible for + 명사. in charge of와 유사하지만 문장 구조에서 목적어 위치를 함께 확인해야 합니다.',
    },
    'be subject to': {
        partOfSpeech: 'phrase',
        meaningKo: '~의 적용을 받다',
        exampleEn: 'Late payments are subject to a 5 percent penalty under the contract terms.',
        exampleKo: '지연 납부는 계약 조건에 따라 5%의 벌금이 부과됩니다.',
        toeicTip: 'Part 5/7 함정: subject to는 규정/변동/승인 조건을 나타냅니다. 관련 콜로케이션(approval, change, penalty)로 자주 출제됩니다.',
    },
    'participate in': {
        partOfSpeech: 'phrase',
        meaningKo: '~에 참여하다',
        exampleEn: 'All interns are encouraged to participate in the quarterly training workshop.',
        exampleKo: '모든 인턴은 분기별 교육 워크숍에 참여하도록 권장됩니다.',
        toeicTip: 'Part 5 함정: participate in + 행사/프로그램. join과 의미가 비슷하지만 전치사 결합을 묻는 문제가 자주 나옵니다.',
    },
    'consist of': {
        partOfSpeech: 'phrase',
        meaningKo: '~로 구성되다',
        exampleEn: 'The final interview panel consists of three senior department heads.',
        exampleKo: '최종 면접 패널은 세 명의 고위 부서장으로 구성됩니다.',
        toeicTip: 'Part 5 함정: consist of는 수동태로 쓰지 않으며 be consisted of는 오답 패턴으로 자주 출제됩니다.',
    },
    'deal with': {
        partOfSpeech: 'phrase',
        meaningKo: '~을 처리하다, 다루다',
        exampleEn: 'The support team can deal with urgent billing issues within one business day.',
        exampleKo: '고객지원팀은 긴급한 청구 문제를 영업일 기준 하루 내에 처리할 수 있습니다.',
        toeicTip: 'Part 5 함정: deal with는 handle과 유사 의미로 자주 교체 출제됩니다. deal in(취급하다)과 의미 차이를 구분하세요.',
    },
    'apply for': {
        partOfSpeech: 'phrase',
        meaningKo: '~을 신청하다',
        exampleEn: 'Employees must apply for annual leave at least two weeks in advance.',
        exampleKo: '직원은 연차를 최소 2주 전에 신청해야 합니다.',
        toeicTip: 'Part 5 함정: apply for(신청) vs apply to(적용). 목적어가 직무/승인/허가인지 규정/사람인지로 구분하는 문제가 빈출됩니다.',
    },
    'apply to': {
        partOfSpeech: 'phrase',
        meaningKo: '~에 적용되다',
        exampleEn: 'The updated refund policy applies to all purchases made after March 1.',
        exampleKo: '개정된 환불 정책은 3월 1일 이후의 모든 구매에 적용됩니다.',
        toeicTip: 'Part 5 함정: apply to(적용) vs apply for(신청). 두 표현의 목적어 유형 차이를 문맥으로 구분해야 합니다.',
    },
    'in charge of': {
        partOfSpeech: 'phrase',
        meaningKo: '~을 담당하는',
        exampleEn: 'Ms. Park is in charge of vendor negotiations for the new project.',
        exampleKo: '박 매니저는 신규 프로젝트의 협력업체 협상을 담당하고 있습니다.',
        toeicTip: 'Part 5 함정: in charge of와 responsible for는 모두 책임 표현이지만, 지문에서 역할/권한 문맥으로 미세하게 구분됩니다.',
    },
    'rely on': {
        partOfSpeech: 'phrase',
        meaningKo: '~에 의존하다, 신뢰하다',
        exampleEn: 'Many small retailers rely on timely shipments to keep their inventory stable.',
        exampleKo: '많은 소규모 소매업체는 재고 안정을 위해 적시 배송에 의존합니다.',
        toeicTip: 'Part 5 함정: rely on + 명사. depend on과 유사하지만 동사 교체형 어휘 문제로 자주 출제됩니다.',
    },
    'attribute a to b': {
        partOfSpeech: 'phrase',
        meaningKo: 'A를 B의 원인으로 돌리다',
        exampleEn: 'Analysts attribute the drop in operating margin to rising logistics costs.',
        exampleKo: '분석가들은 영업이익률 하락의 원인을 물류비 상승으로 보고 있습니다.',
        toeicTip: 'Part 5 함정: attribute A to B 어순 고정. 수동태(be attributed to)와 능동태 어순을 섞은 보기로 자주 함정을 만듭니다.',
    },
    fragile: {
        partOfSpeech: 'adjective',
        meaningKo: '취약한, 깨지기 쉬운',
        exampleEn: 'Fragile items must be packed with additional cushioning before shipment.',
        exampleKo: '깨지기 쉬운 물품은 발송 전에 추가 완충재로 포장해야 합니다.',
        toeicTip: 'Part 5 함정: fragile은 broken(파손된)과 의미가 다릅니다. fragile item/package/shipment 콜로케이션이 자주 출제됩니다.',
    },
    prompt: {
        partOfSpeech: 'adjective',
        meaningKo: '신속한, 즉각적인',
        exampleEn: 'The customer appreciated the prompt response from the support team.',
        exampleKo: '고객은 고객지원팀의 신속한 대응을 높이 평가했습니다.',
        toeicTip: 'Part 5 함정: prompt(형용사) vs promptly(부사) 품사 구분 문제 빈출. prompt response/action 콜로케이션을 함께 암기하세요.',
    },
    'service agreement': {
        partOfSpeech: 'phrase',
        meaningKo: '서비스 계약',
        exampleEn: 'The service agreement must be renewed annually to maintain technical support.',
        exampleKo: '기술 지원을 유지하려면 서비스 계약을 매년 갱신해야 합니다.',
        toeicTip: 'Part 7 빈출 표현: service agreement는 contract terms, renewal date, support coverage와 함께 자주 등장합니다.',
    },
    persist: {
        partOfSpeech: 'verb',
        meaningKo: '지속하다, 계속하다',
        exampleEn: 'If the error persists, contact the IT help desk immediately.',
        exampleKo: '오류가 계속되면 즉시 IT 헬프데스크에 연락하세요.',
        toeicTip: 'Part 5 함정: persist는 자동사로 자주 쓰이며 persist in + N/V-ing 패턴이 빈출됩니다.',
    },
    'gain experience': {
        partOfSpeech: 'phrase',
        meaningKo: '경험을 쌓다',
        exampleEn: 'New employees can gain experience by rotating through different departments.',
        exampleKo: '신입 직원은 여러 부서를 순환하며 경험을 쌓을 수 있습니다.',
        toeicTip: 'Part 5 함정: gain experience는 고정 collocation으로 자주 출제됩니다. earn/obtain과의 문맥 차이를 함께 구분하세요.',
    },
    'reach a compromise': {
        partOfSpeech: 'phrase',
        meaningKo: '타협점에 이르다',
        exampleEn: 'The labor union and management finally reached a compromise on overtime pay.',
        exampleKo: '노동조합과 경영진은 초과근무 수당에 대해 결국 타협점에 도달했습니다.',
        toeicTip: 'Part 5/7 빈출: reach a compromise는 negotiation 문맥에서 자주 나오며 make a compromise와의 자연스러움 차이를 묻는 문제가 출제됩니다.',
    },
    'make an appointment': {
        partOfSpeech: 'phrase',
        meaningKo: '약속을 잡다',
        exampleEn: 'Please make an appointment with the HR manager before visiting the office.',
        exampleKo: '사무실 방문 전에 인사팀장과 약속을 잡아 주세요.',
        toeicTip: 'Part 5 함정: make an appointment with + 사람/부서 패턴이 자주 출제됩니다. reserve와의 의미 차이를 구분하세요.',
    },
    'take responsibility': {
        partOfSpeech: 'phrase',
        meaningKo: '책임을 지다',
        exampleEn: 'The project lead agreed to take responsibility for the delayed delivery.',
        exampleKo: '프로젝트 리더는 납품 지연에 대한 책임을 지기로 했습니다.',
        toeicTip: 'Part 5 함정: take responsibility for + 명사 구조가 빈출입니다. responsible for와 문장 형태 차이를 확인하세요.',
    },
    'meet the requirements': {
        partOfSpeech: 'phrase',
        meaningKo: '요구사항을 충족하다',
        exampleEn: 'Applicants must meet the requirements listed in the job posting.',
        exampleKo: '지원자는 채용 공고에 명시된 요구사항을 충족해야 합니다.',
        toeicTip: 'Part 7 빈출: meet the requirements는 채용/입찰 문맥에서 자주 등장합니다. satisfy requirements와의 치환형 문제가 자주 출제됩니다.',
    },
    'improve performance': {
        partOfSpeech: 'phrase',
        meaningKo: '성과를 향상시키다',
        exampleEn: 'The new training program helped the sales team improve performance.',
        exampleKo: '새 교육 프로그램은 영업팀의 성과 향상에 도움이 되었습니다.',
        toeicTip: 'Part 5/7 빈출: improve performance는 sales/productivity와 함께 자주 쓰입니다. raise/increase와의 뉘앙스 차이를 구분하세요.',
    },
    'establish a partnership': {
        partOfSpeech: 'phrase',
        meaningKo: '파트너십을 맺다',
        exampleEn: 'The startup plans to establish a partnership with a local distributor.',
        exampleKo: '해당 스타트업은 현지 유통업체와 파트너십을 구축할 계획입니다.',
        toeicTip: 'Part 7 빈출: establish a partnership with + 기관 패턴이 계약/협업 지문에서 자주 출제됩니다.',
    },
    'face challenges': {
        partOfSpeech: 'phrase',
        meaningKo: '도전에 직면하다',
        exampleEn: 'Small suppliers often face challenges when shipping costs rise suddenly.',
        exampleKo: '소규모 공급업체는 배송비가 급등할 때 종종 어려움에 직면합니다.',
        toeicTip: 'Part 5 함정: face challenges는 encounter difficulties와 의미가 유사한 교체형 어휘 문제로 자주 출제됩니다.',
    },
    'conduct a survey': {
        partOfSpeech: 'phrase',
        meaningKo: '설문조사를 실시하다',
        exampleEn: 'The marketing team will conduct a survey to measure customer satisfaction.',
        exampleKo: '마케팅팀은 고객 만족도를 측정하기 위해 설문조사를 실시할 예정입니다.',
        toeicTip: 'Part 5/7 빈출: conduct a survey는 carry out a survey와 함께 치환형으로 자주 출제됩니다.',
    },
    'increase sales': {
        partOfSpeech: 'phrase',
        meaningKo: '매출을 늘리다',
        exampleEn: 'The campaign was designed to increase sales in the online channel.',
        exampleKo: '해당 캠페인은 온라인 채널의 매출을 늘리기 위해 설계되었습니다.',
        toeicTip: 'Part 5 함정: increase sales는 동사-목적어 collocation으로 자주 출제됩니다. rise sales 같은 비문 선택지를 주의하세요.',
    },
    'develop skills': {
        partOfSpeech: 'phrase',
        meaningKo: '기술을 개발하다',
        exampleEn: 'Employees can develop skills through the company’s mentoring program.',
        exampleKo: '직원은 회사 멘토링 프로그램을 통해 역량을 개발할 수 있습니다.',
        toeicTip: 'Part 7 빈출: develop skills는 training/workshop 문맥과 함께 자주 등장하며 build skills와의 유사표현 구분이 출제됩니다.',
    },
    'meet a deadline': {
        partOfSpeech: 'phrase',
        meaningKo: '마감일을 지키다',
        exampleEn: 'We need two additional designers to meet the deadline for the launch.',
        exampleKo: '출시 마감일을 맞추기 위해 디자이너 두 명이 추가로 필요합니다.',
        toeicTip: 'Part 5 빈출: meet a deadline은 프로젝트 관리 문맥의 핵심 collocation입니다. miss a deadline과 반의 관계로 함께 출제됩니다.',
    },
    'solve a problem': {
        partOfSpeech: 'phrase',
        meaningKo: '문제를 해결하다',
        exampleEn: 'The technician solved the problem by replacing the faulty router.',
        exampleKo: '기술자는 결함이 있는 라우터를 교체하여 문제를 해결했습니다.',
        toeicTip: 'Part 5 함정: solve a problem은 fix an issue와 유사한 표현 치환형으로 자주 출제됩니다.',
    },
    'provide assistance': {
        partOfSpeech: 'phrase',
        meaningKo: '도움을 제공하다',
        exampleEn: 'Our support desk provides assistance to users 24 hours a day.',
        exampleKo: '우리 지원 데스크는 사용자에게 24시간 도움을 제공합니다.',
        toeicTip: 'Part 7 빈출: provide assistance to + 대상 패턴이 공지/안내문에서 자주 등장합니다.',
    },
    'establish a connection': {
        partOfSpeech: 'phrase',
        meaningKo: '연결을 구축하다',
        exampleEn: 'The app could not establish a connection to the secure payment server.',
        exampleKo: '앱이 보안 결제 서버와 연결을 구축하지 못했습니다.',
        toeicTip: 'Part 5/7 빈출: establish a connection to + 시스템 패턴이 IT/네트워크 지문에서 자주 출제됩니다.',
    },
    'on account of': {
        partOfSpeech: 'phrase',
        meaningKo: '~때문에',
        exampleEn: 'Several flights were canceled on account of severe weather conditions.',
        exampleKo: '악천후 때문에 여러 항공편이 취소되었습니다.',
        toeicTip: 'Part 5 함정: on account of는 because of와 유사한 전치사구입니다. because + 절과의 문장 구조 차이를 구분하세요.',
    },
    'thanks to': {
        partOfSpeech: 'phrase',
        meaningKo: '~덕분에',
        exampleEn: 'Thanks to the new inventory system, order errors dropped significantly.',
        exampleKo: '새 재고 시스템 덕분에 주문 오류가 크게 감소했습니다.',
        toeicTip: 'Part 5 함정: thanks to는 긍정 결과 문맥에서 자주 쓰이며 due to와 뉘앙스 차이를 묻는 문제가 출제됩니다.',
    },
    'such as': {
        partOfSpeech: 'phrase',
        meaningKo: '예를 들어',
        exampleEn: 'Benefits such as flexible hours and meal vouchers improved retention.',
        exampleKo: '유연근무제와 식대 바우처 같은 복지 혜택이 직원 유지율을 높였습니다.',
        toeicTip: 'Part 5 함정: such as는 예시 제시 표현입니다. and so on/including과의 구문 차이를 확인하세요.',
    },
    'as per': {
        partOfSpeech: 'phrase',
        meaningKo: '~에 따라',
        exampleEn: 'As per the contract, payment must be completed within 30 days.',
        exampleKo: '계약에 따라 대금은 30일 이내에 지급되어야 합니다.',
        toeicTip: 'Part 5/7 빈출: as per + 문서/규정 패턴이 계약 문맥에서 자주 출제됩니다.',
    },
    'other than': {
        partOfSpeech: 'phrase',
        meaningKo: '~을 제외하고',
        exampleEn: 'No expenses other than travel costs will be reimbursed.',
        exampleKo: '출장비를 제외한 비용은 상환되지 않습니다.',
        toeicTip: 'Part 5 함정: other than은 except for와 유사 표현입니다. 부정문/제한문에서의 용법을 구분하세요.',
    },
    'in spite of': {
        partOfSpeech: 'phrase',
        meaningKo: '~에도 불구하고',
        exampleEn: 'In spite of the delay, the vendor met the final delivery deadline.',
        exampleKo: '지연에도 불구하고 공급업체는 최종 납기일을 지켰습니다.',
        toeicTip: 'Part 5 함정: in spite of는 despite와 동의어입니다. 접속사 though와 품사 차이를 구분하세요.',
    },
    'as of': {
        partOfSpeech: 'phrase',
        meaningKo: '~부로, 현재 기준으로',
        exampleEn: 'As of next Monday, all invoices must be submitted electronically.',
        exampleKo: '다음 주 월요일부로 모든 청구서는 전자 방식으로 제출해야 합니다.',
        toeicTip: 'Part 7 빈출: as of + 날짜 패턴이 공지/규정 변경 지문에서 자주 등장합니다.',
    },
    'aside from': {
        partOfSpeech: 'phrase',
        meaningKo: '~을 제외하고',
        exampleEn: 'Aside from minor formatting issues, the proposal was approved.',
        exampleKo: '사소한 서식 문제를 제외하면 해당 제안서는 승인되었습니다.',
        toeicTip: 'Part 5 함정: aside from은 except for/besides와 유사합니다. 문맥상 제외/추가 의미를 구분하세요.',
    },
    'along with': {
        partOfSpeech: 'phrase',
        meaningKo: '~와 함께',
        exampleEn: 'The report, along with the supporting documents, was sent to the client.',
        exampleKo: '보고서는 보조 문서와 함께 고객에게 발송되었습니다.',
        toeicTip: 'Part 5 함정: along with 구문은 수일치 함정으로 자주 출제됩니다. 진짜 주어와 동사를 일치시키세요.',
    },
    'in light of': {
        partOfSpeech: 'phrase',
        meaningKo: '~을 고려하여',
        exampleEn: 'In light of recent demand changes, we adjusted the production schedule.',
        exampleKo: '최근 수요 변화를 고려하여 생산 일정을 조정했습니다.',
        toeicTip: 'Part 7 빈출: in light of는 의사결정/공지 문맥에서 자주 등장하며 considering과의 치환 문제가 출제됩니다.',
    },
    'with regard to': {
        partOfSpeech: 'phrase',
        meaningKo: '~에 관하여',
        exampleEn: 'With regard to your inquiry, the billing team will reply by Friday.',
        exampleKo: '귀하의 문의와 관련해 청구팀이 금요일까지 회신할 예정입니다.',
        toeicTip: 'Part 5/7 빈출: with regard to는 공식 메일 표현으로 자주 등장하며 regarding/concerning과의 치환형 문제가 출제됩니다.',
    },
};

function getToeicProfile(word) {
    return TOEIC_PROFILE_OVERRIDES[normalizeWordToken(word)] || null;
}

function normalizeQualityPolicy(input = {}) {
    const threshold = Number(input.qualityThreshold);
    const modeRaw = String(input.llmFallbackMode || DEFAULT_POLICY.llmFallbackMode).trim().toLowerCase();
    return {
        enableHybridFallback: input.enableHybridFallback !== false,
        qualityThreshold: Number.isFinite(threshold) ? Math.max(0, Math.min(1, threshold)) : DEFAULT_POLICY.qualityThreshold,
        tipStyle: String(input.tipStyle || DEFAULT_POLICY.tipStyle),
        llmFallbackMode: ALLOWED_LLM_FALLBACK_MODES.has(modeRaw) ? modeRaw : DEFAULT_POLICY.llmFallbackMode,
    };
}

function normalizeWordToken(rawWord) {
    return String(rawWord || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function fallbackMeaning(word) {
    return TOEIC_HINTS[normalizeWordToken(word)] || null;
}

function fallbackExample(word) {
    const w = String(word || '').trim();
    return `The manager emphasized ${w} during the team meeting.`;
}

function buildWordCandidates(word) {
    const raw = String(word || '').trim().toLowerCase();
    if (!raw) return [];
    const out = [raw];
    if (!/^[a-z][a-z-']{1,80}$/.test(raw)) return [...new Set(out)];
    if (raw.endsWith('ies') && raw.length > 4) out.push(`${raw.slice(0, -3)}y`);
    if (raw.endsWith('ied') && raw.length > 4) out.push(`${raw.slice(0, -3)}y`);
    if (raw.endsWith('es') && raw.length > 3) out.push(raw.slice(0, -2));
    if (raw.endsWith('s') && raw.length > 3) out.push(raw.slice(0, -1));
    if (raw.endsWith('ing') && raw.length > 5) {
        const stem = raw.slice(0, -3);
        out.push(stem, `${stem}e`);
    }
    if (raw.endsWith('ed') && raw.length > 4) {
        const stem = raw.slice(0, -2);
        out.push(stem, `${stem}e`);
        if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
            out.push(stem.slice(0, -1));
        }
    }
    return [...new Set(out)];
}

function httpGet(url, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                resolve({ statusCode: Number(res.statusCode || 0), body });
            });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

async function httpGetJson(url, timeoutMs = 8000) {
    const out = await httpGet(url, timeoutMs);
    if (out.statusCode < 200 || out.statusCode >= 300) {
        throw new Error(`HTTP ${out.statusCode}`);
    }
    return JSON.parse(out.body);
}

function chooseBestDefinition(entry) {
    const preferred = ['verb', 'noun', 'adjective', 'adverb'];
    const meanings = Array.isArray(entry.meanings) ? entry.meanings : [];
    const sorted = [...meanings].sort((a, b) => {
        const ia = preferred.indexOf(String(a.partOfSpeech || '').toLowerCase());
        const ib = preferred.indexOf(String(b.partOfSpeech || '').toLowerCase());
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    for (const m of sorted) {
        const defs = Array.isArray(m.definitions) ? m.definitions : [];
        if (!defs.length) continue;
        const d = defs[0];
        return {
            partOfSpeech: String(m.partOfSpeech || '').trim().toLowerCase(),
            meaningEn: String(d.definition || '').trim(),
            exampleEn: String(d.example || '').trim(),
        };
    }
    return null;
}

function normalizeText(value, maxLen = 220) {
    const out = String(value || '').replace(/\s+/g, ' ').trim();
    return out.length > maxLen ? `${out.slice(0, maxLen - 3)}...` : out;
}

function normalizeLemma(word, lemma) {
    const base = normalizeWordToken(lemma || word);
    return base || normalizeWordToken(word);
}

function inferPartOfSpeech(word) {
    const w = normalizeWordToken(word);
    if (w.includes(' ')) return 'phrase';
    if (w.endsWith('ly')) return 'adverb';
    if (w.endsWith('tion') || w.endsWith('ment') || w.endsWith('ness')) return 'noun';
    if (w.endsWith('ive') || w.endsWith('al') || w.endsWith('able') || w.endsWith('ous')) return 'adjective';
    return 'verb';
}

function isToeicContextSentence(text) {
    return TOEIC_CONTEXT_RE.test(String(text || '').trim());
}

function exampleMentionsWord(example, word) {
    const ex = String(example || '').toLowerCase();
    const normalized = normalizeWordToken(word);
    if (!ex || !normalized) return false;
    if (ex.includes(normalized)) return true;
    const candidates = buildWordCandidates(normalized);
    for (const c of candidates) {
        if (c && ex.includes(c)) return true;
    }
    return false;
}

function scoreMeaningCandidate(text) {
    const t = normalizeText(text, 220);
    if (!t) return -999;
    let score = 0;
    if (hasKorean(t)) score += 4;
    const len = t.length;
    if (len <= 4) score += 2;
    else if (len <= 14) score += 4;
    else if (len <= 24) score += 3;
    else if (len <= 36) score += 1;
    else score -= 1;
    if (/다\.$/.test(t)) score -= 1;
    if (/[.!?]/.test(t)) score -= 1;
    if (/경우|것|의미|하는|하는 것/.test(t)) score -= 1;
    return score;
}

function chooseMeaningCandidate(candidates = []) {
    let best = '';
    let bestScore = -999;
    for (const c of candidates) {
        const normalized = normalizeText(c, 220);
        const score = scoreMeaningCandidate(normalized);
        if (score > bestScore) {
            best = normalized;
            bestScore = score;
        }
    }
    return best;
}

function buildExampleFromWord(word, partOfSpeech) {
    const w = String(word || '').trim();
    if (!w) return fallbackExample('this term');
    const profile = getToeicProfile(w);
    if (profile && profile.exampleEn) return profile.exampleEn;
    const isPhrase = /\s/.test(w);
    const lower = normalizeWordToken(w);
    const phraseVerbStarters = new Set([
        'gain', 'reach', 'make', 'take', 'meet', 'improve', 'establish', 'face', 'conduct', 'increase',
        'develop', 'solve', 'provide', 'reduce', 'submit', 'review', 'approve', 'comply', 'adhere', 'result',
        'participate', 'apply', 'rely', 'attribute', 'deal',
    ]);
    const tokenHash = normalizeWordToken(lower).split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const pick = (arr) => arr[Math.abs(tokenHash) % arr.length];
    if (isPhrase) {
        const first = lower.split(' ')[0] || '';
        if (phraseVerbStarters.has(first)) {
            return pick([
                `During the audit, every department had to ${lower} the updated policy immediately.`,
                `The project team agreed to ${lower} the client's revised requirements this month.`,
                `Managers are expected to ${lower} contract terms before approving the shipment.`,
            ]);
        }
        return pick([
            `The phrase "${w}" appeared repeatedly in the supplier contract review meeting.`,
            `Our legal team highlighted "${w}" as a key expression in the renewal notice.`,
            `The training guide explains how to use "${w}" in business email responses.`,
        ]);
    }
    if (partOfSpeech === 'noun') {
        return pick([
            `The manager discussed the ${w} during the quarterly budget meeting.`,
            `Our team launched a new ${w} to improve customer retention this quarter.`,
            `The board approved the ${w} after reviewing the cost and timeline.`,
        ]);
    }
    if (partOfSpeech === 'adjective') {
        return pick([
            `A ${w} delivery schedule helped the client finish the rollout on time.`,
            `The supervisor requested a more ${w} response to urgent customer emails.`,
            `The vendor provided a ${w} estimate for the maintenance project.`,
        ]);
    }
    if (partOfSpeech === 'adverb') {
        return pick([
            `The vendor responded ${w} after receiving the revised purchase order.`,
            `The report was ${w} reviewed before submission to the finance team.`,
            `Customer complaints were ${w} addressed by the support desk.`,
        ]);
    }
    return pick([
        `The operations team will ${w} the issue before the next service review.`,
        `Please ${w} the updated request before tomorrow's client meeting.`,
        `The department plans to ${w} the process to reduce shipping delays.`,
    ]);
}

function buildToeicTip({ word, partOfSpeech, tipStyle = 'part-focused' }) {
    const w = String(word || '').trim();
    const pos = String(partOfSpeech || '').toLowerCase();
    const norm = normalizeWordToken(w);
    const treatAsPhrase = pos === 'phrase' || norm.includes(' ');
    const profile = getToeicProfile(w);
    if (profile && profile.toeicTip) return profile.toeicTip;
    if (tipStyle !== 'part-focused') {
        return `Part 5/7 함정: ${w}는 비즈니스 문맥에서 자주 쓰여 유사어/전치사 바꿔치기 오답이 자주 나옵니다. 핵심 collocation과 함께 암기하세요.`;
    }
    if (pos === 'verb') {
        return `Part 5 함정: ${w}는 동사 자리(시제/태)와 전치사 결합을 함께 묻는 형태로 자주 출제됩니다. ${w} + 목적어 collocation과 유사 동사와의 뉘앙스 차이를 같이 암기하세요.`;
    }
    if (pos === 'noun') {
        return `Part 5/7 함정: ${w}는 명사 collocation과 수일치 문제로 자주 출제됩니다. ${w}와 함께 오는 전치사(in/of/for)와 동사 매칭 패턴을 같이 확인하세요.`;
    }
    if (pos === 'adjective') {
        return `Part 5 함정: ${w}는 형용사/부사 품사 구분과 수식 대상(사람/사물) 구분 문제로 자주 출제됩니다. 유사 형용사와 의미 차이를 함께 정리하세요.`;
    }
    if (pos === 'adverb') {
        return `Part 5 함정: ${w}는 부사 위치(동사 앞/뒤, 문두)와 형용사형과의 혼동을 묻는 문제가 빈출됩니다. 자주 함께 쓰이는 동사 collocation을 같이 암기하세요.`;
    }
    if (treatAsPhrase) {
        const m = norm.match(/\b(with|to|for|in|on|of|by|from)$/);
        if (m) {
            return `Part 5 함정: ${norm}의 전치사 결합(${m[1]})은 고정형으로 자주 출제됩니다. 비슷한 표현과 전치사 바꿔치기 오답을 주의하세요.`;
        }
        return `Part 5 함정: ${norm}는 구문 단위 collocation으로 자주 출제됩니다. 유사 표현 치환/어순 바꿔치기 오답을 함께 확인하세요.`;
    }
    return 'Part 5/6에서 문장 연결과 어휘 선택 문제에 대비해 예문 단위로 암기하세요.';
}

function parseTranslationResponse(payload) {
    if (!Array.isArray(payload) || !Array.isArray(payload[0])) return '';
    return payload[0]
        .map((row) => Array.isArray(row) ? String(row[0] || '') : '')
        .join('')
        .trim();
}

async function translateEnToKo(text) {
    const normalized = normalizeText(text, 500);
    if (!normalized) return '';
    if (TRANSLATION_CACHE.has(normalized)) return TRANSLATION_CACHE.get(normalized);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=${encodeURIComponent(normalized)}`;
    try {
        const data = await httpGetJson(url, 7000);
        const translated = normalizeText(parseTranslationResponse(data), 500);
        if (translated) TRANSLATION_CACHE.set(normalized, translated);
        return translated;
    } catch {
        return '';
    }
}

function extractJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (_) {}
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) {
        try {
            return JSON.parse(fenced[1]);
        } catch (_) {}
    }
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            return JSON.parse(raw.slice(start, end + 1));
        } catch (_) {}
    }
    return null;
}

function parseContainerCandidates(raw) {
    const value = String(raw || '').trim();
    if (!value) return [...DEFAULT_LLM_CONTAINERS];
    const parsed = value
        .split(',')
        .map((v) => String(v || '').trim())
        .filter(Boolean);
    return parsed.length > 0 ? parsed : [...DEFAULT_LLM_CONTAINERS];
}

function parseAgentPayload(rawStdout) {
    const parsed = JSON.parse(String(rawStdout || '{}'));
    const payloads = (((parsed || {}).result || {}).payloads || []);
    const text = payloads[0] ? String(payloads[0].text || '') : '';
    const json = extractJsonObject(text);
    if (!json) throw new Error('llm_json_parse_failed');
    return json;
}

function callOpenClawAgent(prompt, thinking = DEFAULT_LLM_THINKING, options = {}) {
    const baseSessionId = `anki-quality-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const level = String(thinking || DEFAULT_LLM_THINKING).trim().toLowerCase() || DEFAULT_LLM_THINKING;
    const preferredAgent = String(options.agentId || '').trim();
    const containerCandidates = parseContainerCandidates(options.containers);
    const timeoutMs = Number(options.timeoutMs || process.env.ANKI_WORD_QUALITY_TIMEOUT_MS || 75000);
    const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 75000;
    const agentCandidates = [...new Set([
        preferredAgent || null,
        preferredAgent && preferredAgent !== 'main' ? 'main' : null,
        null,
    ])];
    const errors = [];
    const runAttempt = (label, cmd, args, spawnOptions = {}) => {
        const res = spawnSync(cmd, args, {
            encoding: 'utf8',
            maxBuffer: 12 * 1024 * 1024,
            timeout: safeTimeoutMs,
            ...spawnOptions,
        });
        if (res.error || res.status !== 0) {
            const detail = String(res.stderr || res.error || res.stdout || '').trim();
            errors.push(`${label}:${detail || 'openclaw_agent_failed'}`);
            return null;
        }
        try {
            return parseAgentPayload(res.stdout);
        } catch (error) {
            errors.push(`${label}:${String(error && error.message ? error.message : error)}`);
            return null;
        }
    };

    // First try local OpenClaw invocation. This is required when bridge runs inside a container,
    // where nested docker exec often drops JSON output.
    const localEntrypoints = [];
    if (fs.existsSync('/app/dist/index.js')) {
        localEntrypoints.push({
            label: 'local:/app/dist/index.js',
            cmd: 'node',
            baseArgs: ['/app/dist/index.js'],
            cwd: undefined,
        });
        localEntrypoints.push({
            label: 'local:cwd=/app',
            cmd: 'node',
            baseArgs: ['dist/index.js'],
            cwd: '/app',
        });
    }
    localEntrypoints.push({
        label: 'local:openclaw',
        cmd: 'openclaw',
        baseArgs: [],
        cwd: undefined,
    });

    for (const entry of localEntrypoints) {
        for (const agentId of agentCandidates) {
            const sessionId = `${baseSessionId}-local-${agentId || 'default'}`;
            const args = [
                ...entry.baseArgs,
                'agent',
                '--session-id',
                sessionId,
                '--message',
                prompt,
                '--thinking',
                level,
            ];
            if (agentId) {
                args.push('--agent', agentId);
            }
            args.push('--json');
            const out = runAttempt(
                `${entry.label}:${agentId || 'default'}`,
                entry.cmd,
                args,
                entry.cwd ? { cwd: entry.cwd } : {},
            );
            if (out) return out;
        }
    }

    // Fallback to docker exec from host context.
    for (const container of containerCandidates) {
        for (const agentId of agentCandidates) {
            const sessionId = `${baseSessionId}-${container}-${agentId || 'default'}`;
            const args = [
                'exec',
                container,
                'node',
                'dist/index.js',
                'agent',
                '--session-id',
                sessionId,
                '--message',
                prompt,
                '--thinking',
                level,
            ];
            if (agentId) {
                args.push('--agent', agentId);
            }
            args.push('--json');
            const out = runAttempt(
                `${container}:${agentId || 'default'}`,
                'docker',
                args,
            );
            if (out) return out;
        }
    }

    throw new Error(errors.length > 0 ? errors.join(' | ') : 'openclaw_agent_failed');
}

function buildLlmPrompt({ word, hint, localCandidate }) {
    const local = {
        meaningKo: localCandidate.meaningKo,
        exampleEn: localCandidate.exampleEn,
        exampleKo: localCandidate.exampleKo,
        toeicTip: localCandidate.toeicTip,
        partOfSpeech: localCandidate.partOfSpeech,
    };
    return [
        'You are generating a TOEIC vocabulary card in Korean.',
        'Return JSON only with keys: partOfSpeech, meaningKo, exampleEn, exampleKo, toeicTip.',
        'Constraints:',
        '- Use concise Korean for meaningKo.',
        '- exampleEn must be one natural business/TOEIC sentence, not a generic template.',
        '- exampleKo must be a faithful Korean translation of exampleEn.',
        '- toeicTip must mention one realistic TOEIC part and one concrete trap point.',
        '- Avoid placeholders such as "관련 예문입니다".',
        '',
        `word: ${word}`,
        `hint: ${hint || '-'}`,
        `localCandidate: ${JSON.stringify(local)}`,
    ].join('\n');
}

function buildTypoCorrectionPrompt({ token, targetWord, suggestions, fallback }) {
    const rows = Array.isArray(suggestions) ? suggestions : [];
    return [
        'You are correcting a likely typo for a TOEIC vocabulary flashcard.',
        'Return JSON only with keys: word, confidence, reason.',
        'Constraints:',
        '- "word" must be lowercase English (word or short phrase) suitable for TOEIC business context.',
        '- Prefer the closest intended word from suggestions when valid.',
        '- Do not output Korean.',
        '',
        `inputToken: ${String(token || '').trim() || '-'}`,
        `normalizedInput: ${String(targetWord || '').trim() || '-'}`,
        `suggestions: ${rows.length > 0 ? rows.join(', ') : '-'}`,
        `fallback: ${String(fallback || '').trim() || '-'}`,
    ].join('\n');
}

function isWordLikeCandidate(value) {
    const text = normalizeWordToken(value);
    if (!text) return false;
    if (text.length > 90) return false;
    return /^[a-z][a-z\-'\s]*$/.test(text);
}

function normalizeCorrectionSuggestions(values) {
    const out = [];
    const seen = new Set();
    for (const row of (Array.isArray(values) ? values : [])) {
        const word = normalizeWordToken(row);
        if (!word || !isWordLikeCandidate(word)) continue;
        if (seen.has(word)) continue;
        seen.add(word);
        out.push(word);
    }
    return out;
}

function hasKorean(text) {
    return /[가-힣]/.test(String(text || ''));
}

function isGenericTemplateExample(exampleEn) {
    const normalized = normalizeText(exampleEn, 300);
    if (!normalized) return false;
    return GENERIC_EXAMPLE_TEMPLATE_RE.some((re) => re.test(normalized));
}

function isPlaceholderKoreanExample(exampleKo) {
    return KOREAN_PLACEHOLDER_EXAMPLE_RE.test(normalizeText(exampleKo, 220));
}

function evaluateQuality(candidate, threshold, word = '') {
    const warnings = [];
    const meaningKo = normalizeText(candidate.meaningKo);
    const exampleEn = normalizeText(candidate.exampleEn);
    const exampleKo = normalizeText(candidate.exampleKo);
    const toeicTip = normalizeText(candidate.toeicTip);
    const partOfSpeech = normalizeText(candidate.partOfSpeech, 30).toLowerCase();
    const targetWord = normalizeWordToken(word || candidate.lemma || '');
    const placeholderMeaning = /\(의미 보강 필요\)/.test(meaningKo);

    let score = 0;
    if (meaningKo) score += 0.25;
    else warnings.push('missing_meaning_ko');
    if (exampleEn) score += 0.25;
    else warnings.push('missing_example_en');
    if (exampleKo) score += 0.25;
    else warnings.push('missing_example_ko');
    if (toeicTip) score += 0.25;
    else warnings.push('missing_toeic_tip');

    if (!hasKorean(meaningKo)) warnings.push('meaning_not_korean');
    else score += 0.05;
    if (!hasKorean(exampleKo)) warnings.push('translation_not_korean');
    else score += 0.05;
    if (!/(Part|파트|품사|전치사|수일치|문법)/i.test(toeicTip)) warnings.push('tip_not_specific');
    else score += 0.05;
    if (targetWord && !exampleEn.toLowerCase().includes(targetWord)) warnings.push('example_missing_target');
    else if (targetWord) score += 0.05;
    if (!TOEIC_CONTEXT_RE.test(exampleEn)) warnings.push('example_not_toeic_context');
    else score += 0.05;
    if (!TOEIC_TIP_DETAIL_RE.test(toeicTip)) warnings.push('tip_lacks_detail');
    else score += 0.05;
    if (isGenericTemplateExample(exampleEn)) warnings.push('example_generic_template');
    if (isPlaceholderKoreanExample(exampleKo)) warnings.push('example_ko_placeholder');
    if (placeholderMeaning) warnings.push('placeholder_meaning');

    const normalizedScore = Math.max(0, Math.min(1, score));
    const hardFail = !meaningKo || !exampleEn || !exampleKo || !toeicTip || placeholderMeaning;
    return {
        ok: !hardFail && normalizedScore >= threshold && warnings.length < 4,
        hardFail,
        score: Number(normalizedScore.toFixed(2)),
        warnings,
        normalized: {
            partOfSpeech,
            meaningKo,
            exampleEn,
            exampleKo,
            toeicTip,
        },
    };
}

async function buildLocalQuality(word, hint, policy) {
    const normalizedWord = String(word || '').trim().replace(/\s+/g, ' ');
    const profile = getToeicProfile(normalizedWord);
    const warnings = [];
    const candidates = buildWordCandidates(normalizedWord);
    const fallback = {
        lemma: normalizeLemma(normalizedWord, normalizedWord),
        partOfSpeech: normalizeText((profile && profile.partOfSpeech) || inferPartOfSpeech(normalizedWord), 30).toLowerCase(),
        meaningKo: normalizeText(hint || (profile && profile.meaningKo) || fallbackMeaning(normalizedWord) || ''),
        exampleEn: '',
        exampleKo: '',
        toeicTip: '',
    };

    let best = null;
    const skipDictionary = Boolean(hint) || Boolean(profile && profile.meaningKo && profile.exampleEn);
    if (!skipDictionary) {
        for (const c of candidates) {
            try {
                const data = await httpGetJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(c)}`, 7000);
                const first = Array.isArray(data) ? data[0] : null;
                const chosen = first ? chooseBestDefinition(first) : null;
                if (!chosen) continue;
                best = {
                    lemma: normalizeLemma(normalizedWord, c),
                    partOfSpeech: chosen.partOfSpeech || inferPartOfSpeech(normalizedWord),
                    meaningEn: normalizeText(chosen.meaningEn, 240),
                    exampleEn: normalizeText(chosen.exampleEn, 240),
                };
                break;
            } catch (_) {
                // try next candidate
            }
        }
    }

    if (!fallback.meaningKo) {
        const known = fallbackMeaning(normalizedWord);
        if (known) fallback.meaningKo = known;
    }

    const meaningCandidates = [];
    if (fallback.meaningKo) meaningCandidates.push(fallback.meaningKo);
    if (!fallback.meaningKo && best && best.meaningEn) {
        const translatedMeaning = await translateEnToKo(best.meaningEn);
        if (translatedMeaning) meaningCandidates.push(translatedMeaning);
        else warnings.push('meaning_translation_failed');
    }
    const translatedWord = await translateEnToKo(normalizedWord);
    if (translatedWord) meaningCandidates.push(translatedWord);
    else warnings.push('word_translation_failed');
    if (!hasKorean(chooseMeaningCandidate(meaningCandidates)) && best && best.meaningEn) {
        meaningCandidates.push(best.meaningEn);
    }
    let meaningKo = chooseMeaningCandidate(meaningCandidates);
    if (!meaningKo) {
        meaningKo = '(의미 보강 필요)';
        warnings.push('meaning_missing');
    }

    const partOfSpeech = best && best.partOfSpeech ? best.partOfSpeech : fallback.partOfSpeech;
    const generatedExample = buildExampleFromWord(best ? best.lemma : normalizedWord, partOfSpeech);
    const dictionaryExample = best && best.exampleEn ? best.exampleEn : '';
    const useDictionaryExample = Boolean(dictionaryExample)
        && exampleMentionsWord(dictionaryExample, normalizedWord)
        && isToeicContextSentence(dictionaryExample);
    const exampleEn = normalizeText((profile && profile.exampleEn) || (useDictionaryExample ? dictionaryExample : generatedExample), 240);
    if (!profile && !useDictionaryExample && isGenericTemplateExample(exampleEn)) warnings.push('example_generic_template');
    let exampleKo = normalizeText((profile && profile.exampleKo) || '', 240);
    if (!exampleKo) exampleKo = await translateEnToKo(exampleEn);
    if (!exampleKo) {
        warnings.push('example_translation_failed');
        exampleKo = `${normalizeText(normalizedWord, 80)} 관련 예문입니다.`;
    }

    const toeicTip = buildToeicTip({ word: normalizedWord, partOfSpeech, tipStyle: policy.tipStyle });
    const localCandidate = {
        lemma: best ? best.lemma : fallback.lemma,
        partOfSpeech,
        meaningKo,
        exampleEn,
        exampleKo,
        toeicTip,
        confidence: 0.72,
        sourceMode: 'local',
        warnings,
        degraded: false,
    };
    const evalResult = evaluateQuality(localCandidate, policy.qualityThreshold, normalizedWord);
    return {
        candidate: {
            ...localCandidate,
            partOfSpeech: evalResult.normalized.partOfSpeech || localCandidate.partOfSpeech,
            meaningKo: evalResult.normalized.meaningKo || localCandidate.meaningKo,
            exampleEn: evalResult.normalized.exampleEn || localCandidate.exampleEn,
            exampleKo: evalResult.normalized.exampleKo || localCandidate.exampleKo,
            toeicTip: evalResult.normalized.toeicTip || localCandidate.toeicTip,
            confidence: evalResult.score,
            warnings: [...new Set([...(localCandidate.warnings || []), ...(evalResult.warnings || [])])],
        },
        evaluation: evalResult,
    };
}

function normalizeLlmCandidate(word, base, raw) {
    const out = raw || {};
    return {
        lemma: normalizeLemma(word, base.lemma || word),
        partOfSpeech: normalizeText(out.partOfSpeech || base.partOfSpeech, 30).toLowerCase() || 'phrase',
        meaningKo: normalizeText(out.meaningKo || base.meaningKo, 220),
        exampleEn: normalizeText(out.exampleEn || base.exampleEn, 240),
        exampleKo: normalizeText(out.exampleKo || base.exampleKo, 240),
        toeicTip: normalizeText(out.toeicTip || base.toeicTip, 240),
        sourceMode: 'llm_fallback',
        confidence: 0.86,
        warnings: [],
        degraded: false,
    };
}

async function runLlmFallback(word, hint, localCandidate, options = {}) {
    if (String(process.env.RATE_LIMIT_SAFE_MODE || '').toLowerCase() === 'true') {
        throw new Error('rate_limit_safe_mode');
    }
    const llmThinking = String(options.llmThinking || process.env.ANKI_WORD_QUALITY_THINKING || DEFAULT_LLM_THINKING)
        .trim()
        .toLowerCase() || DEFAULT_LLM_THINKING;
    const llmAgentId = String(options.llmAgentId || process.env.ANKI_WORD_QUALITY_AGENT || DEFAULT_LLM_AGENT).trim();
    const llmContainers = String(options.llmContainers || process.env.ANKI_WORD_QUALITY_CONTAINERS || '').trim();
    const llmFallbackFn = options.llmFallbackFn || (async (ctx) => {
        const prompt = buildLlmPrompt(ctx);
        return callOpenClawAgent(prompt, llmThinking, {
            agentId: llmAgentId,
            containers: llmContainers,
        });
    });
    const raw = await llmFallbackFn({ word, hint, localCandidate });
    return normalizeLlmCandidate(word, localCandidate, raw);
}

async function suggestToeicTypoCorrection(input = {}, options = {}) {
    const token = String(input.token || '').trim();
    const targetWord = normalizeWordToken(input.word || token);
    const suggestions = normalizeCorrectionSuggestions(input.suggestions || []);
    const primary = normalizeWordToken(input.primary || '');
    const fallback = primary || suggestions[0] || targetWord;
    if (!fallback) {
        return { word: '', source: 'none', confidence: 0 };
    }

    const mode = String(options.mode || '').trim().toLowerCase();
    if (mode === 'rule') {
        return { word: fallback, source: 'rule_fallback', confidence: 0 };
    }

    if (String(process.env.RATE_LIMIT_SAFE_MODE || '').toLowerCase() === 'true') {
        return { word: fallback, source: 'rule_fallback', confidence: 0 };
    }

    const llmThinking = String(options.llmThinking || process.env.ANKI_WORD_QUALITY_THINKING || DEFAULT_LLM_THINKING)
        .trim()
        .toLowerCase() || DEFAULT_LLM_THINKING;
    const llmAgentId = String(options.llmAgentId || process.env.ANKI_WORD_QUALITY_AGENT || DEFAULT_LLM_AGENT).trim();
    const llmContainers = String(options.llmContainers || process.env.ANKI_WORD_QUALITY_CONTAINERS || '').trim();
    const timeoutMs = Number(options.timeoutMs || process.env.ANKI_WORD_CORRECTION_TIMEOUT_MS || DEFAULT_LLM_CORRECTION_TIMEOUT_MS);
    const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.floor(timeoutMs)
        : DEFAULT_LLM_CORRECTION_TIMEOUT_MS;

    const prompt = buildTypoCorrectionPrompt({
        token,
        targetWord,
        suggestions,
        fallback,
    });

    try {
        const raw = await callOpenClawAgent(prompt, llmThinking, {
            agentId: llmAgentId,
            containers: llmContainers,
            timeoutMs: safeTimeoutMs,
        });
        const candidate = normalizeWordToken(
            (raw && (raw.word || raw.correctedWord || raw.toeicWord || raw.term || raw.candidate)) || '',
        );
        if (candidate && isWordLikeCandidate(candidate)) {
            return {
                word: candidate,
                source: 'llm',
                confidence: Number(raw && raw.confidence ? raw.confidence : 0),
                reason: String(raw && raw.reason ? raw.reason : '').trim(),
            };
        }
        return { word: fallback, source: 'rule_fallback', confidence: 0, reason: 'llm_invalid_candidate' };
    } catch (error) {
        return {
            word: fallback,
            source: 'rule_fallback',
            confidence: 0,
            reason: `llm_error:${String(error && error.message ? error.message : error)}`,
        };
    }
}

async function createWordQuality(word, hint = '', options = {}) {
    const policy = normalizeQualityPolicy(options.policy || {});
    const normalizedWord = String(word || '').trim().replace(/\s+/g, ' ');
    if (!normalizedWord) {
        return {
            lemma: '',
            partOfSpeech: '',
            meaningKo: '',
            exampleEn: '',
            exampleKo: '',
            toeicTip: '',
            confidence: 0,
            sourceMode: 'local',
            warnings: ['empty_word'],
            degraded: true,
            styleVersion: STYLE_VERSION,
        };
    }

    const local = await buildLocalQuality(normalizedWord, hint, policy);
    let finalCandidate = {
        ...local.candidate,
        styleVersion: STYLE_VERSION,
    };
    const localWarningSet = new Set([
        ...(Array.isArray(local.evaluation.warnings) ? local.evaluation.warnings : []),
        ...(Array.isArray(local.candidate.warnings) ? local.candidate.warnings : []),
    ]);
    const needsWarningFallback = [
        'example_generic_template',
        'example_ko_placeholder',
        'meaning_translation_failed',
        'word_translation_failed',
        'example_translation_failed',
        'tip_not_specific',
        'tip_lacks_detail',
    ].some((prefix) => {
        const key = String(prefix || '').trim();
        if (!key) return false;
        for (const warning of localWarningSet) {
            const w = String(warning || '').trim();
            if (w === key || w.startsWith(`${key}:`)) return true;
        }
        return false;
    });

    const forceLlmFallback = policy.llmFallbackMode === 'always';
    const shouldTryLlmFallback = policy.enableHybridFallback
        && (forceLlmFallback || local.evaluation.score < policy.qualityThreshold || needsWarningFallback);

    if (shouldTryLlmFallback) {
        try {
            const llmCandidate = await runLlmFallback(normalizedWord, hint, finalCandidate, options);
            const llmEval = evaluateQuality(llmCandidate, policy.qualityThreshold, normalizedWord);
            const llmUsable = !llmEval.hardFail;
            const preferLlmResult = forceLlmFallback ? llmUsable : llmEval.score >= local.evaluation.score;
            if (preferLlmResult) {
                finalCandidate = {
                    ...llmCandidate,
                    sourceMode: forceLlmFallback
                        ? 'llm_forced'
                        : (local.evaluation.score > 0 ? 'hybrid' : 'llm_fallback'),
                    confidence: llmEval.score,
                    warnings: [...new Set([...(llmCandidate.warnings || []), ...(llmEval.warnings || [])])],
                    styleVersion: STYLE_VERSION,
                };
            } else {
                finalCandidate.warnings = [...new Set([
                    ...(finalCandidate.warnings || []),
                    forceLlmFallback ? 'llm_forced_not_usable' : 'llm_fallback_not_better',
                ])];
            }
        } catch (error) {
            finalCandidate.warnings = [...new Set([...(finalCandidate.warnings || []), `llm_fallback_failed:${String(error.message || error)}`])];
        }
    }

    const finalEval = evaluateQuality(finalCandidate, policy.qualityThreshold, normalizedWord);
    return {
        ...finalCandidate,
        confidence: finalEval.score,
        degraded: !finalEval.ok,
        hardFail: Boolean(finalEval.hardFail),
        warnings: [...new Set([...(finalCandidate.warnings || []), ...(finalEval.warnings || [])])],
    };
}

module.exports = {
    STYLE_VERSION,
    DEFAULT_POLICY,
    KNOWN_TOEIC_TERMS,
    normalizeQualityPolicy,
    normalizeWordToken,
    fallbackMeaning,
    fallbackExample,
    buildWordCandidates,
    createWordQuality,
    evaluateQuality,
    suggestToeicTypoCorrection,
};
