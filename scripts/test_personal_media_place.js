const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { handleMediaPlaceCommand } = require('./personal_media_place');

function makeTempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-media-place-'));
    return {
        dir,
        dbPath: path.join(dir, 'personal.sqlite'),
    };
}

async function main() {
    const { dir, dbPath } = makeTempDb();
    try {
        const media = await handleMediaPlaceCommand('듄2 봤음 4.5점 #sf', {
            dbPath,
            kind: 'media',
        });
        assert.strictEqual(media.route, 'media');
        assert.strictEqual(media.success, true);
        assert.strictEqual(media.action, 'record');

        const mediaDuplicate = await handleMediaPlaceCommand('듄2 봤음 4.5점 #sf', {
            dbPath,
            kind: 'media',
        });
        assert.strictEqual(mediaDuplicate.success, true);
        assert.strictEqual(mediaDuplicate.action, 'duplicate');

        const mediaList = await handleMediaPlaceCommand('목록', {
            dbPath,
            kind: 'media',
        });
        assert.strictEqual(mediaList.success, true);
        assert.strictEqual(mediaList.action, 'list');

        const place = await handleMediaPlaceCommand('라멘집 가고싶음 #도쿄', {
            dbPath,
            kind: 'place',
        });
        assert.strictEqual(place.route, 'place');
        assert.strictEqual(place.success, true);
        assert.strictEqual(place.action, 'record');

        const placeSummary = await handleMediaPlaceCommand('통계', {
            dbPath,
            kind: 'place',
        });
        assert.strictEqual(placeSummary.success, true);
        assert.strictEqual(placeSummary.action, 'summary');

        console.log('test_personal_media_place: ok');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
