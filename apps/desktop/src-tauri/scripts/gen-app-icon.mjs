// Generates the source icon (app-icon.png) for `tauri icon`.
// Pure Node stdlib — no image deps. Renders the Anchor mark (same glyph as the
// sidebar's AnchorMark) in the "Refined Minimal Dark" tokens: the accent anchor
// on a rounded surface plate over the canvas. Re-run `pnpm tauri icon` after.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SIZE = 1024;
// Design tokens (styles.css :root — dark theme, the app's default).
const CANVAS = [10, 10, 11]; // --color-canvas  #0a0a0b
const SURFACE = [20, 20, 22]; // --color-surface #141416
const EDGE = [40, 40, 42]; // --hair: white/8.5% over surface
const ACCENT = [122, 103, 222]; // --color-accent  #7a67de

const cxp = SIZE / 2;
const cyp = SIZE / 2;
const s = SIZE * 0.0276; // viewBox(0..24) units → px
const VBX = 12; // glyph bbox centre x in viewBox space
const VBY = 11.5; // glyph bbox centre y in viewBox space
const HW = 1.0; // half stroke width, viewBox units
const half = SIZE * 0.4; // plate half-extent (80% tile)
const rad = SIZE * 0.2; // plate corner radius (squircle)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Distance from point to a line segment (rounded-cap stroke).
function sdSeg(px, py, ax, ay, bx, by) {
  const pax = px - ax,
    pay = py - ay,
    bax = bx - ax,
    bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h);
}

const buf = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // Rounded-rect plate SDF (pixels).
    const qx = Math.abs(x - cxp) - half + rad;
    const qy = Math.abs(y - cyp) - half + rad;
    const plate = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;

    // Anchor glyph SDF in viewBox units, unioned from stroked primitives —
    // mirrors the current AnchorMark in Sidebar.tsx (ring + shank + crossbar +
    // flukes arc + four barb ticks). The arc's real path is two elliptical-arc
    // commands; approximated here as a plain circle (center (12, 12.9), r 8.5)
    // restricted to the lower half — passes through both real endpoints
    // (3.5,12.9)/(20.5,12.9), same "stroked primitive" approximation style
    // already used for the ring/shank/crossbar, indistinguishable once
    // rasterized at icon sizes.
    const vx = VBX + (x - cxp) / s;
    const vy = VBY + (y - cyp) / s;
    let g = Math.abs(Math.hypot(vx - 12, vy - 3.6) - 2) - HW; // ring (shackle)
    g = Math.min(g, sdSeg(vx, vy, 12, 5.6, 12, 21.2) - HW); // shank
    g = Math.min(g, sdSeg(vx, vy, 8.2, 8.6, 15.8, 8.6) - HW); // stock (crossbar)
    if (vy >= 12.9) g = Math.min(g, Math.abs(Math.hypot(vx - 12, vy - 12.9) - 8.5) - HW); // arc (flukes)
    // Four barb ticks at the fluke ends.
    g = Math.min(g, sdSeg(vx, vy, 3.5, 12.9, 1.7, 11.2) - HW);
    g = Math.min(g, sdSeg(vx, vy, 3.5, 12.9, 5.8, 12.3) - HW);
    g = Math.min(g, sdSeg(vx, vy, 20.5, 12.9, 22.3, 11.2) - HW);
    g = Math.min(g, sdSeg(vx, vy, 20.5, 12.9, 18.2, 12.3) - HW);

    // Compose: canvas → plate → hairline → accent glyph, all anti-aliased.
    let col = mix(CANVAS, SURFACE, clamp(0.5 - plate, 0, 1));
    col = mix(col, EDGE, clamp(1 - Math.abs(plate + 1.0) / 1.4, 0, 1) * 0.55);
    col = mix(col, ACCENT, clamp(0.5 - g * s, 0, 1));

    const i = (y * SIZE + x) * 4;
    buf[i] = Math.round(col[0]);
    buf[i + 1] = Math.round(col[1]);
    buf[i + 2] = Math.round(col[2]);
    buf[i + 3] = 255;
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

// Add the per-scanline filter byte (0 = none).
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "app-icon.png");
writeFileSync(out, png);
console.log(`Wrote ${out} (${png.length} bytes)`);
