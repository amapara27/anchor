// Actual keyboard workspace → existing CLI operations → real engine/GPU → evidence.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { terminalDriver } from './terminal.mjs';
export async function terminalLive({ root, scratch, env, commands, children, runtime, model, run, checkpoint }) {
    checkpoint('terminal-real-benchmark-results-and-stop');
    const ui = terminalDriver({ root, scratch, env, commands, children })();
    const slash = async name => {
        ui.send('/' + name); await ui.waitScreen('┌ Commands '); ui.send('\r');
        if (name !== 'quit') await ui.waitGone('┌ Commands ');
    };
    await ui.waitScreen('Anchor');
    if (runtime === 'mlx') { ui.send('\x12'); await ui.waitScreen('MLX'); }
    await ui.waitScreen('Models  1/');
    ui.send(model.split('/').at(-1) + '\r');
    await ui.waitScreen('Selected ' + model);
    if (runtime === 'mlx') {
        await slash('library'); await ui.waitScreen('Ready');
        ui.send(model.split('/').at(-1)); await ui.waitScreen('Models  1/1');
        ui.send('\t\t\t\r');
    } else {
        ui.send('\t\t\t\t\t\r');
    }
    await ui.waitScreen('Completed Download model');
    await slash('bench'); await ui.waitScreen('Run benchmark');
    ui.send('\t\r'); await ui.waitScreen('Choose Workload');
    ui.send('classify\r'); await ui.waitScreen('Workload: classify');
    ui.send('\t\t\r'); await ui.waitScreen('Ctrl-C stop');
    await slash('models'); await ui.waitScreen('Models  1/');
    await ui.waitScreen('Completed Run benchmark');
    await slash('leaderboard'); await ui.waitScreen('Leaderboard workload');
    ui.send('\r'); await ui.waitScreen('Choose Workload');
    ui.send('classify\r'); await ui.waitScreen('Workload: classify');
    ui.send('\t\r'); await ui.waitScreen('Runtime-reported rates');
    assert(ui.screen.includes('classify'));
    assert(ui.screen.includes('TTFT'));
    if (runtime === 'mlx') assert(ui.screen.includes('Group 1'), 'MLX rows stay inside compatible groups');
    await ui.capture('terminal-live-' + runtime + '-leaderboard');
    await slash('results'); await ui.waitScreen('saved measurements');
    ui.send('\r'); await ui.waitScreen('Measured workloads'); await ui.waitScreen('TTFT');
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
