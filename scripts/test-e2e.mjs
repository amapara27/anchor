#!/usr/bin/env node
// One entry point; real user flows stay in their existing browser/native/Rust drivers.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, open, readFile, writeFile, unlink } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let profile = 'full', surface = 'all', only = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile')
        profile = args[++i];
    else if (args[i] === '--surface')
        surface = args[++i];
    else if (args[i] === '--only') {
        const value = args[++i];
        if (!value || value.startsWith('--')) {
            console.error('--only requires a comma-separated stage list');
            process.exit(2);
        }
        only = value.split(',');
    }
    else if (args[i] === '--list')
        only = [];
    else if (args[i] === '--help') {
        console.log('Usage: pnpm test:e2e [--profile full|fixtures|ci] [--surface all|cli] [--only stage,...] [--list]\nDefault full covers GUI and CLI. --surface cli omits desktop compilation, browser and WindowServer.\nFull runs actual Apple GPU inference and downloads two small models into disposable caches.\nfixtures omits live engines; ci also omits macOS WindowServer. No credentials/signing/publication.');
        process.exit(0);
    }
    else {
        console.error('Unknown argument: ' + args[i]);
        process.exit(2);
    }
}
if (!['all', 'cli'].includes(surface)) { console.error('Choose surface all or cli'); process.exit(2); }
if (!['full', 'fixtures', 'ci'].includes(profile)) {
    console.error('Choose full, fixtures or ci');
    process.exit(2);
}
const pnpm = ['pnpm', '--filter', '@anchor/desktop'];
const stages = [
    { id: 'harness', title: 'Runner failure reports, blocked prerequisites, rerun commands and interruption cleanup', commands: [['node', 'tests/e2e/runner.mjs']], tools: ['node'], sources: ['scripts/test-e2e.mjs', 'tests/e2e/runner.mjs'], minutes: 2 },
    { id: 'build', title: 'Typecheck, frontend build and production Rust compilation', commands: [[...pnpm, 'build'], ['cargo', 'build', '--workspace', '--locked']], tools: ['pnpm', 'cargo'], sources: ['apps/desktop/src', 'crates', 'apps/desktop/src-tauri'], minutes: 15 },
    { id: 'state', title: 'SQLite migration/reopen, library/cache identity and safe storage reclamation', commands: [['cargo', 'test', '--locked', '-p', 'anchor-hub', '--test', 'persistence_e2e', '--test', 'application_state_e2e', '--', '--nocapture']], tools: ['cargo'], sources: ['crates/anchor-hub/src/db.rs', 'crates/anchor-hub/src/storage.rs', 'crates/anchor-hub/src/library.rs', 'crates/anchor-hub/src/server.rs'], minutes: 5 },
    { id: 'measurements', title: 'HTTP streaming → benchmark evidence → SQLite → offline replay', commands: [['cargo', 'test', '--locked', '-p', 'anchor-hub', '--test', 'measurements_e2e', '--', '--nocapture']], tools: ['cargo'], sources: ['crates/anchor-hub/src/ollama.rs', 'crates/anchor-hub/src/bench', 'crates/anchor-hub/tests/measurements_e2e.rs'], minutes: 8 },
    { id: 'cli-build', title: 'Production CLI compilation without the desktop or webview', commands: [['cargo', 'build', '--locked', '-p', 'anchor-cli']], tools: ['cargo'], sources: ['crates/anchor-cli', 'crates/anchor-hub'], minutes: 10 },
    { id: 'cli', title: 'Actual CLI processes, fit catalog, hardware fallback, chat, benchmarks and storage', commands: [['cargo', 'build', '--locked', '-p', 'anchor-cli', '--features', 'e2e'], ['node', 'tests/e2e/cli.mjs']], tools: ['cargo', 'node', 'sqlite3'], sources: ['crates/anchor-cli/src', 'crates/anchor-core/src/fit.rs', 'crates/anchor-system/src', 'tests/e2e/cli.mjs', 'crates/anchor-hub/src/chat.rs'], minutes: 10, build: 'cli-build' },
    { id: 'browser', title: 'React workflows, recovery, keyboard and responsive/light/dark layouts', commands: [[...pnpm, 'test:e2e:browser']], tools: ['pnpm'], sources: ['apps/desktop/src/components', 'apps/desktop/src/lib', 'apps/desktop/e2e/anchor.spec.ts'], minutes: 8, build: true },
    { id: 'native', title: 'WKWebView → real IPC/Rust/SQLite, permissions, persistence and cancellation', commands: [[...pnpm, 'test:e2e:native']], tools: ['pnpm', 'cargo', 'sqlite3'], sources: ['apps/desktop/src-tauri/src/lib.rs', 'apps/desktop/e2e/native.mjs', 'apps/desktop/src/lib', 'crates/anchor-hub/src/chat.rs'], minutes: 15, mac: true, build: true },
    { id: 'discovery', title: 'Published Ollama library/tags → ranged GGUF → persisted architecture cache', commands: [['cargo', 'test', '--locked', '-p', 'anchor-hub', '--test', 'network_catalog_e2e', '--', '--ignored', '--nocapture']], tools: ['cargo'], sources: ['crates/anchor-hub/src/library.rs', 'crates/anchor-hub/src/gguf.rs', 'crates/anchor-hub/src/lib.rs', 'crates/anchor-hub/tests/network_catalog_e2e.rs'], minutes: 5, network: true },
    { id: 'ollama', title: 'Isolated installed Ollama → real generations, validation and evidence replay', commands: [['node', 'tests/e2e/ollama.mjs']], tools: ['ollama', 'cargo', 'node'], sources: ['crates/anchor-hub/src/bench/calibration.rs', 'crates/anchor-hub/src/bench/evidence.rs', 'crates/anchor-hub/tests/ollama_decode_e2e.rs'], minutes: 20, mac: true, gpu: true, build: true },
    { id: 'mlx', title: 'Clean model download/cancel/retry → native GUI → all nine MLX workloads/Stop', commands: [[...pnpm, 'test:e2e:native']], tools: ['pnpm', 'cargo', 'uv', 'sqlite3'], sources: ['workers/mlx/download.py', 'workers/mlx/suite.py', 'crates/anchor-hub/src/bench/mlx_catalog.rs', 'crates/anchor-hub/src/bench/mlx_suite.rs', 'apps/desktop/src/lib/useMlxModels.ts'], minutes: 20, mac: true, gpu: true, build: true },
    ...['ollama', 'mlx'].map(runtime => ({ id: 'cli-' + runtime, title: 'Real CLI ' + runtime + ' download/cancel/retry, GPU suite, history and replay', commands: [['node', 'tests/e2e/cli-live.mjs', runtime]], tools: ['node', 'cargo', runtime === 'mlx' ? 'uv' : 'ollama'], sources: ['crates/anchor-cli/src', 'crates/anchor-hub/src/bench', 'tests/e2e/cli-live.mjs'], minutes: 25, mac: true, gpu: true, build: 'cli-build' })),
    { id: 'release', title: 'Real release script safe refusal and updater public configuration', commands: [['node', 'tests/e2e/release.mjs']], tools: ['node', 'bash'], sources: ['scripts/release-macos.sh', 'apps/desktop/src-tauri/tauri.conf.json', 'apps/desktop/src/components/UpdateBanner.tsx'], minutes: 1 },
];
const ids = new Set(stages.map(s => s.id));
if (only?.some(id => !ids.has(id))) {
    console.error('Unknown stage. Valid stages: ' + [...ids].join(', '));
    process.exit(2);
}
if (only?.length === 0) {
    for (const s of stages)
        console.log(s.id.padEnd(15) + s.title);
    process.exit(0);
}
const cliStages = new Set(['harness', 'cli-build', 'state', 'measurements', 'cli', 'discovery', 'cli-ollama', 'cli-mlx']);
const chosen = new Set(only ?? stages.filter(s => (surface === 'all' || cliStages.has(s.id)) && (profile === 'full' || (!s.gpu && !s.network && (profile !== 'ci' || !s.mac)))).map(s => s.id));
for (const s of stages) if (chosen.has(s.id) && s.build) chosen.add(s.build === true ? 'build' : s.build);
const id = new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + process.pid;
const dir = path.join(root, '.internal/testing', id);
await mkdir(dir, { recursive: true });
const lock = path.join(root, '.internal/testing/active.lock');
try {
    const handle = await open(lock, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, run: id }));
    await handle.close();
}
catch (error) {
    if (error.code !== 'EEXIST')
        throw error;
    const reason = 'Another test run owns ' + lock + '; wait for it, or verify its PID has exited before removing a stale lock.';
    await writeFile(path.join(dir, 'report.json'), JSON.stringify({ version: 1, id, status: 'blocked', surface, scope: only ? 'selected' : surface === 'cli' ? 'cli-' + profile : profile, reason, owner: await readFile(lock, 'utf8') }, null, 2));
    console.error('BLOCKED: ' + reason + '\nReport: ' + path.join(dir, 'report.json'));
    process.exit(2);
}
process.on('exit', () => { try {
    if (JSON.parse(readFileSync(lock, 'utf8')).pid === process.pid)
        unlinkSync(lock);
}
catch { } });
const report = { version: 1, id, startedAt: new Date().toISOString(), profile, surface, scope: only ? 'selected' : surface === 'cli' ? 'cli-' + profile : profile, status: 'running', platform: process.platform, arch: process.arch, commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim(), worktree: spawnSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).stdout?.trim(), manualLimits: ['Real signing/notarization, Gatekeeper on a clean Mac and in-place update installation require release credentials/artifacts.', 'Native file/save dialogs, external browser/share handoffs and macOS permission prompts need bounded human review.', 'Functional generations do not establish answer quality, cross-runtime equivalence or measurement overhead.'], stages: stages.map(s => ({ id: s.id, title: s.title, status: chosen.has(s.id) ? 'pending' : 'not_requested', sources: s.sources, rerun: `pnpm test:e2e --profile ${profile} --surface ${surface} --only ${s.id}`, commands: s.commands })) };
const persist = async () => {
    const json = JSON.stringify(report, null, 2) + '\n';
    await writeFile(path.join(dir, 'report.json'), json);
    await writeFile(path.join(root, '.internal/testing/latest.json'), json);
};
await persist();
console.log(`E2E ${report.scope}: ${[...chosen].join(', ')}\nReport: ${path.join(dir, 'report.json')}`);
let active = null, interrupted = false;
function terminate(child) {
    if (!child) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, 1500).unref();
}
for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => { interrupted = true; terminate(active); });
const exists = tool => spawnSync(tool, ['--version'], { cwd: root, stdio: 'ignore', timeout: 10000 }).status === 0;
const portFree = port => new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});
async function command(argv, stage, log) {
    const environment = { ...process.env, CI: 'true', ANCHOR_E2E_ARTIFACT_DIR: dir, ANCHOR_E2E_EXPORT_DIR: dir };
    // Full/targeted modes must not silently inherit a previously imported checkpoint.
    delete environment.ANCHOR_MLX_E2E_MODEL;
    delete environment.ANCHOR_MLX_DOWNLOAD_E2E;
    if (stage.id === 'mlx')
        environment.ANCHOR_MLX_DOWNLOAD_E2E = '1';
    const child = spawn(argv[0], argv.slice(1), { cwd: root, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    active = child;
    let last = 'Starting ' + argv.join(' '), timedOut = false, launchError = null;
    const output = b => {
        const text = b.toString();
        log.push(text);
        process.stdout.write(text);
        const lines = text.trim().split('\n');
        if (lines.at(-1)) last = lines.at(-1);
    };
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    const heartbeat = setInterval(() => console.log(`[${stage.id}] still running: ${last.slice(-200)}`), 20000);
    const timer = setTimeout(() => { timedOut = true; terminate(child); }, stage.minutes * 60000);
    const result = await new Promise(resolve => { child.once('error', error => { launchError = error.message; resolve({ code: null, signal: null }); }); child.once('close', (code, signal) => resolve({ code, signal })); });
    clearInterval(heartbeat);
    clearTimeout(timer);
    active = null;
    return { ...result, timedOut, launchError, lastOutput: last };
}
try {
    for (const stage of stages) {
        const row = report.stages.find(r => r.id === stage.id);
        if (!chosen.has(stage.id))
            continue;
        row.startedAt = new Date().toISOString();
        row.log = path.join(dir, stage.id + '.log');
        const missing = stage.tools.filter(t => !exists(t));
        const port = stage.id === 'browser' ? 1420 : ['native', 'mlx'].includes(stage.id) ? 4445 : null;
        if (interrupted) {
            row.status = 'blocked';
            row.reason = 'Run interrupted';
        }
        else if (stage.mac && process.platform !== 'darwin') {
            row.status = 'blocked';
            row.reason = 'Requires macOS WindowServer/native runtime';
        }
        else if (stage.gpu && process.arch !== 'arm64') {
            row.status = 'blocked';
            row.reason = 'Requires Apple Silicon';
        }
        else if (stage.build && report.stages.find(r => r.id === (stage.build === true ? 'build' : stage.build)).status !== 'passed') {
            row.status = 'blocked';
            row.reason = 'Build did not pass';
        }
        else if (missing.length) {
            row.status = 'blocked';
            row.reason = 'Missing prerequisite: ' + missing.join(', ');
        }
        else if (port && !await portFree(port)) {
            row.status = 'blocked';
            row.reason = `Port ${port} is occupied; do not attach to or kill an unknown app/server`;
        }
        else {
            console.log(`\nRUN ${stage.id}: ${stage.title}`);
            row.status = 'running';
            await persist();
            const log = [];
            row.results = [];
            for (const argv of stage.commands) {
                const r = await command(argv, stage, log);
                row.results.push({ argv, ...r });
                if (r.code !== 0 || r.timedOut || interrupted)
                    break;
            }
            await writeFile(row.log, log.join(''));
            row.status = row.results.every(r => r.code === 0 && !r.timedOut) && !interrupted ? 'passed' : interrupted || row.results.at(-1).code === 77 ? 'blocked' : 'failed';
            if (row.status !== 'passed')
                row.reason = row.results.at(-1).launchError ?? row.results.at(-1).lastOutput;
        }
        row.finishedAt = new Date().toISOString();
        console.log(`${row.status.toUpperCase()} ${stage.id}${row.reason ? ': ' + row.reason : ''}`);
        await persist();
    }
}
finally {
    terminate(active);
    report.finishedAt = new Date().toISOString();
    const selected = report.stages.filter(r => chosen.has(r.id));
    report.status = selected.some(r => r.status === 'failed') ? 'failed' : selected.some(r => r.status !== 'passed') ? 'blocked' : report.scope === 'full' ? 'passed' : 'passed-' + report.scope;
    report.nextActions = selected.filter(r => r.status !== 'passed').map(r => ({ stage: r.id, status: r.status, reason: r.reason, log: r.log, sources: r.sources, rerun: r.rerun }));
    await persist();
    await unlink(lock);
    await writeFile(path.join(dir, 'NEXT.md'), `# Agent repair loop\n\nRead docs/testing.md and report.json. Fix product code or the isolated fixture's fidelity; preserve assertions. Rerun the failing stage, then the original scope. Do not auto-retry a failed run into a green result, widen runtime claims, delete user data, sign, publish or inspect credentials. Ask only for an unavailable external prerequisite, a product decision, or a destructive/credentialed action.\n\n${report.nextActions.map(a => `- ${a.stage}: ${a.status}; ${a.reason}\n  Log: ${a.log}\n  Sources: ${a.sources.join(', ')}\n  Rerun: ${a.rerun}`).join('\n')}\n`);
    console.log(`\n${report.status.toUpperCase()} (${report.scope}) — ${path.join(dir, 'report.json')}`);
    process.exitCode = interrupted ? 130 : report.status === 'failed' ? 1 : report.status === 'blocked' ? 2 : 0;
}
