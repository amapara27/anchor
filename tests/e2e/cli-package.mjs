// Release wheel → isolated uv tool installation → executable outside the checkout.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalDriver } from './terminal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    console.error('BLOCKED: anchr wheels currently target macOS Apple Silicon.');
    process.exit(77);
}
const scratch = await mkdtemp(path.join(tmpdir(), 'anchr-wheel-'));
const output = path.join(scratch, 'wheels');
const children = new Set(), commands = [];
let passed = false;
const env = {
    ...process.env,
    UV_TOOL_DIR: path.join(scratch, 'tools'),
    UV_TOOL_BIN_DIR: path.join(scratch, 'bin'),
    HF_HOME: path.join(scratch, 'hf'),
    HF_HUB_CACHE: path.join(scratch, 'hf/hub'),
    ANCHOR_E2E_DATA_DIR: path.join(scratch, 'must-not-use'),
    OLLAMA_HOST: 'http://127.0.0.1:1',
};
const run = (command, args, options = {}) => execFileSync(command, args, {
    cwd: root, env, encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024,
    ...options,
});
try {
    console.log('STEP cli-package.build-wheel');
    const packages = JSON.parse(run('cargo', ['metadata', '--no-deps', '--format-version', '1'])).packages;
    const version = packages.find(p => p.name === 'anchor-cli').version;
    run('uvx', ['--from', 'maturin==1.16.0', 'maturin', 'build', '--release', '--locked',
        '--target', 'aarch64-apple-darwin', '--out', output], { stdio: 'inherit' });
    const wheels = (await readdir(output)).filter(name => name.endsWith('.whl'));
    assert.equal(wheels.length, 1);
    assert(wheels[0].startsWith('anchr-' + version + '-'));
    assert(wheels[0].endsWith('_arm64.whl'));
    const wheel = path.join(output, wheels[0]);
    const metadata = run('unzip', ['-p', wheel, 'anchr-' + version + '.dist-info/METADATA']);
    assert.match(metadata, /^Name: anchr$/m);
    assert(metadata.includes('Version: ' + version));
    assert.doesNotMatch(metadata, /^Requires-Dist:/m);

    console.log('STEP cli-package.install-outside-checkout');
    run('uv', ['tool', 'install', '--no-index', wheel], { cwd: scratch, stdio: 'inherit' });
    const binary = path.join(env.UV_TOOL_BIN_DIR, 'anchor');
    const installedEnv = { ...env, PATH: env.UV_TOOL_BIN_DIR + ':/usr/bin:/bin:/usr/sbin:/sbin' };
    const installed = args => run(binary, args, { cwd: scratch, env: installedEnv });
    assert.equal(installed(['--version']).trim(), 'anchor ' + version);
    assert(installed(['--help']).includes('tui'));
    const paths = JSON.parse(installed(['settings', 'paths', '--json']));
    assert.notEqual(paths.data_dir, env.ANCHOR_E2E_DATA_DIR, 'wheel must contain a production build');
    assert(paths.data_dir.endsWith('/com.anchor.desktop'));
    const scenarios = JSON.parse(installed(['bench', 'scenarios', '--json']));
    assert.equal(scenarios.length, 9);
    const catalog = JSON.parse(installed(['models', 'catalog', '--runtime', 'mlx', '--json']));
    assert(catalog.some(model => model.id === 'mlx-community/gemma-3-270m-it-4bit'));
    assert(catalog.every(model => model.files.length > 0));
    run('uv', ['tool', 'install', '--no-index', '--reinstall', wheel], { cwd: scratch, stdio: 'inherit' });
    assert.equal(installed(['--version']).trim(), 'anchor ' + version);

    console.log('STEP cli-package.installed-terminal');
    const ui = terminalDriver({ root, binary, scratch, env: installedEnv, commands, children })();
    await ui.waitScreen('Type / for commands');
    assert(ui.screen.includes('Anchor v' + version));
    ui.send('/runtime\r');
    await ui.waitScreen('Choose runtime');
    await ui.escape();
    ui.send('/quit\r');
    await ui.finish();

    await mkdir(path.join(root, 'target/wheels'), { recursive: true });
    await copyFile(wheel, path.join(root, 'target/wheels', wheels[0]));
    const report = { package: 'anchr', version, wheel: wheels[0], scenarios: scenarios.length,
        mlxCatalog: catalog.length, productionDataDir: paths.data_dir, terminalRestored: true };
    await writeFile(path.join(process.env.ANCHOR_E2E_ARTIFACT_DIR ?? scratch, 'cli-package.json'),
        JSON.stringify(report, null, 2) + '\n');
    passed = true;
    console.log('CLI wheel passed: metadata, isolated uv install/reinstall, embedded catalogs and terminal restoration.');
} finally {
    for (const child of children) child.kill('SIGTERM');
    if (passed) await rm(scratch, { recursive: true, force: true });
    else console.error('Wheel failure evidence: ' + scratch);
}
