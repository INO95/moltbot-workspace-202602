const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { handleJobPipelineCommand, parseCommand } = require('./personal_job_pipeline');

function makeTempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-job-pipeline-'));
    return {
        dir,
        dbPath: path.join(dir, 'personal.sqlite'),
    };
}

async function main() {
    const { dir, dbPath } = makeTempDb();
    try {
        const parsed = parseCommand('지원처 추가 회사명=Acme 포지션=Backend Engineer 링크=https://jobs.example/acme 스택=Node Tokyo priority=2');
        assert.strictEqual(parsed.action, 'add');
        assert.strictEqual(parsed.company.name, 'Acme');
        assert.strictEqual(parsed.opportunity.title, 'Backend Engineer');

        const add = await handleJobPipelineCommand(
            '지원처 추가 회사명=Acme 포지션=Backend Engineer 링크=https://jobs.example/acme 스택=Node.js 위치=Tokyo fit_score=4 interest_score=5 priority=2',
            { dbPath },
        );
        assert.strictEqual(add.route, 'job');
        assert.strictEqual(add.success, true);
        assert.strictEqual(add.action, 'add');
        assert.ok(add.entityId);

        const duplicate = await handleJobPipelineCommand(
            '지원처 추가 회사명=Acme 포지션=Backend Engineer 링크=https://jobs.example/acme 스택=Node.js 위치=Tokyo fit_score=4 interest_score=5 priority=2',
            { dbPath },
        );
        assert.strictEqual(duplicate.success, true);
        assert.strictEqual(duplicate.action, 'duplicate');

        const stage = await handleJobPipelineCommand('Acme 현재 단계 interview_1로 변경', { dbPath });
        assert.strictEqual(stage.success, true);
        assert.strictEqual(stage.action, 'stage');
        assert.strictEqual(stage.result.detail.current_stage, 'interview_1');

        const note = await handleJobPipelineCommand('리크루터 메모 저장 Acme 다음 주에 답장 필요 #followup', { dbPath });
        assert.strictEqual(note.success, true);
        assert.strictEqual(note.action, 'note');
        assert.ok(note.entityId);

        const contact = await handleJobPipelineCommand('연락처 추가 Acme Jane linkedin https://linkedin.example/jane', { dbPath });
        assert.strictEqual(contact.success, true);
        assert.strictEqual(contact.action, 'contact');
        assert.ok(contact.entityId);

        const next = await handleJobPipelineCommand('Acme 다음액션=포트폴리오 보내기 마감=2026-05-03 priority=1', { dbPath });
        assert.strictEqual(next.success, true);
        assert.strictEqual(next.action, 'next_action');
        assert.strictEqual(next.result.action.due_at, '2026-05-03');

        const list = await handleJobPipelineCommand('목록', { dbPath });
        assert.strictEqual(list.success, true);
        assert.strictEqual(list.action, 'list');
        assert.ok(Array.isArray(list.rows));
        assert.ok(list.rows.length >= 1);

        const pending = await handleJobPipelineCommand('이번 주 팔로업 필요한 회사 보여줘', {
            dbPath,
            now: '2026-04-29T00:00:00+09:00',
        });
        assert.strictEqual(pending.success, true);
        assert.strictEqual(pending.action, 'pending');
        assert.ok(pending.rows.some((row) => row.company_name === 'Acme'));

        const search = await handleJobPipelineCommand('검색 backend', { dbPath });
        assert.strictEqual(search.success, true);
        assert.strictEqual(search.action, 'search');
        assert.ok(search.rows.some((row) => row.company_name === 'Acme'));

        const detail = await handleJobPipelineCommand('상세 Acme', { dbPath });
        assert.strictEqual(detail.success, true);
        assert.strictEqual(detail.action, 'detail');
        assert.strictEqual(detail.detail.detail.company_name, 'Acme');
        assert.ok(detail.detail.timeline.length >= 3);

        const weekly = await handleJobPipelineCommand('주간요약', {
            dbPath,
            now: '2026-04-29T00:00:00+09:00',
        });
        assert.strictEqual(weekly.success, true);
        assert.strictEqual(weekly.action, 'weekly_summary');
        assert.ok(weekly.summary.byStage.length >= 1);

        console.log('test_personal_job_pipeline: ok');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
