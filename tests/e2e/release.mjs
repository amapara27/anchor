// Run the actual release shell script up to its credential boundary; never sign or publish.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = await mkdtemp(path.join(tmpdir(), 'anchor-release-e2e-'));
try {
    const bin = path.join(scratch, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'security'), '#!/bin/sh\n[ -z "${APPLE_PASSWORD:-}" ] || exit 81\nprintf "%s\\n" "$FIXTURE_IDENTITIES"\n', { mode: 0o755 });
    // Prevent looking for real credentials even when an identity is selected.
    await writeFile(path.join(bin, 'ls'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    for (const name of ['pnpm', 'codesign', 'spctl', 'xcrun'])
        await writeFile(path.join(bin, name), '#!/bin/sh\necho forbidden-release-side-effect >&2\nexit 82\n', { mode: 0o755 });
    for (const [name, identities, explicit, message] of [
        ['no identity', '', '', /select a Developer ID/],
        ['ambiguous identities', '  1) ABCDEF "Developer ID Application: Fixture"\n  2) FEDCBA "Developer ID Application: Fixture"', '', /select a Developer ID/],
        ['one identity', '  1) ABCDEF "Developer ID Application: Fixture"', '', /no notarization credentials/],
        ['explicit identity', '', 'FEDCBA', /no notarization credentials/],
    ]) {
        const result = spawnSync('bash', [path.join(root, 'scripts/release-macos.sh')], { cwd: scratch, encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, APPLE_PASSWORD: 'obsolete-fixture-value', APPLE_SIGNING_IDENTITY: explicit, FIXTURE_IDENTITIES: identities } });
        assert.equal(result.status, 1, name + '\n' + result.stderr);
        assert.match(result.stderr, message, name);
        assert(!result.stderr.includes('forbidden-release-side-effect'));
        console.log('STEP release.' + name);
    }
    const config = JSON.parse(await readFile(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
    assert(config.plugins.updater.pubkey && config.plugins.updater.endpoints.length, 'shipped updater needs its public key and endpoint');
    assert.equal(config.bundle.createUpdaterArtifacts, true);
    console.log('Release process E2E passed: safe refusal, explicit identity, obsolete password removal; real signing/notarization/update installation remain manual.');
}
finally {
    await rm(scratch, { recursive: true, force: true });
}
