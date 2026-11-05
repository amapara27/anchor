// Reconstruct the visible PTY viewport so assertions cannot pass on erased text.
export class TerminalScreen {
    constructor(rows = 30, cols = 100) { this.resize(rows, cols); this.pending = ''; this.saved = [0, 0]; }
    resize(rows, cols) {
        this.rows = rows; this.cols = cols; this.x = 0; this.y = 0;
        this.cells = Array.from({ length: rows }, () => Array(cols).fill(' '));
    }
    get text() { return this.cells.map(row => row.join('').trimEnd()).join('\n'); }
    feed(text) {
        this.pending += text;
        const advance = () => { if (++this.y >= this.rows) { this.cells.shift(); this.cells.push(Array(this.cols).fill(' ')); this.y = this.rows - 1; } };
        while (this.pending) {
            if (this.pending.startsWith('\x1b[')) {
                const match = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(this.pending);
                if (!match) break;
                this.pending = this.pending.slice(match[0].length);
                const numbers = match[1].replace(/^[?>]/, '').split(';').map(Number), n = numbers[0] || 1;
                switch (match[3]) {
                    case 'H': case 'f': this.y = Math.min(this.rows - 1, (numbers[0] || 1) - 1); this.x = Math.min(this.cols - 1, (numbers[1] || 1) - 1); break;
                    case 'A': this.y = Math.max(0, this.y - n); break;
                    case 'B': this.y = Math.min(this.rows - 1, this.y + n); break;
                    case 'C': this.x = Math.min(this.cols - 1, this.x + n); break;
                    case 'D': this.x = Math.max(0, this.x - n); break;
                    case 'G': this.x = Math.min(this.cols - 1, n - 1); break;
                    case 'd': this.y = Math.min(this.rows - 1, n - 1); break;
                    case 'J':
                        if (numbers[0] === 2 || numbers[0] === 3) this.cells.forEach(row => row.fill(' '));
                        else { this.cells[this.y].fill(' ', this.x); for (let y = this.y + 1; y < this.rows; y++) this.cells[y].fill(' '); }
                        break;
                    case 'K': this.cells[this.y].fill(' ', numbers[0] === 2 || numbers[0] === 1 ? 0 : this.x, numbers[0] === 1 ? this.x + 1 : this.cols); break;
                    case 'h': if (match[1] === '?1049') this.cells.forEach(row => row.fill(' ')); break;
                    case 's': this.saved = [this.x, this.y]; break;
                    case 'u': [this.x, this.y] = this.saved; break;
                }
                continue;
            }
            if (this.pending.startsWith('\x1b]')) {
                const end = /\x07|\x1b\\/.exec(this.pending);
                if (!end) break;
                this.pending = this.pending.slice(end.index + end[0].length); continue;
            }
            const char = String.fromCodePoint(this.pending.codePointAt(0));
            if (char === '\x1b') { if (this.pending.length < 2) break; this.pending = this.pending.slice(2); continue; }
            this.pending = this.pending.slice(char.length);
            if (char === '\r') this.x = 0;
            else if (char === '\n') advance();
            else if (char === '\b') this.x = Math.max(0, this.x - 1);
            else if (char >= ' ') {
                if (this.x >= this.cols) { this.x = 0; advance(); }
                this.cells[this.y][this.x++] = char;
            }
        }
    }
}
