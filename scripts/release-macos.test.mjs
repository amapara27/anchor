import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const script=readFileSync(new URL('./release-macos.sh',import.meta.url),'utf8');
const selection=script.slice(script.indexOf('set -euo pipefail'),script.indexOf('# Notarization auth.'));
function select(lines,explicit='') {
  return spawnSync('bash',['-c','set -euo pipefail\nsecurity() { printf "%s\\n" "$TEST_IDENTITIES"; }\n'+selection+'\ntest -z "${APPLE_PASSWORD:-}"\nprintf "%s" "$APPLE_SIGNING_IDENTITY"'],{encoding:'utf8',env:{...process.env,TEST_IDENTITIES:lines,APPLE_SIGNING_IDENTITY:explicit,APPLE_PASSWORD:'obsolete-test-password'}});
}
test('one valid certificate selects its fingerprint',()=>{const r=select('  1) ABCDEF123456 "Developer ID Application: Test (TEAM)"');assert.equal(r.status,0);assert.equal(r.stdout,'ABCDEF123456');});
test('renewal with two certificates requires explicit selection',()=>{const r=select('  1) ABCDEF123456 "Developer ID Application: Test (TEAM)"\n  2) 123456ABCDEF "Developer ID Application: Test (TEAM)"');assert.notEqual(r.status,0);});
test('explicit replacement identity is preserved',()=>{const r=select('', '123456ABCDEF');assert.equal(r.status,0);assert.equal(r.stdout,'123456ABCDEF');});
