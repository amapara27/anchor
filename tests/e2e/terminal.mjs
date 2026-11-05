// Shared terminal driver: actual keys, output and resize, never app-state shortcuts.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TerminalScreen } from './terminal-screen.mjs';

export function terminalDriver({ root, scratch, env, commands, children }) {
    const bridge = path.join(scratch, 'pty');
    const flags = process.platform === 'darwin' ? ['-isysroot', execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim()] : ['-lutil'];
    execFileSync('cc', [...flags, '-Wall', '-Wextra', '-O2', path.join(root, 'tests/e2e/pty.c'), '-o', bridge]);
    return function terminal(args = []) {
        const child = spawn(bridge, [path.join(root, 'target/debug/anchor'), ...args], { env: { ...env, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe'] });
        children.add(child);
        let raw = '', stderr = '', done = false;
        const screen = new TerminalScreen();
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', b => { raw += b; screen.feed(b); });
        child.stderr.on('data', b => { stderr += b; });
        const exited = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', code => { done = true; children.delete(child); commands.push({ terminal: true, args, code, stdout: raw, stderr }); resolve(code); });
        });
        const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
        exited.finally(() => clearTimeout(timer));
        const clean = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
        return {
            child, exited,
            get raw() { return raw; },
            get text() { return clean(raw); },
            get screen() { return screen.text; },
            send: text => child.stdin.write(text),
            async escape() {
                child.stdin.write('\x1b');
                // Legacy terminals share Escape's prefix with arrow/Alt keys.
                await new Promise(r => setTimeout(r, 120));
            },
            resize: (rows, cols) => { screen.resize(rows, cols); child.stdin.write(Buffer.from([255, rows >> 8, rows & 255, cols >> 8, cols & 255])); },
            async waitScreen(text) {
                const until = Date.now() + 20000;
                while (!screen.text.includes(text)) {
                    assert(!done && Date.now() < until, `Terminal viewport did not show ${JSON.stringify(text)}\n${screen.text}\n${stderr}`);
                    await new Promise(r => setTimeout(r, 25));
                }
            },
            async waitGone(text) {
                const until = Date.now() + 20000;
                while (screen.text.includes(text)) {
                    assert(!done && Date.now() < until, `Terminal still shows ${JSON.stringify(text)}\n${screen.text}`);
                    await new Promise(r => setTimeout(r, 25));
                }
            },
            async wait(text, from = 0) {
                const until = Date.now() + 20000;
                while (!clean(raw.slice(from)).includes(text)) {
                    assert(!done && Date.now() < until, `Terminal did not show ${JSON.stringify(text)}\n${clean(raw).slice(-6000)}\n${stderr}`);
                    await new Promise(r => setTimeout(r, 25));
                }
            },
            async finish(code = 0) {
                try {
                    assert.equal(await exited, code, clean(raw).slice(-6000));
                    assert.match(stderr, /PTY_RESTORED=1/, 'terminal mode must be restored');
                    if (raw.includes('\x1b[?1049h')) assert(raw.includes('\x1b[?1049l'), 'alternate screen must be restored');
                } finally { clearTimeout(timer); }
            },
            async capture(name) {
                const dir = process.env.ANCHOR_E2E_ARTIFACT_DIR ?? scratch;
                await writeFile(path.join(dir, name + '.ansi'), raw);
                await writeFile(path.join(dir, name + '.txt'), screen.text);
            },
        };
    };
}
