// Exercise the release script with fake tools and credentials.
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
    assert(!config.build.beforeBundleCommand, 'Keep build hooks outside the credential-bearing bundling step');
    const credentials = path.join(scratch, 'fake-home');
    const project = path.join(scratch, 'project');
    const log = path.join(scratch, 'release-steps');
    await mkdir(path.join(credentials, 'private_keys'), { recursive: true });
    await mkdir(path.join(project, 'apps/desktop/src-tauri'), { recursive: true });
    await mkdir(path.join(project, 'scripts'));
    await writeFile(path.join(project, 'scripts/bundle-macos.sh'), await readFile(path.join(root, 'scripts/bundle-macos.sh')));
    await writeFile(path.join(credentials, 'private_keys/AuthKey_FIXTURE.p8'), 'fixture-notary-key');
    await writeFile(path.join(credentials, 'private_keys/issuer_id'), 'fixture-issuer');
    const key = path.join(credentials, 'updater.key');
    await writeFile(key, 'fixture-updater-key');
    await writeFile(path.join(project, 'apps/desktop/src-tauri/tauri.conf.json'), JSON.stringify(config));
    await writeFile(path.join(bin, 'ls'), '#!/bin/sh\nexec /bin/ls "$@"\n', { mode: 0o755 });
    await writeFile(path.join(bin, 'security'), `#!/bin/sh
set -eu
[ "$*" = "find-generic-password -s anchor-updater-key -w" ]
printf '%s\\n' password-read >> "$RELEASE_TEST_LOG"
printf '%s' fixture-updater-password
`, { mode: 0o755 });
    await writeFile(path.join(bin, 'pnpm'), `#!/bin/sh
set -eu
case "$*" in
  "tauri build --no-bundle --no-sign -- --locked")
    [ -z "\${TAURI_SIGNING_PRIVATE_KEY:-}" ]
    [ -z "\${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]
    [ -z "\${APPLE_PASSWORD:-}" ]
    [ -z "\${APPLE_API_KEY_PATH:-}" ]
    [ -z "\${APPLE_CERTIFICATE:-}" ]
    [ -z "\${APPLE_CERTIFICATE_PASSWORD:-}" ]
    printf '%s\\n' build >> "$RELEASE_TEST_LOG"
    [ "\${RELEASE_TEST_FAIL_BUILD:-0}" = 0 ] || exit 73
    ;;
  "tauri bundle")
    [ "$TAURI_SIGNING_PRIVATE_KEY" = fixture-updater-key ]
    [ "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" = fixture-updater-password ]
    [ "$APPLE_API_KEY" = FIXTURE ]
    [ "$APPLE_API_ISSUER" = fixture-issuer ]
    [ "$APPLE_SIGNING_IDENTITY" = FEDCBA ]
    printf '%s\\n' bundle >> "$RELEASE_TEST_LOG"
    mkdir -p target/release/bundle/macos/Anchor.app target/release/bundle/dmg
    printf '%s' fixture-signature > target/release/bundle/macos/Anchor.app.tar.gz.sig
    touch "target/release/bundle/dmg/Anchor_$RELEASE_TEST_VERSION"_aarch64.dmg
    ;;
  *) exit 82 ;;
esac
`, { mode: 0o755 });
    for (const name of ['codesign', 'spctl', 'xcrun'])
        await writeFile(path.join(bin, name), `#!/bin/sh
set -eu
[ -z "\${TAURI_SIGNING_PRIVATE_KEY:-}" ]
[ -z "\${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]
[ -z "\${APPLE_CERTIFICATE:-}" ]
[ -z "\${APPLE_CERTIFICATE_PASSWORD:-}" ]
printf '%s\\n' ${name} >> "$RELEASE_TEST_LOG"
`, { mode: 0o755 });
    const environment = {
        ...process.env, PATH: bin + path.delimiter + process.env.PATH, HOME: credentials,
        APPLE_SIGNING_IDENTITY: 'FEDCBA', TAURI_KEY_PATH: key, RELEASE_TEST_LOG: log,
        RELEASE_TEST_VERSION: config.version, APPLE_PASSWORD: 'inherited-fixture-password',
        TAURI_SIGNING_PRIVATE_KEY: 'inherited-fixture-key',
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'inherited-fixture-updater-password',
        APPLE_API_KEY_PATH: '/inherited-fixture-path',
        APPLE_CERTIFICATE: 'inherited-fixture-certificate', APPLE_CERTIFICATE_PASSWORD: 'inherited-fixture-certificate-password',
    };
    const script = path.join(root, 'scripts/release-macos.sh');
    for (const failBuild of [true, false]) {
        await writeFile(log, '');
        const result = spawnSync('bash', ['-x', script], { cwd: project, encoding: 'utf8', timeout: 10000,
            env: { ...environment, RELEASE_TEST_FAIL_BUILD: failBuild ? '1' : '0' } });
        assert.equal(result.status, failBuild ? 73 : 0, result.stderr);
        assert.doesNotMatch(result.stdout + result.stderr, /fixture-updater-key|fixture-updater-password|inherited-fixture/);
        const steps = (await readFile(log, 'utf8')).trim().split('\n');
        if (failBuild) assert.deepEqual(steps, ['build'], 'failed compilation must not fetch signing secrets');
        else {
            assert.deepEqual(steps.slice(0, 4), ['build', 'password-read', 'bundle', 'codesign']);
            const manifest = JSON.parse(await readFile(path.join(project, 'target/release/bundle/latest.json'), 'utf8'));
            assert.equal(manifest.version, config.version);
            assert.equal(manifest.platforms['darwin-aarch64'].signature, 'fixture-signature');
            assert.equal(manifest.platforms['darwin-aarch64'].url,
                'https://github.com/amapara27/anchor/releases/download/v' + config.version + '/Anchor.app.tar.gz');
        }
    }
    await writeFile(log, '');
    const ciResult = spawnSync('bash', ['-x', path.join(root, 'scripts/bundle-macos.sh')], {
        cwd: project, encoding: 'utf8', timeout: 10000,
        env: { ...environment, APPLE_API_KEY: 'FIXTURE', APPLE_API_ISSUER: 'fixture-issuer',
            APPLE_API_KEY_PATH: path.join(credentials, 'private_keys/AuthKey_FIXTURE.p8'),
            TAURI_SIGNING_PRIVATE_KEY: 'fixture-updater-key', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'fixture-updater-password',
            APPLE_CERTIFICATE: 'fixture-certificate', APPLE_CERTIFICATE_PASSWORD: 'fixture-certificate-password' },
    });
    assert.equal(ciResult.status, 0, ciResult.stderr);
    assert.doesNotMatch(ciResult.stdout + ciResult.stderr, /fixture-updater-key|fixture-updater-password|fixture-certificate/);
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n').slice(0, 2), ['bundle', 'codesign']);
    console.log('Release process E2E passed: safe refusal, build/sign isolation, failed-build refusal, CI bundling, inherited-secret removal, trace suppression and updater manifest. Actual signing/notarization/update installation remain manual.');
}
finally {
    await rm(scratch, { recursive: true, force: true });
}
