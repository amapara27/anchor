// Owned Ollama process/store only. Real GPU generations and versioned Rust evidence.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = await mkdtemp(path.join(tmpdir(), 'anchor-ollama-e2e-'));
const socket = createServer();
await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise(r => socket.close(r));
const host = 'http://127.0.0.1:' + port;
const server = spawn('ollama', ['serve'], { env: { ...process.env, OLLAMA_HOST: host, OLLAMA_MODELS: path.join(scratch, 'models'), OLLAMA_NO_CLOUD: '1', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', success = false, job = null, launchError = null;
server.once('error', e => launchError = e);
server.stdout.on('data', b => log += b);
server.stderr.on('data', b => log += b);
try {
    let version = null;
    for (let i = 0; i < 300; i++) {
        if (launchError)
            throw launchError;
        if (server.exitCode !== null)
            throw Error('Owned Ollama server exited: ' + log.slice(-2000));
        try {
            version = await (await fetch(host + '/api/version', { signal: AbortSignal.timeout(1000) })).json();
            break;
        }
        catch { }
        await new Promise(r => setTimeout(r, 100));
    }
    assert(version, 'owned server must become ready');
    console.log('STEP ollama.runtime ' + version.version);
    // Supported floor; decode uses the source-checked runner convention on every version from here.
    if (!(v => { const [a, b] = v.split('.').map(n => parseInt(n, 10)); return a > 0 || b >= 32; })(version.version)) {
        console.error('BLOCKED: live acceptance requires Ollama 0.32 or later; found ' + version.version);
        process.exitCode = 77;
    }
    else {
        const pull = await fetch(host + '/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gemma3:270m', stream: false }), signal: AbortSignal.timeout(600000) });
        assert(pull.ok);
        const result = await pull.json();
        assert.equal(result.status, 'success');
        assert(!result.error);
        console.log('STEP ollama.fresh-model-ready');
        const args = ['test', '--locked', '-p', 'anchor-hub', '--test', 'ollama_decode_e2e', '--', '--ignored', '--nocapture'];
        job = spawn('cargo', args, { cwd: root, env: { ...process.env, OLLAMA_MODELS: path.join(scratch, 'models'), ANCHOR_OLLAMA_E2E_HOST: host, ANCHOR_OLLAMA_E2E_MODEL: 'gemma3:270m' }, stdio: ['ignore', 'inherit', 'inherit'] });
        const code = await new Promise((resolve, reject) => { job.once('error', reject); job.once('exit', resolve); });
        assert.equal(code, 0, 'real runtime decode/calibration/replay acceptance');
        success = true;
        console.log('Ollama live E2E passed: isolated server/store, fresh weights, representative generations, one-token exclusion, calibration and offline replay.');
    }
}
finally {
    job?.kill('SIGTERM');
    server.kill('SIGTERM');
    await new Promise(r => { if (server.exitCode !== null)
        return r(); server.once('exit', r); setTimeout(() => { server.kill('SIGKILL'); r(); }, 3000).unref(); });
    const artifact = process.env.ANCHOR_E2E_ARTIFACT_DIR;
    if (artifact) {
        await mkdir(artifact, { recursive: true });
        await writeFile(path.join(artifact, 'ollama-server.log'), log);
    }
    if (success || process.exitCode === 77)
        await rm(scratch, { recursive: true, force: true });
    else {
        await writeFile(path.join(scratch, 'server.log'), log);
        console.error('Ollama failure evidence: ' + scratch);
    }
}
