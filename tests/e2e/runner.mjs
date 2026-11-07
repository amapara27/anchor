// Exercise the orchestrator as a process, including failures, blocked prerequisites and Stop.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, copyFile, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const scratch = await mkdtemp(path.join(tmpdir(), 'anchor-runner-e2e-'));
const script = path.join(scratch, 'scripts/test-e2e.mjs'), fixture = path.join(scratch, 'tests/e2e/release.mjs');
await mkdir(path.dirname(script), { recursive: true });
await mkdir(path.dirname(fixture), { recursive: true });
await copyFile(new URL('../../scripts/test-e2e.mjs', import.meta.url), script);
const bin = path.join(scratch, 'bin');
await mkdir(bin);
await symlink(process.execPath, path.join(bin, 'node'));
async function run(args, env = {}, stop = false) {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', sent = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', b => { out += b; if (stop && !sent && out.includes('fixture-waiting')) {
        sent = true;
        child.kill('SIGINT');
    } });
    child.stderr.on('data', b => err += b);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(timer);
    return { code, out, err };
}
const latest = async () => JSON.parse(await readFile(path.join(scratch, '.internal/testing/latest.json'), 'utf8'));
try {
    await writeFile(fixture, 'console.log("fixture-passed");');
    assert.equal((await run(['--only', 'release'])).code, 0);
    assert.equal((await latest()).status, 'passed-selected');
    await writeFile(fixture, `
        import { fork } from 'node:child_process';
        if (process.argv[2] === 'descendant') {
            process.on('SIGTERM', () => {});
            process.send(process.pid);
            setTimeout(() => { console.error('fixture-unreaped'); process.exit(1); }, 8000);
            setInterval(() => {}, 1000);
        } else {
            const child = fork(new URL(import.meta.url), ['descendant']);
            child.once('message', pid => {
                console.log('fixture-descendant ' + pid);
                child.disconnect();
                child.unref();
            });
        }
    `);
    const cleaned = await run(['--only', 'release']);
    assert.equal(cleaned.code, 0, cleaned.out + cleaned.err);
    assert.doesNotMatch(cleaned.err, /fixture-unreaped/);
    const pid = Number(cleaned.out.match(/fixture-descendant (\d+)/)[1]);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await writeFile(fixture, 'console.error("fixture-bug-evidence");process.exitCode=42;');
    assert.equal((await run(['--only', 'release'])).code, 1);
    const failed = await latest();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.nextActions[0].stage, 'release');
    assert.match(await readFile(failed.nextActions[0].log, 'utf8'), /fixture-bug-evidence/);
    assert.match(failed.nextActions[0].rerun, /--only release/);
    assert.equal((await run(['--only', 'release'], { PATH: bin })).code, 2);
    assert.equal((await latest()).status, 'blocked');
    assert.match((await latest()).nextActions[0].reason, /bash/);
    assert.equal((await run(['--only', 'not-a-stage'])).code, 2);
    assert.equal((await run(['--only'])).code, 2);
    assert.equal((await run(['--profile'])).code, 2);
    assert.equal((await run(['--surface'])).code, 2);
    assert.equal((await run(['--surface', 'invalid'])).code, 2);
    const listed = await run(['--surface', 'cli', '--list']);
    assert.equal(listed.code, 0); assert.match(listed.out, /cli-mlx/);
    const lock = path.join(scratch, '.internal/testing/active.lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid, run: 'fixture-owner' }));
    assert.equal((await run(['--only', 'release'])).code, 2);
    assert.equal(JSON.parse(await readFile(lock, 'utf8')).run, 'fixture-owner');
    await rm(lock);
    await writeFile(fixture, 'console.log("fixture-waiting");setInterval(()=>{},1000);');
    assert.equal((await run(['--only', 'release'], {}, true)).code, 130);
    assert.equal((await latest()).status, 'blocked');
    console.log('Runner process E2E passed: success, descendant cleanup, product failure evidence, targeted rerun, blocked prerequisite, invalid selection, exclusive ownership and interruption cleanup.');
}
finally {
    await rm(scratch, { recursive: true, force: true });
}
