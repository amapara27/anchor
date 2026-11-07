// Actual executable → isolated runtime/cache → GPU → SQLite → offline evidence replay.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalLive } from './terminal-live.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.argv[2];
assert(['ollama', 'mlx'].includes(runtime));
const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'anchor-cli-' + runtime + '-')));
const env = { ...process.env, ANCHOR_E2E_DATA_DIR: scratch, OLLAMA_MODELS: path.join(scratch, 'models'),
    HF_HOME: path.join(scratch, 'hf'), HF_HUB_CACHE: path.join(scratch, 'hf/hub'), HF_XET_CACHE: path.join(scratch, 'xet'),
    UV_CACHE_DIR: path.join(scratch, 'uv-cache'), OLLAMA_NO_CLOUD: '1', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1' };
const binary = path.join(root, 'target/cli-e2e/debug/anchor');
const model = runtime === 'mlx' ? 'mlx-community/gemma-3-270m-it-4bit' : 'gemma3:270m';
const commands = [], children = new Set();
let server = null, serverLog = '', success = false, step = 'build', blocked = false;
async function run(args, { code = 0, json = true, cancel = null } = {}) {
    const child = spawn(binary, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '', sent = false, pending = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 900000);
    child.stdout.on('data', b => stdout += b);
    child.stderr.on('data', b => {
        const text = b.toString(); stderr += text; pending += text;
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) {
            if (cancel && !sent && cancel(line)) { sent = true; child.kill('SIGINT'); }
        }
    });
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); })
        .finally(() => { clearTimeout(timer); children.delete(child); });
    commands.push({ args, ...result, stdout, stderr });
    assert.equal(result.code, code, args.join(' ') + '\n' + stderr.slice(-8000));
    if (cancel) assert(sent, 'must interrupt actual work before completion');
    return json ? JSON.parse(stdout) : stdout;
}
const checkpoint = name => { step = name; console.log('STEP cli-' + runtime + '.' + name); };
try {
    const build = spawn('cargo', ['build', '--locked', '-p', 'anchor-cli', '--features', 'e2e', '--target-dir', 'target/cli-e2e'], { cwd: root, stdio: 'inherit' });
    children.add(build);
    assert.equal(await new Promise((resolve, reject) => { build.once('error', reject); build.once('close', resolve); }), 0);
    children.delete(build);
    if (runtime === 'ollama') {
        const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
        const port = socket.address().port; await new Promise(r => socket.close(r));
        env.OLLAMA_HOST = 'http://127.0.0.1:' + port;
        server = spawn('ollama', ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(server);
        server.stdout.on('data', b => serverLog += b); server.stderr.on('data', b => serverLog += b);
        let version;
        for (let i = 0; i < 300; i++) {
            if (server.exitCode !== null) throw Error('owned server exited: ' + serverLog);
            try { version = await (await fetch(env.OLLAMA_HOST + '/api/version', { signal: AbortSignal.timeout(1000) })).json(); break; } catch {}
            await new Promise(r => setTimeout(r, 100));
        }
        assert(version, 'owned Ollama must become ready');
        if (version.version !== '0.34.4') {
            blocked = true; process.exitCode = 77;
            console.error('BLOCKED: live measurement acceptance requires recorded Ollama 0.34.4; found ' + version.version);
        }
    } else {
        // MLX commands must not attempt to start or contact Ollama.
        env.OLLAMA_HOST = 'http://127.0.0.1:1';
    }
    if (!blocked) {
        checkpoint('cold-download-cancel-retry');
        assert.deepEqual(await run(['models', 'ls', '--runtime', runtime, '--json']), []);
        let weightBase = null;
        await run(['models', 'pull', model, '--runtime', runtime, '--json'], { code: 130, json: false, cancel: line => {
            let p; try { p = JSON.parse(line); } catch { return false; }
            if (runtime === 'mlx') {
                if (!p.status?.startsWith('Downloading ') || !p.status.endsWith('.safetensors')) return false;
                weightBase ??= p.completed;
                return p.completed > weightBase;
            }
            return p.completed > 0 && p.total > p.completed;
        } });
        if (runtime === 'mlx') {
            const catalog = await run(['models', 'catalog', '--runtime', runtime, '--json']);
            assert(!catalog.find(m => m.id === model).path, 'interrupted checkpoint must not be ready');
        }
        await run(['models', 'pull', model, '--runtime', runtime, '--json']);
        const installed = await run(['models', 'ls', '--runtime', runtime, '--json']);
        assert(installed.length > 0);
        if (runtime === 'mlx') {
            const catalog = await run(['models', 'catalog', '--runtime', runtime, '--json']);
            const entry = catalog.find(m => m.id === model); assert(entry?.path);
            const hashes = [];
            for (const file of entry.files) {
                const filename = path.join(entry.path, file.name), size = (await stat(filename)).size;
                assert.equal(size, file.bytes);
                const hash = createHash(file.sha256 ? 'sha256' : 'sha1');
                if (!file.sha256) hash.update('blob ' + size + '\0');
                for await (const chunk of createReadStream(filename)) hash.update(chunk);
                const actual = hash.digest('hex'); assert.equal(actual, file.sha256 ?? file.git_sha1);
                hashes.push({ name: file.name, hash: actual });
            }
            commands.push({ checkpoint: entry.path, hashes });
        }
        checkpoint('nine-workloads-and-single-scenario');
        const runs = await run(['bench', 'run', model, '--runtime', runtime, '--repeats', 'fast', '--json']);
        assert.equal(runs.length, 9); assert.equal(new Set(runs.map(r => r.prompt_id)).size, 9);
        assert(runs.every(r => r.ttft_ms_median !== null));
        let selected = model;
        if (runtime === 'mlx') {
            const entry = (await run(['models', 'catalog', '--runtime', runtime, '--json'])).find(m => m.id === model);
            selected = path.join(scratch, 'checkpoint-link'); await symlink(entry.path, selected);
        }
        const one = await run(['bench', 'run', selected, '--runtime', runtime, '--repeats', 'fast', '--scenario', 'classify', '--json']);
        assert.equal(one.length, 1); assert.equal(one[0].prompt_id, 'classify');
        await run(['bench', 'samples', one[0].id, '--runtime', runtime, '--json']);
        checkpoint('history-validation-and-replay');
        const history = await run(['bench', 'ls', '--model', model, '--runtime', runtime, '--json']);
        assert(history.some(r => r.id === one[0].id));
        if (runtime === 'mlx') assert((await run(['bench', 'ls', '--model', selected, '--runtime', runtime, '--json'])).some(r => r.id === one[0].id), 'local symlink checkpoint resolves to the recorded identity');
        const top = await run(['bench', 'top', '--model', model, '--runtime', runtime, '--scenario', 'classify', '--json']);
        assert(top.length > 0 && top.every(r => r.prompt_id === 'classify'));
        const sessions = await run(['bench', 'sessions', '--runtime', runtime, '--json']);
        assert(sessions.length >= 2 && sessions.every(s => runtime === 'mlx' ? s.protocol.startsWith('mlx_') : !s.protocol.startsWith('mlx_')));
        const evidence = await run(['bench', 'export', sessions[0].id, '--include-content']);
        await run(['bench', 'report', sessions[0].id, '--json']);
        if (runtime === 'ollama') {
            await run(['bench', 'validate', model, '--json']);
            const all = await run(['bench', 'sessions', '--json']);
            const validation = all.find(s => s.id !== sessions[0].id && s.protocol.includes('calibration'));
            assert(validation); await run(['bench', 'report', validation.id, '--json']);
        } else {
            assert(evidence.derived.mlx); assert.equal(evidence.session.outcome, 'completed');
        }
        evidence.derived.attempts = []; evidence.derived.scenarios = [];
        const file = path.join(scratch, 'replay.json'); await writeFile(file, JSON.stringify(evidence));
        const replay = await run(['bench', 'replay', file]);
        // Compare replay against a fresh independent read of the retained session.
        const stored = await run(['bench', 'export', sessions[0].id, '--include-content']);
        assert.deepEqual(replay, stored.derived);
        checkpoint('graceful-stop');
        await run(['bench', 'run', model, '--runtime', runtime, '--json'], { code: 130, cancel: line => /warming up|[1-9]\/9 /.test(line) });
        const after = await run(['bench', 'sessions', '--runtime', runtime, '--json']);
        assert(after.some(s => s.outcome === 'cancelled'));
        await terminalLive({ root, binary, scratch, env, commands, children, runtime, model, run, checkpoint });
        success = true; console.log('CLI ' + runtime + ' live E2E passed.');
    }
} finally {
    for (const child of children) child.kill('SIGTERM');
    if (server && server.exitCode === null) await new Promise(r => { server.once('close', r); setTimeout(() => { server.kill('SIGKILL'); r(); }, 3000).unref(); });
    const artifact = process.env.ANCHOR_E2E_ARTIFACT_DIR;
    if (artifact) { await mkdir(artifact, { recursive: true }); await writeFile(path.join(artifact, 'cli-' + runtime + '.json'), JSON.stringify({ step, success, blocked, commands, serverLog }, null, 2)); }
    if (success || blocked) await rm(scratch, { recursive: true, force: true });
    else { await writeFile(path.join(scratch, 'failure.json'), JSON.stringify({ step, commands, serverLog }, null, 2)); console.error('CLI live failure evidence: ' + scratch); }
}
