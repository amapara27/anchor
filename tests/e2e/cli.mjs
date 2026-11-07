// Real CLI processes → isolated HTTP server → SQLite/filesystem → exported evidence.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalDriver } from './terminal.mjs';
import { terminalWorkflows } from './terminal-workflows.mjs';
import { terminalEdges } from './terminal-edges.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = await mkdtemp(path.join(tmpdir(), 'anchor-cli-e2e-'));
const store = path.join(scratch, 'models');
const commands = [], requests = [];
const models = [{ name: 'fixture:1b', digest: 'sha256:fixture', size: 1024 ** 3, details: { family: 'llama', parameter_size: '1B', quantization_level: 'Q4_K_M' } }];
let offline = false, slow = false, terminalStream = false, tagsReady = null, resident = null, step = 'startup', success = false;
const baseArch = { architecture: 'llama', block_count: 16, head_count: 32, head_count_kv: 8, key_length: 64, value_length: 64 };
let arch = baseArch;
let chatAnswer = 'Fixture answer';
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
        if (req.url === '/api/tags') {
            if (tagsReady) await tagsReady;
            return json({ models });
        }
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
            if (terminalStream) await new Promise(r => setTimeout(r, 120));
            res.write(JSON.stringify(chat ? { message: { role: 'assistant', content: chatAnswer }, done: false } : { response: 'answer', done: false }) + '\n');
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
const env = { ...process.env, OLLAMA_HOST: 'http://127.0.0.1:' + server.address().port, OLLAMA_MODELS: store, ANCHOR_E2E_DATA_DIR: scratch, HF_HOME: path.join(scratch, 'hf'), HF_HUB_CACHE: path.join(scratch, 'hf/hub') };
const binary = path.join(root, 'target/cli-e2e/debug/anchor');
const children = new Set();
async function run(args, { json = false, input = '', code = 0, signalWhen = null, extraEnv = {}, during = null, signal = 'SIGINT' } = {}) {
    const child = spawn(binary, args, { env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '', sent = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.stdin.end(input);
    let concurrent = Promise.resolve();
    const maybeSignal = () => { if (signalWhen && !sent && (stdout + stderr).includes(signalWhen)) {
        sent = true; concurrent = (async () => { try { if (during) await during(); } finally { child.kill(signal); } })();
        concurrent.catch(() => {});
    } };
    child.stdout.on('data', b => { stdout += b; maybeSignal(); });
    child.stderr.on('data', b => { stderr += b; maybeSignal(); });
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }).finally(() => { clearTimeout(timer); children.delete(child); });
    commands.push({ args, ...result, stdout, stderr });
    await concurrent;
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
    await run(['bench', 'calibrate', '--help']);
    await run(['bench', 'validate', '--help']);
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
    checkpoint('json-presets-regeneration-and-input');
    assert.equal((await run(['settings', 'paths', '--json'], { json: true })).data_dir, scratch);
    assert.equal((await run(['models', 'catalog', '--json'], { json: true })).length, profiles.length);
    const mlxCatalog = await run(['models', 'catalog', '--runtime', 'mlx', '--json'], { json: true });
    assert(mlxCatalog.length > 0 && mlxCatalog.every(m => m.revision.length === 40));
    assert.deepEqual(await run(['models', 'ls', '--runtime', 'mlx', '--json'], { json: true }), []);
    await run(['models', 'pull', 'unknown/model', '--runtime', 'mlx', '--json'], { code: 1 });
    await run(['bench', 'run', 'unknown/model', '--runtime', 'mlx', '--scenario', 'classify', '--json'], { code: 1 });
    await run(['bench', 'run', 'fixture:1b', '--scenario', 'unknown'], { code: 1 });
    await run(['bench', 'top', '--runtime', 'mlx', '--json'], { code: 1 });
    const preset = await run(['settings', 'presets', 'save', 'cli-preset', '--name', 'CLI preset', '--system', 'Answer briefly.', '--temperature', '0.2', '--top-p', '0.8', '--num-ctx', '8192', '--json'], { json: true });
    assert.equal(preset.num_ctx, 8192);
    await run(['settings', 'presets', 'save', 'cli-preset', '--num-ctx', '0'], { code: 1 });
    await run(['settings', 'presets', 'save', 'cli-preset', '--temperature', 'NaN'], { code: 1 });
    await run(['settings', 'presets', 'save', 'cli-preset', '--top-p', '2'], { code: 1 });
    const edited = await run(['settings', 'presets', 'save', 'cli-preset', '--name', 'Edited', '--clear', 'temperature', '--json'], { json: true });
    assert.equal(edited.temperature, null); assert.equal(edited.system, 'Answer briefly.');
    await run(['chat', '-m', 'fixture:1b', '--json'], { code: 1 });
    const answer = await run(['chat', '-m', 'fixture:1b', '--preset', 'cli-preset', '--stdin', '--json'], { json: true, input: 'Multiline\nprompt 🌍' });
    assert.equal(answer.result.response, 'Fixture answer');
    assert.equal(answer.result.thinking, 'Fixture reasoning');
    const chatId = answer.conversation_id;
    let wire = requests.filter(r => r.route === '/api/chat').at(-1).body;
    assert.equal(wire.options.num_ctx, 8192); assert.equal(wire.options.top_p, Math.fround(0.8));
    assert.equal(wire.messages[0].role, 'system'); assert.equal(wire.messages[0].content, 'Answer briefly.');
    await run(['chat', '--conversation', chatId, '--preset', 'default', 'Continue', '--json'], { json: true });
    wire = requests.filter(r => r.route === '/api/chat').at(-1).body;
    assert(!wire.messages.some(m => m.role === 'system'), 'continued preset must actually change');
    await run(['chat', 'preset', chatId, 'cli-preset', '--json'], { json: true });
    const before = await run(['chat', 'show', chatId, '--json'], { json: true });
    await run(['chat', 'regenerate', chatId, '--json'], { json: true });
    const regenerated = await run(['chat', 'show', chatId, '--json'], { json: true });
    assert.equal(regenerated.length, before.length); assert.equal(regenerated.at(-2).content, 'Continue');
    assert.equal(regenerated[0].id, before[0].id, 'regeneration must preserve earlier turns');
    const promptFile = path.join(scratch, 'prompt.txt'); await writeFile(promptFile, 'File prompt 🌍');
    await run(['chat', '--conversation', chatId, '--file', promptFile, '--json'], { json: true });
    await run(['chat', 'preset', chatId, 'missing'], { code: 1 });
    const humanCompare = await run(['models', 'compare', 'fixture:1b', 'fixture:1b', 'Compare']);
    assert.match(humanCompare, /256 tokens · 512.0 tok\/s.*TTFT [0-9.]+ ms/);
    await run(['models', 'compare', 'fixture:1b', 'fixture:1b', '--file', promptFile, '--json'], { json: true });
    const failedCompare = await run(['models', 'compare', 'invalid:latest', 'fixture:1b', 'Compare', '--json'], { json: true, code: 1 });
    assert(failedCompare.some(r => r.kind === 'failed') && failedCompare.some(r => r.kind === 'result'));
    slow = true;
    terminalStream = true;
    await run(['chat', '--conversation', chatId, 'Stop this'], { signalWhen: 'Fixture answer', code: 130, during: async () => {
        const refused = await run(['bench', 'run', 'fixture:1b', '--scenario', 'classify', '--json'], { code: 1 });
        assert.equal(refused, '');
        await run(['chat', 'ls', '--json'], { json: true });
        await run(['models', 'unload', 'fixture:1b', '--json'], { code: 1 });
    } });
    assert.equal((await run(['chat', 'show', chatId, '--json'], { json: true })).at(-1).role, 'assistant');
    await run(['chat', '--conversation', chatId, 'Crash owner'], { signalWhen: 'Fixture answer', signal: 'SIGKILL', code: null });
    await run(['chat', '-m', 'fixture:1b', 'After crash', '--json'], { json: true });
    await run(['models', 'compare', 'fixture:1b', 'fixture:1b', 'Stop comparison', '--json'], { signalWhen: 'loading', code: 130, json: true });
    const sql = statement => execFileSync('sqlite3', [path.join(scratch, 'registry.db'), statement]);
    sql("CREATE TRIGGER reject_assistant BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END;");
    await run(['chat', '-m', 'fixture:1b', 'Save failure', '--json'], { code: 1 });
    sql('DROP TRIGGER reject_assistant;');
    await run(['settings', 'presets', 'rm', 'cli-preset', '--yes', '--json'], { json: true });
    slow = false;
    checkpoint('benchmark-export-replay-and-interruption');
    const runs = await run(['bench', 'run', 'fixture:1b', '--repeats', 'fast', '--json'], { json: true });
    assert.equal(runs.length, 9);
    assert(runs.every(r => r.decode_tps_median === null && r.ttft_ms_median !== null), 'unsupported clocks remain unknown');
    const one = await run(['bench', 'run', 'fixture:1b', '--scenario', 'classify', '--repeats', 'fast', '--json'], { json: true });
    assert.equal(one.length, 1); assert.equal(one[0].prompt_id, 'classify');
    await run(['bench', 'samples', one[0].id, '--json'], { json: true });
    const sessions = await run(['bench', 'sessions', '--json'], { json: true });
    const session = sessions.find(s => s.outcome === 'completed' && s.planned_attempts === 21);
    assert(session.protocol);
    const report = await run(['bench', 'report', session.id, '--json'], { json: true });
    assert.equal(report.session.id, session.id);
    assert(report.session.config.attempts.every(a => !('request' in a) && !('prompt' in a)), 'report must not bypass content export consent');
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
    await run(['bench', 'run', 'fixture:1b'], { signalWhen: 'warming up', code: 130 });
    slow = false;
    assert((await run(['bench', 'sessions', '--json'], { json: true })).some(s => s.outcome === 'cancelled'));
    checkpoint('model-download-remove-and-offline-recovery');
    await run(['models', 'pull', 'fixture:extra', '--json'], { json: true });
    assert(models.some(m => m.name === 'fixture:extra'));
    await run(['models', 'pull', 'invalid:latest'], { code: 1 });
    await run(['models', 'rm', 'fixture:extra'], { input: 'no\n' });
    assert(models.some(m => m.name === 'fixture:extra'));
    await run(['models', 'rm', 'fixture:extra', '--yes', '--json'], { json: true });
    assert(!models.some(m => m.name === 'fixture:extra'));
    const count = requests.length;
    offline = true;
    const cached = await run(['models', 'ls', '--json'], { json: true });
    assert(cached.some(m => m.id === 'fixture:1b'));
    const readCount = requests.length;
    await run(['bench', 'ls', '--model', 'fixture:1b', '--json'], { json: true });
    await run(['bench', 'top', '--model', 'fixture:1b', '--json'], { json: true });
    await run(['bench', 'samples', '--model', 'fixture:1b', '--json'], { json: true });
    await run(['bench', 'report', session.id, '--json'], { json: true });
    assert.equal(requests.length, readCount, 'saved benchmark inspection must not contact the runtime');
    await run(['models', 'ps', '--json'], { code: 1 });
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
    await run(['storage', 'clean', '--yes', '--json'], { json: true });
    assert.equal((await run(['storage', 'scan', '--json'], { json: true })).orphaned_bytes, 0);
    checkpoint('terminal-progress');
    const terminal = terminalDriver({ root, binary, scratch, env, commands, children });
    slow = true;
    const progress = terminal(['bench', 'run', 'fixture:1b', '--scenario', 'classify', '--repeats', 'fast']);
    await progress.wait('chunks/s');
    await progress.wait('completed classify');
    await progress.finish();
    assert.match(progress.raw, /chunks\/s\r\x1b\[2K(?:Completed repeat|completed)/, 'clear live output before the next permanent status');
    assert(!/chunks\/s(?:completed|repeat|\d\/\d)/.test(progress.raw), 'progress and statuses must not join without a terminal clear');
    await progress.capture('terminal-progress');
    slow = false;
    terminalStream = false;
    checkpoint('terminal-picker');
    for (let i = 0; i < 80; i++) models.push({ ...models[0], name: 'picker:' + String(i).padStart(3, '0') });
    for (let i = 0; i < 100; i++) sql(`INSERT INTO library_models VALUES ('library-${String(i).padStart(3, '0')}', 'fixture library', '[]', '["1b"]', 1, 1, 'today', ${Date.now()});`);
    const picker = terminal();
    await picker.waitScreen('Type / for commands');
    assert.match(picker.screen, /\[Ollama\]\s+MLX\s+\/runtime/);
    picker.send('/model\r');
    await picker.waitScreen('Choose a model  1/');
    picker.send('picker:');
    await picker.waitScreen('Choose a model  1/80');
    picker.send('\x1b[6~');
    // Page Down moves one visible page: 18 rows between the header and the ruled prompt at 30 rows.
    await picker.waitScreen('Choose a model  19/80');
    picker.send('\x1b[F\r');
    await picker.waitScreen('Selected picker:079');
    await picker.waitScreen('Type / for commands');
    picker.send('/model\r');
    await picker.waitScreen('Choose a model  1/');
    picker.send('picker:042');
    await picker.waitScreen('Choose a model  1/1');
    picker.resize(18, 60);
    await picker.waitScreen('Choose a model  1/1');
    assert(picker.screen.includes('Enter select · PgUp/Dn · Esc back · /'));
    await picker.capture('terminal-picker-60');
    picker.resize(30, 100);
    await picker.waitScreen('Choose a model  1/1');
    await picker.capture('terminal-picker-100');
    picker.send('\r');
    await picker.waitScreen('Selected picker:042');
    picker.send('/results\r');
    await picker.waitScreen('last measured');
    picker.send('/library\r');
    await picker.waitScreen('Library  1/100');
    picker.send('library-099');
    await picker.waitScreen('Library  1/1');
    await picker.capture('terminal-library-paging');
    picker.send('\x12');
    await picker.waitScreen('Choose runtime');
    picker.send('\x1b[B\r');
    await picker.waitScreen('Active runtime: MLX');
    picker.send('\x03');
    await picker.waitScreen('Press Ctrl-C again to exit');
    picker.send('\x03');
    await picker.finish();
    checkpoint('terminal-slash-navigation');
    const nav = terminal(['tui']);
    await nav.waitScreen('Type / for commands');
    nav.send('/');
    await nav.waitScreen('Slash commands');
    nav.send('res\t');
    await nav.waitScreen('› /results');
    nav.send('\r');
    await nav.waitScreen('last measured');
    nav.send('/mod');
    await nav.waitScreen('/models');
    nav.send('\x1b[B\r');
    await nav.waitScreen('picker:000');
    nav.send('/help\r');
    await nav.waitScreen('Keyboard controls');
    await nav.escape();
    await nav.waitScreen('Installed  1/');
    nav.send('/zzzz\r');
    await nav.waitScreen('Unknown command');
    await nav.escape();
    await nav.waitScreen('Type to filter');
    nav.send('/runtime mlx\r');
    await nav.waitScreen('Active runtime: MLX');
    assert.match(nav.screen, /Ollama\s+\[MLX\]/);
    nav.send('/model\r');
    await nav.waitScreen('No models here.');
    await nav.capture('terminal-slash-menu');
    nav.send('/quit\r');
    await nav.finish();
    checkpoint('terminal-action-focus-transitions');
    const focus = terminal();
    await focus.waitScreen('Type / for commands');
    let releaseTags;
    tagsReady = new Promise(resolve => { releaseTags = resolve; });
    try {
        focus.send('/models\r');
        await focus.waitScreen('Loading…');
        focus.send('\r\t/');
        await focus.waitScreen('Slash commands');
        await focus.waitScreen('Loading…');
        assert(!focus.screen.includes('Choose a row first'));
        await focus.escape();
    } finally {
        releaseTags();
        tagsReady = null;
    }
    await focus.waitScreen('Installed  1/');
    focus.send('picker:042\x1b[Z\x12');
    await focus.waitScreen('Choose runtime');
    await focus.escape();
    await focus.waitScreen('Filter  picker:042');
    await focus.waitGone('Actions ·');
    focus.send('\x1b[Z\x12');
    await focus.waitScreen('Choose runtime');
    focus.send('\x1b[B\r');
    await focus.waitScreen('Active runtime: MLX');
    focus.send('/runtime ollama\r');
    await focus.waitScreen('Active runtime: Ollama');
    focus.send('\x1b[Z/library\r');
    await focus.waitScreen('Library  1/100');
    focus.send('/models\r');
    await focus.waitScreen('Installed  1/' + models.length);
    focus.send('\x1b[Z/results\r');
    await focus.waitScreen('last measured');
    await focus.capture('terminal-focus-transitions');
    focus.send('/quit\r');
    await focus.finish();
    const benchColumns = String(sql("SELECT name FROM pragma_table_info('bench_runs')")).trim().split('\n');
    const legacyFields = { id: "'legacy-fixture|v4'", suite_version: '4', prompt_id: "'short'", updated_at: '1', prefill_tps_median: 'NULL', ttft_ms_median: 'NULL' };
    sql(`INSERT INTO bench_runs (${benchColumns.join(',')})
        SELECT ${benchColumns.map(column => legacyFields[column] ?? column).join(',')}
        FROM bench_runs ORDER BY updated_at DESC LIMIT 1`);
    await terminalWorkflows({ terminal, scratch, run, requests, models, checkpoint, setStream: value => { slow = value; terminalStream = value; } });
    await terminalEdges({ terminal, scratch, run, requests, models, checkpoint,
        setStream: value => { slow = value; terminalStream = value; }, setOffline: value => { offline = value; }, setAnswer: value => { chatAnswer = value; } });
    await run([], { code: 1 });
    await run(['--json'], { code: 1 });
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
