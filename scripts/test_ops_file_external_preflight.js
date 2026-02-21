const assert = require('assert');
const fs = require('fs');
const path = require('path');

const opsFileControl = require('./ops_file_control');

function main() {
    const policy = opsFileControl.loadPolicy({
        opsFileControlPolicy: {
            minFreeBytes: 1,
        },
    });

    const missing = opsFileControl.runDrivePreflight('/Volumes/__definitely_missing_drive__/tmp', policy);
    assert.strictEqual(missing.driveRoot, '/Volumes/__definitely_missing_drive__');
    assert.ok(missing.errors.includes('DRIVE_NOT_MOUNTED'));

    const volumeCandidates = fs.existsSync('/Volumes')
        ? fs.readdirSync('/Volumes').filter(Boolean)
        : [];

    if (volumeCandidates.length > 0) {
        const drivePath = `/Volumes/${volumeCandidates[0]}`;
        const probe = opsFileControl.runDrivePreflight(path.join(drivePath, 'tmp'), policy);
        assert.strictEqual(probe.driveRoot, drivePath);
        assert.strictEqual(typeof probe.mounted, 'boolean');
        assert.strictEqual(typeof probe.writable, 'boolean');
        assert.strictEqual(typeof probe.freeBytes, 'number');
    }

    console.log('test_ops_file_external_preflight: ok');
}

main();
