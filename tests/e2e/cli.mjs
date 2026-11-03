// Real CLI processes → isolated HTTP server → SQLite/filesystem → exported evidence.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = await mkdtemp(path.join(tmpdir(), 'anchor-cli-e2e-'));
const store = path.join(scratch, 'models');
const commands = [], requests = [];
const models = [{ name: 'fixture:1b', digest: 'sha256:fixture', size: 1024 ** 3, details: { family: 'llama', parameter_size: '1B', quantization_level: 'Q4_K_M' } }];
let offline = false, slow = false, resident = null, step = 'startup', success = false;
const baseArch = { architecture: 'llama', block_count: 16, head_count: 32, head_count_kv: 8, key_length: 64, value_length: 64 };
let arch = baseArch;
const server = createServer(async (req, res) => {
    try {
        let raw = '';
        for await (const b of req)
            raw += b;
        const body = raw ? JSON.parse(raw) : {};
        requests.push({ route: req.url, body });
        const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
        if (offline) {
            res.writeHead(503);
            return res.end('fixture offline');
        }
        if (req.url === '/api/version')
            return json({ version: '0.12.0' });
        if (req.url === '/api/tags')
            return json({ models });
        if (req.url === '/api/show')
            return json({ details: models[0].details, model_info: Object.fromEntries([['general.architecture', arch.architecture], [arch.architecture + '.context_length', 131072], ...Object.entries(arch).filter(([k]) => k !== 'architecture').map(([k, v]) => [arch.architecture + '.' + (['block_count', 'embedding_length'].includes(k) ? k : 'attention.' + k), v])]) });
        if (req.url === '/api/ps')
            return json({ models: resident ? [resident] : [] });
        if (req.url === '/api/pull') {
            if (body.name === 'invalid:latest')
                return json({ error: 'model not found' });
            const model = { ...models[0], name: body.name };
            models.push(model);
            res.setHeader('content-type', 'application/x-ndjson');
            return res.end(JSON.stringify({ status: 'downloading', completed: 10, total: 10 }) + '\n' + JSON.stringify({ status: 'success' }) + '\n');
        }
        if (req.url === '/api/delete') {
            const i = models.findIndex(m => m.name === body.name);
            if (i >= 0)
                models.splice(i, 1);
            return json({});
        }
        if (req.url === '/api/generate' || req.url === '/api/chat') {
            if (body.keep_alive === 0 && body.prompt === '') {
                resident = null;
                return json({ done: true });
            }
            resident = { name: body.model, digest: 'sha256:fixture', size: 1024 ** 3, context_length: body.options?.num_ctx ?? 4096 };
            res.setHeader('content-type', 'application/x-ndjson');
            const chat = req.url === '/api/chat';
            res.write(JSON.stringify(chat ? { message: { role: 'assistant', thinking: 'Fixture reasoning', content: '' }, done: false } : { response: 'first ', done: false }) + '\n');
            res.write(JSON.stringify(chat ? { message: { role: 'assistant', content: 'Fixture answer' }, done: false } : { response: 'answer', done: false }) + '\n');
            await new Promise(r => setTimeout(r, slow ? 1500 : 5));
            if (!res.destroyed)
                res.end(JSON.stringify({ done: true, done_reason: 'length', message: { content: '' }, response: '', eval_count: body.options?.num_predict ?? 32, eval_duration: 5e8, prompt_eval_count: 100, prompt_eval_cached_count: 10, prompt_eval_duration: 1e8, total_duration: 1e9, load_duration: 0 }) + '\n');
            return;
        }
        res.writeHead(404);
        res.end('unexpected route');
    }
    catch (e) {
        if (!res.destroyed)
            res.destroy(e);
    }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const env = { ...process.env, OLLAMA_HOST: 'http://127.0.0.1:' + server.address().port, OLLAMA_MODELS: store, ANCHOR_E2E_DATA_DIR: scratch };
const binary = path.join(root, 'target/debug/anchor');
const children = new Set();
async function run(args, { json = false, input = '', code = 0, signalWhen = null, extraEnv = {} } = {}) {
    const child = spawn(binary, args, { env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '', sent = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.stdin.end(input);
    child.stdout.on('data', b => { stdout += b; if (signalWhen && !sent && stdout.includes(signalWhen)) {
        sent = true;
        child.kill('SIGINT');
    } });
    child.stderr.on('data', b => stderr += b);
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }).finally(() => { clearTimeout(timer); children.delete(child); });
    commands.push({ args, ...result, stdout, stderr });
    assert.equal(result.code, code, `${args.join(' ')}\n${stdout}\n${stderr}`);
    if (signalWhen)
        assert(sent, 'must interrupt a running operation');
    return json ? JSON.parse(stdout) : stdout;
}
const checkpoint = name => { step = name; console.log('STEP cli.' + name); };
try {
    checkpoint('isolation-and-sync');
    const paths = await run(['settings', 'paths']);
    assert(paths.includes(scratch));
    await run(['settings', 'paths'], { extraEnv: { ANCHOR_E2E_DATA_DIR: '' }, code: 1 });
    const synced = await run(['models', 'ls', '--json'], { json: true });
    assert.equal(synced.length, 1);
    assert.equal(synced[0].id, 'fixture:1b');
    await run(['models', 'info', 'fixture:1b', '--json'], { json: true });
    checkpoint('hardware-fit-and-catalog');
    const bin = path.join(scratch, 'bin');
    await mkdir(bin);
    const profile = { SPHardwareDataType: [{ machine_name: 'Fixture Mac', chip_type: 'Apple M4', physical_memory: '16 GB', number_processors: 'proc 10:4:6:0' }], SPSoftwareDataType: [{ os_version: 'macOS 27.0.1' }], SPDisplaysDataType: [{ sppci_bus: 'spdisplays_pcie_device', sppci_cores: '64' }, { sppci_bus: 'spdisplays_builtin', sppci_cores: '10' }] };
    await writeFile(path.join(bin, 'system_profiler'), '#!/bin/sh\ncat <<\'JSON\'\n' + JSON.stringify(profile) + '\nJSON\n', { mode: 0o755 });
    const extraEnv = { PATH: bin + path.delimiter + process.env.PATH };
    const hw = await run(['settings', 'hardware', '--refresh', '--json'], { json: true, extraEnv });
    assert.equal(hw.memory_bytes, 16 * 1024 ** 3);
    assert.equal(hw.gpu_cores, 10);
    assert.equal(hw.total_cores, 10);
    assert.equal(hw.os_version, '27.0.1');
    const profiles = JSON.parse(await readFile(path.join(root, 'crates/anchor-core/profiles/models.json'), 'utf8'));
    for (const p of profiles) {
        const small = await run(['fit', p.id, '--ctx', '4096', '--json'], { json: true });
        const big = await run(['fit', p.id, '--ctx', '32768', '--json'], { json: true });
        assert(Number.isFinite(small.breakdown.total_needed_gb), p.id);
        assert(big.breakdown.kv_cache_gb >= small.breakdown.kv_cache_gb, p.id + ' KV must not shrink');
        assert(big.breakdown.compute_buffer_gb > small.breakdown.compute_buffer_gb, p.id + ' compute must grow');
    }
    const installed = await run(['fit', 'fixture:1b', '--ctx', '32768', '--json'], { json: true });
    assert.equal(installed.breakdown.weights_gb, 1);
    assert.equal(installed.breakdown.kv_cache_gb, 1);
    const quant = await run(['fit', 'fixture:1b', '--quant', 'Q8_0', '--ctx', '32768', '--json'], { json: true });
    assert(Math.abs(quant.breakdown.weights_gb - 1e9 * 8.5 / 8 / 1024 ** 3) < 1e-12);
    await run(['fit', 'fixture:1b', '--ctx', '0'], { code: 1 });
    const fitCases = JSON.parse(await readFile(path.join(root, 'tests/e2e/fixtures/fit.json'), 'utf8'));
    for (const c of fitCases) {
        arch = c.arch;
        await run(['models', 'ls', '--json'], { json: true });
        for (const [ctx, bytes] of c.windows) {
            const f = await run(['fit', 'fixture:1b', '--ctx', String(ctx), '--json'], { json: true });
            assert.equal(f.kv_source, 'metadata', c.name);
            assert.equal(f.breakdown.kv_cache_gb, bytes / 1024 ** 3, c.name);
            assert.equal(f.breakdown.compute_buffer_gb, ctx * 4096 / 1024 ** 3);
        }
    }
    arch = baseArch;
    await run(['models', 'ls', '--json'], { json: true });
    await writeFile(path.join(bin, 'system_profiler'), '#!/bin/sh\necho malformed\n', { mode: 0o755 });
    const missing = await run(['settings', 'hardware', '--refresh', '--json'], { json: true, extraEnv });
    assert.equal(missing.memory_bytes, null);
    assert.equal((await run(['fit', 'fixture:1b', '--json'], { json: true })).tier, 'unknown');
    await writeFile(path.join(bin, 'system_profiler'), '#!/bin/sh\ncat <<\'JSON\'\n' + JSON.stringify(profile) + '\nJSON\n', { mode: 0o755 });
    await run(['settings', 'hardware', '--refresh', '--json'], { json: true, extraEnv });
    const scenarios = await run(['bench', 'scenarios', '--json'], { json: true });
    assert.equal(scenarios.length, 9);
    assert.equal(new Set(scenarios.map(s => s.id)).size, 9);
    assert(scenarios.every(s => s.num_ctx >= s.prompt_tokens + s.gen_tokens));
    checkpoint('chat-persistence-and-confirmation');
    await run(['chat', '-m', 'fixture:1b', 'Unicode 🌍 prompt']);
    const conversations = await run(['chat', 'ls', '--json'], { json: true });
    assert.equal(conversations.length, 1);
    const id = conversations[0].id;
    const messages = await run(['chat', 'show', id, '--json'], { json: true });
    assert.equal(messages.length, 2);
    assert.equal(messages[1].thinking, 'Fixture reasoning');
    await run(['chat', '--conversation', id, 'Follow-up']);
    assert.equal((await run(['chat', 'show', id, '--json'], { json: true })).length, 4);
    await run(['chat', 'rename', id, 'Renamed']);
    assert.equal((await run(['chat', 'ls', '--json'], { json: true }))[0].title, 'Renamed');
    await run(['chat', 'rm', id]);
    assert.equal((await run(['chat', 'ls', '--json'], { json: true })).length, 1, 'EOF must decline');
    await run(['chat', 'rm', id, '--yes']);
    assert.deepEqual(await run(['chat', 'show', id, '--json'], { json: true }), []);
    const presets = await run(['settings', 'presets', 'ls', '--json'], { json: true });
    assert.equal(presets.length, 1);
    await run(['settings', 'presets', 'rm', 'default']);
    assert.equal((await run(['settings', 'presets', 'ls', '--json'], { json: true })).length, 1);
    checkpoint('benchmark-export-replay-and-interruption');
    const runs = await run(['bench', 'run', 'fixture:1b', '--repeats', 'fast', '--json'], { json: true });
    assert.equal(runs.length, 9);
    assert(runs.every(r => r.decode_tps_median === null && r.ttft_ms_median !== null), 'unsupported clocks remain unknown');
    const sessions = await run(['bench', 'sessions', '--json'], { json: true });
    const session = sessions.find(s => s.outcome === 'completed');
    assert(session);
    const evidence = await run(['bench', 'export', session.id, '--include-content'], { json: true });
    assert.equal(evidence.attempts.length, 21);
    assert.equal(evidence.session.formula_version, 2);
    const file = path.join(scratch, 'evidence.json');
    await writeFile(file, JSON.stringify(evidence));
    const replay = await run(['bench', 'replay', file], { json: true });
    assert.deepEqual(replay, evidence.derived);
    evidence.derived.attempts = [];
    evidence.derived.scenarios = [];
    await writeFile(file, JSON.stringify(evidence));
    assert.deepEqual(await run(['bench', 'replay', file], { json: true }), replay);
    evidence.session.formula_version = 999;
    await writeFile(file, JSON.stringify(evidence));
    await run(['bench', 'replay', file], { code: 1 });
    await run(['bench', 'ls', '--json'], { json: true });
    await run(['bench', 'top', '--json'], { json: true });
    slow = true;
    await run(['bench', 'run', 'fixture:1b'], { signalWhen: 'warming up' });
    slow = false;
    assert((await run(['bench', 'sessions', '--json'], { json: true })).some(s => s.outcome === 'cancelled'));
    checkpoint('model-download-remove-and-offline-recovery');
    await run(['models', 'pull', 'fixture:extra']);
    assert(models.some(m => m.name === 'fixture:extra'));
    await run(['models', 'pull', 'invalid:latest'], { code: 1 });
    await run(['models', 'rm', 'fixture:extra'], { input: 'no\n' });
    assert(models.some(m => m.name === 'fixture:extra'));
    await run(['models', 'rm', 'fixture:extra', '--yes']);
    assert(!models.some(m => m.name === 'fixture:extra'));
    const count = requests.length;
    offline = true;
    const cached = await run(['models', 'ls', '--json'], { json: true });
    assert(cached.some(m => m.id === 'fixture:1b'));
    const status = await run(['settings', 'server', '--json'], { json: true });
    assert.equal(status.reachable, false);
    assert(!requests.slice(count).some(r => r.route === '/api/generate'), 'read-only status must not generate');
    offline = false;
    checkpoint('storage-confirmation-and-reclamation');
    await mkdir(path.join(store, 'blobs'), { recursive: true });
    await mkdir(path.join(store, 'manifests'), { recursive: true });
    const blob = path.join(store, 'blobs', 'sha256-' + 'a'.repeat(64));
    await writeFile(blob, 'orphan');
    assert.equal((await run(['storage', 'scan', '--json'], { json: true })).orphaned_bytes, 6);
    await run(['storage', 'clean']);
    assert.equal(await readFile(blob, 'utf8'), 'orphan');
    await run(['storage', 'clean', '--yes']);
    assert.equal((await run(['storage', 'scan', '--json'], { json: true })).orphaned_bytes, 0);
    success = true;
    console.log('CLI E2E passed: isolated processes, complete catalog fit, hardware fallback, chat/presets, benchmark JSON/export/replay/Stop, download/offline recovery and deletion confirmation.');
}
finally {
    for (const c of children)
        c.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    const evidence = { step, success, commands, requests };
    const artifact = process.env.ANCHOR_E2E_ARTIFACT_DIR;
    if (artifact) {
        await mkdir(artifact, { recursive: true });
        await writeFile(path.join(artifact, 'cli.json'), JSON.stringify(evidence, null, 2));
    }
    if (success)
        await rm(scratch, { recursive: true, force: true });
    else {
        await writeFile(path.join(scratch, 'evidence.json'), JSON.stringify(evidence, null, 2));
        console.error('CLI failure evidence: ' + scratch);
    }
}
