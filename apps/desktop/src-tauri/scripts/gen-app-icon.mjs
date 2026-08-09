// Generates every generated icon asset for the app. Pure Node stdlib — no
// image deps. Renders the Anchor mark (same glyph as the sidebar's
// AnchorMark) from `styles.css`'s design tokens. Re-run `pnpm tauri icon`
// after (regenerates the bundle .icns/.png set from app-icon.png; the
// dock-*/tray-icon-template outputs below are consumed directly, no CLI step).
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Design tokens (styles.css). Dark is :root's default; light is
// :root[data-theme="light"]'s. Both drive the Dock icon plate (item 3 in the
// icon-theming plan) so it matches whichever appearance macOS is in.
const DARK = {
  canvas: [10, 10, 11], // --color-canvas  #0a0a0b
  surface: [20, 20, 22], // --color-surface #141416
  edge: [40, 40, 42], // --hair: white/8.5% over surface
  accent: [122, 103, 222], // --color-accent  #7a67de
};
const LIGHT = {
  canvas: [247, 244, 237], // --color-canvas  #f7f4ed
  surface: [255, 253, 248], // --color-surface #fffdf8
  edge: [230, 228, 222], // --hair: black/11% over surface
  accent: [154, 115, 23], // --color-accent  #9a7317
};

const VBX = 12; // glyph bbox centre x in viewBox space
const VBY = 11.5; // glyph bbox centre y in viewBox space
const GLYPH_W = 20.6; // glyph bbox width in viewBox space (barb tip to barb tip)
const HW = 1.0; // half stroke width, viewBox units

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

/**
 * Anchor glyph SDF in viewBox units, unioned from stroked primitives — mirrors
 * the current AnchorMark in Sidebar.tsx (ring + shank + crossbar + flukes arc
 * + four barb ticks). The arc's real path is two elliptical-arc commands;
 * approximated here as a plain circle (center (12, 12.9), r 8.5) restricted to
 * the lower half — passes through both real endpoints (3.5,12.9)/(20.5,12.9),
 * same "stroked primitive" approximation style already used for the
 * ring/shank/crossbar, indistinguishable once rasterized at icon sizes.
 */
function glyphSDF(vx, vy) {
  let g = Math.abs(Math.hypot(vx - 12, vy - 3.6) - 2) - HW; // ring (shackle)
  g = Math.min(g, sdSeg(vx, vy, 12, 5.6, 12, 21.2) - HW); // shank
  g = Math.min(g, sdSeg(vx, vy, 8.2, 8.6, 15.8, 8.6) - HW); // stock (crossbar)
  if (vy >= 12.9) g = Math.min(g, Math.abs(Math.hypot(vx - 12, vy - 12.9) - 8.5) - HW); // arc (flukes)
  // Four barb ticks at the fluke ends.
  g = Math.min(g, sdSeg(vx, vy, 3.5, 12.9, 1.7, 11.2) - HW);
  g = Math.min(g, sdSeg(vx, vy, 3.5, 12.9, 5.8, 12.3) - HW);
  g = Math.min(g, sdSeg(vx, vy, 20.5, 12.9, 22.3, 11.2) - HW);
  g = Math.min(g, sdSeg(vx, vy, 20.5, 12.9, 18.2, 12.3) - HW);
  return g;
}

/** The Dock/app icon: the glyph in accent, on a rounded surface plate over the canvas. */
function renderPlate({ canvas, surface, edge, accent, out, size = 1024 }) {
  const cxp = size / 2;
  const cyp = size / 2;
  const s = size * 0.0276; // viewBox(0..24) units → px
  const half = size * 0.4; // plate half-extent (80% tile)
  const rad = size * 0.2; // plate corner radius (squircle)

  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Rounded-rect plate SDF (pixels).
      const qx = Math.abs(x - cxp) - half + rad;
      const qy = Math.abs(y - cyp) - half + rad;
      const plate = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;

      const vx = VBX + (x - cxp) / s;
      const vy = VBY + (y - cyp) / s;
      const g = glyphSDF(vx, vy);

      // Compose: canvas → plate → hairline → accent glyph, all anti-aliased.
      let col = mix(canvas, surface, clamp(0.5 - plate, 0, 1));
      col = mix(col, edge, clamp(1 - Math.abs(plate + 1.0) / 1.4, 0, 1) * 0.55);
      col = mix(col, accent, clamp(0.5 - g * s, 0, 1));

      const i = (y * size + x) * 4;
      buf[i] = Math.round(col[0]);
      buf[i + 1] = Math.round(col[1]);
      buf[i + 2] = Math.round(col[2]);
      buf[i + 3] = 255;
    }
  }
  writePng(buf, size, out);
}

/**
 * The menu-bar icon: the glyph alone, solid black with alpha coverage, no
 * plate, no color — a macOS "template image". The OS recolors this itself for
 * light/dark menu bar and highlight state, so unlike the Dock plate there's
 * only one variant to generate.
 */
function renderTemplateGlyph(size, out) {
  const cxp = size / 2;
  const cyp = size / 2;
  const sT = (size * 0.75) / GLYPH_W; // glyph fills ~75% of the frame at its widest

  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const vx = VBX + (x - cxp) / sT;
      const vy = VBY + (y - cyp) / sT;
      const g = glyphSDF(vx, vy);
      const alpha = clamp(0.5 - g * sT, 0, 1);

      const i = (y * size + x) * 4;
      buf[i] = 0;
      buf[i + 1] = 0;
      buf[i + 2] = 0;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  writePng(buf, size, out);
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

/** RGBA pixel buffer → PNG file. Shared by every render pass above. */
function writePng(buf, size, out) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Add the per-scanline filter byte (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    buf.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  writeFileSync(out, png);
  console.log(`Wrote ${out} (${png.length} bytes)`);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const srcTauriDir = join(scriptDir, "..");
const iconsDir = join(srcTauriDir, "icons");

// app-icon.png stays the single source `tauri icon` reads for the bundle
// .icns/.png set (Finder/LaunchServices' static, not-yet-launched icon) —
// dark, matching the app's default theme.
renderPlate({ ...DARK, out: join(srcTauriDir, "app-icon.png") });
// Runtime Dock-icon plates, swapped live by dock_icon.rs as the system
// appearance changes.
renderPlate({ ...DARK, out: join(iconsDir, "dock-dark.png") });
renderPlate({ ...LIGHT, out: join(iconsDir, "dock-light.png") });
// Menu-bar template image, loaded by tray.rs with icon_as_template(true).
renderTemplateGlyph(88, join(iconsDir, "tray-icon-template.png"));
