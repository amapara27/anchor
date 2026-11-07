// Actual keyboard workspace → existing CLI operations → real engine/GPU → evidence.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { terminalDriver } from './terminal.mjs';
export async function terminalLive({ root, binary, scratch, env, commands, children, runtime, model, run, checkpoint }) {
    checkpoint('terminal-real-benchmark-results-and-stop');
    const ui = terminalDriver({ root, binary, scratch, env, commands, children })();
    const slash = async name => {
        ui.send('/' + name); await ui.waitScreen('Slash commands'); ui.send('\r');
        if (name !== 'quit') await ui.waitGone('Slash commands');
    };
    await ui.waitScreen('Type / for commands');
    assert.match(ui.screen, /\[Ollama\]\s+MLX\s+\/runtime/);
    if (runtime === 'mlx') {
        await slash('runtime');
        await ui.waitScreen('Choose runtime');
        ui.send('\x1b[B\r');
        await ui.waitScreen('Active runtime: MLX');
    }
    await slash('models');
    await ui.waitScreen('Installed  1/');
    ui.send(model.split('/').at(-1) + '\r');
    await ui.waitScreen('Selected ' + model);
    if (runtime === 'mlx') {
        await slash('library'); await ui.waitScreen('Library  1/');
        assert(!ui.screen.includes('Ctrl-L retries'), ui.screen);
        ui.send(model.split('/').at(-1)); await ui.waitScreen('Library  1/1');
        ui.send('\t\t\t\r');
    } else {
        ui.send('\t\t\t\t\t\r');
    }
    await ui.waitScreen('Model files will use local disk space');
    ui.send('\x1b[C\r');
    await ui.waitScreen('Completed Download model');
    await slash('bench'); await ui.waitScreen('Run benchmark');
    ui.send('\t\r'); await ui.waitScreen('Choose Workload');
    ui.send('classify\r'); await ui.waitScreen('Workload: classify');
    ui.send('\t\t\r'); await ui.waitScreen('Ctrl-C stop');
    await slash('models'); await ui.waitScreen('Installed  1/');
    await ui.waitScreen('Completed Run benchmark');
    await slash('activity');
    await ui.waitScreen('1 workload measured · ' + (runtime === 'mlx' ? 'MLX' : 'Ollama'));
    await ui.waitScreen('Post-first-token decode');
    await slash('leaderboard'); await ui.waitScreen('Leaderboard workload');
    ui.send('\r'); await ui.waitScreen('Choose Workload');
    ui.send('classify\r'); await ui.waitScreen('Workload: classify');
    ui.send('\t\r'); await ui.waitScreen('Runtime-reported rates');
    assert(ui.screen.includes('classify'));
    assert(ui.screen.includes('TTFT'));
    if (runtime === 'mlx') assert(ui.screen.includes('Group 1'), 'MLX rows stay inside compatible groups');
    await ui.capture('terminal-live-' + runtime + '-leaderboard');
    await slash('results'); await ui.waitScreen('last measured');
    ui.send('\r'); await ui.waitScreen('Measured workloads'); await ui.waitScreen('TTFT ms');
    await ui.waitScreen('Run 1');
    assert.match(ui.screen, /› classify\s+1024\s+\d+\.\d\s+\d+\.\d$/m);
    ui.send('\r'); await ui.waitScreen('Measurement report');
    await ui.waitScreen('classify · 3/3 repeats');
    if (runtime === 'mlx') await ui.waitScreen('MLX boundary checks: Passed');
    assert.match(ui.screen, /decode \d+\.\d tok\/s · TTFT \d+\.\d ms/);
    assert.doesNotMatch(ui.screen, /"decode_tps_median"|"attempts"/);
    await ui.capture('terminal-live-' + runtime + '-saved-report');
    await ui.escape(); await ui.waitScreen('Measured workloads'); await ui.waitScreen('TTFT');
    ui.send('\t\t\t\r'); await ui.waitScreen('Export evidence');
    const file = path.join(scratch, 'terminal-live-evidence.json');
    ui.send('\x15' + file + '\t\r'); await ui.waitScreen('Evidence saved to');
    const evidence = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(evidence.session.outcome, 'completed');
    assert.equal(evidence.session.formula_version, 2);
    assert.equal(evidence.session.config.protocol.startsWith('mlx_'), runtime === 'mlx');
    assert.deepEqual(await run(['bench', 'replay', file]), evidence.derived);
    if (runtime === 'ollama') {
        await slash('validate'); await ui.waitScreen('Validate measurements');
        ui.send('\t\r'); await ui.waitScreen('Completed Validate measurements');
    }
    await slash('bench'); await ui.waitScreen('Run benchmark');
    ui.send('\t\t\t\r'); await ui.waitScreen('Ctrl-C stop');
    ui.send('\x03'); await ui.waitScreen('Stopped;');
    assert((await run(['bench', 'sessions', '--runtime', runtime, '--json'])).some(s => s.outcome === 'cancelled'));
    await slash('quit'); await ui.finish();
}
