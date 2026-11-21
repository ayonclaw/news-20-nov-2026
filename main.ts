// Original offline news poster. Node 22, built-in modules only.
// TrueType outlines are rasterized here; no canvas, browser, packages or network.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const SIZE = 1024;
const SS = 3;
const W = SIZE * SS;
const BG = [13, 17, 21];
const INK = [242, 240, 231];
const MUTED = [179, 186, 188];
const BORDER = [68, 76, 80];
const ACCENT = [246, 181, 67];
const pixels = Buffer.alloc(W * W * 3);
for (let i = 0; i < pixels.length; i += 3) {
  pixels[i] = BG[0]; pixels[i + 1] = BG[1]; pixels[i + 2] = BG[2];
}

function span(y, x0, x1, color) {
  if (y < 0 || y >= W) return;
  const start = Math.max(0, Math.ceil(x0 - 0.5));
  const end = Math.min(W, Math.ceil(x1 - 0.5));
  for (let x = start, p = (y * W + start) * 3; x < end; x++, p += 3) {
    pixels[p] = color[0]; pixels[p + 1] = color[1]; pixels[p + 2] = color[2];
  }
}

function polygon(points, color) {
  fillContours([points.map(([x, y]) => [x * SS, y * SS])], color);
}

// Non-zero winding preserves the counters in letters and compound paths.
function fillContours(contours, color) {
  const edges = [];
  let low = W, high = 0;
  for (const contour of contours) {
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i], b = contour[(i + 1) % contour.length];
      if (a[1] === b[1]) continue;
      edges.push([a[0], a[1], b[0], b[1], b[1] > a[1] ? 1 : -1]);
      low = Math.min(low, a[1], b[1]); high = Math.max(high, a[1], b[1]);
    }
  }
  for (let y = Math.max(0, Math.ceil(low - 0.5)); y < Math.min(W, Math.ceil(high - 0.5)); y++) {
    const scan = y + 0.5, crossings = [];
    for (const [ax, ay, bx, by, direction] of edges) {
      if (scan >= Math.min(ay, by) && scan < Math.max(ay, by)) {
        crossings.push([ax + (scan - ay) * (bx - ax) / (by - ay), direction]);
      }
    }
    crossings.sort((a, b) => a[0] - b[0]);
    let winding = 0, start = 0;
    for (const [x, direction] of crossings) {
      if (winding === 0) start = x;
      winding += direction;
      if (winding === 0) span(y, start, x, color);
    }
  }
}

function rect(x, y, width, height, color) {
  for (let row = Math.round(y * SS); row < Math.round((y + height) * SS); row++) {
    span(row, x * SS, (x + width) * SS, color);
  }
}
function line(x1, y1, x2, y2, color = ACCENT, width = 3) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (!length) return;
  const dx = -(y2 - y1) * width / (2 * length), dy = (x2 - x1) * width / (2 * length);
  polygon([[x1 + dx, y1 + dy], [x2 + dx, y2 + dy], [x2 - dx, y2 - dy], [x1 - dx, y1 - dy]], color);
}
function ring(cx, cy, radius, color = ACCENT, width = 3) {
  const n = 64;
  for (let i = 0; i < n; i++) {
    const a = i * Math.PI * 2 / n, b = (i + 1) * Math.PI * 2 / n;
    line(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius,
      cx + Math.cos(b) * radius, cy + Math.sin(b) * radius, color, width);
  }
}

class TrueType {
  constructor(path) {
    this.data = readFileSync(path);
    const b = this.data;
    this.tables = {};
    for (let i = 0; i < b.readUInt16BE(4); i++) {
      const p = 12 + 16 * i;
      this.tables[b.toString('ascii', p, p + 4)] = b.readUInt32BE(p + 8);
    }
    const t = this.tables;
    this.units = b.readUInt16BE(t.head + 18);
    this.longLoca = b.readInt16BE(t.head + 50) === 1;
    this.metrics = b.readUInt16BE(t.hhea + 34);
    this.cache = new Map();
    this.cmap = 0;
    for (let i = 0; i < b.readUInt16BE(t.cmap + 2); i++) {
      const p = t.cmap + 4 + i * 8;
      const at = t.cmap + b.readUInt32BE(p + 4);
      if (b.readUInt16BE(at) === 4) this.cmap = at;
    }
    if (!this.cmap) throw new Error('Font requires a Unicode format-4 cmap.');
  }
  glyphIndex(char) {
    const b = this.data, p = this.cmap, code = char.codePointAt(0);
    const count = b.readUInt16BE(p + 6) / 2;
    for (let i = 0; i < count; i++) {
      const end = b.readUInt16BE(p + 14 + 2 * i);
      const start = b.readUInt16BE(p + 16 + 2 * count + 2 * i);
      if (code < start || code > end) continue;
      const delta = b.readInt16BE(p + 16 + 4 * count + 2 * i);
      const where = p + 16 + 6 * count + 2 * i;
      const offset = b.readUInt16BE(where);
      if (!offset) return (code + delta) & 65535;
      const glyph = b.readUInt16BE(where + offset + 2 * (code - start));
      return glyph ? (glyph + delta) & 65535 : 0;
    }
    throw new Error(`Missing glyph: ${char}`);
  }
  advance(char) {
    return this.data.readUInt16BE(this.tables.hmtx + 4 * Math.min(this.glyphIndex(char), this.metrics - 1));
  }
  contours(index, depth = 0) {
    if (this.cache.has(index)) return this.cache.get(index);
    if (depth > 10) throw new Error('Recursive composite glyph.');
    const b = this.data, t = this.tables;
    const offset = i => this.longLoca ? b.readUInt32BE(t.loca + 4 * i) : 2 * b.readUInt16BE(t.loca + 2 * i);
    if (offset(index) === offset(index + 1)) return [];
    const base = t.glyf + offset(index), n = b.readInt16BE(base);
    let p = base + 10, result = [];
    if (n >= 0) {
      const ends = [];
      for (let i = 0; i < n; i++, p += 2) ends.push(b.readUInt16BE(p));
      const total = n ? ends[n - 1] + 1 : 0;
      p += 2 + b.readUInt16BE(p);
      const flags = [];
      while (flags.length < total) {
        const flag = b[p++]; flags.push(flag);
        if (flag & 8) { const repeat = b[p++]; for (let j = 0; j < repeat; j++) flags.push(flag); }
      }
      const xs = [], ys = [];
      let x = 0, y = 0;
      for (const f of flags) {
        if (f & 2) { x += (f & 16 ? 1 : -1) * b[p++]; }
        else if (!(f & 16)) { x += b.readInt16BE(p); p += 2; }
        xs.push(x);
      }
      for (const f of flags) {
        if (f & 4) { y += (f & 32 ? 1 : -1) * b[p++]; }
        else if (!(f & 32)) { y += b.readInt16BE(p); p += 2; }
        ys.push(y);
      }
      let start = 0;
      for (const end of ends) {
        result.push(xs.slice(start, end + 1).map((vx, k) => [vx, ys[start + k], !!(flags[start + k] & 1)]));
        start = end + 1;
      }
    } else {
      let flags;
      do {
        flags = b.readUInt16BE(p); const child = b.readUInt16BE(p + 2); p += 4;
        let dx, dy;
        if (flags & 1) { dx = b.readInt16BE(p); dy = b.readInt16BE(p + 2); p += 4; }
        else { dx = b.readInt8(p); dy = b.readInt8(p + 1); p += 2; }
        if (!(flags & 2)) throw new Error('Point-matched composite is not supported.');
        let a = 1, d = 1, c = 0, e = 0;
        const fixed = () => { const v = b.readInt16BE(p) / 16384; p += 2; return v; };
        if (flags & 8) a = d = fixed();
        else if (flags & 64) { a = fixed(); d = fixed(); }
        else if (flags & 128) { a = fixed(); c = fixed(); e = fixed(); d = fixed(); }
        result.push(...this.contours(child, depth + 1).map(contour => contour.map(([vx, vy, on]) => [a * vx + c * vy + dx, e * vx + d * vy + dy, on])));
      } while (flags & 32);
    }
    this.cache.set(index, result);
    return result;
  }
}

const fontRoot = '/usr/share/fonts/truetype/dejavu/';
const bold = new TrueType(join(fontRoot, 'DejaVuSans-Bold.ttf'));
const regular = new TrueType(join(fontRoot, 'DejaVuSans.ttf'));
const layout = [];
function measure(text, size, font = regular) {
  return [...text].reduce((sum, char) => sum + font.advance(char) * size / font.units, 0);
}
function text(value, x, top, size, color = INK, font = regular, maxWidth = SIZE - x - 40) {
  const width = measure(value, size, font);
  if (width > maxWidth) throw new Error(`Text overflows: ${value} (${width} > ${maxWidth})`);
  const scale = size * SS / font.units;
  const baseline = (top + size * 0.76) * SS;
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  let pen = x * SS;
  for (const char of value) {
    const outlines = font.contours(font.glyphIndex(char));
    const flat = outlines.map(contour => {
      const points = [];
      for (let i = 0; i < contour.length; i++) {
        const a = contour[i], b = contour[(i + 1) % contour.length];
        points.push(a);
        if (!a[2] && !b[2]) points.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, true]);
      }
      const firstOn = points.findIndex(point => point[2]);
      if (firstOn < 0) throw new Error('Contour has no on-curve point.');
      const ordered = [...points.slice(firstOn), ...points.slice(0, firstOn)];
      const output = [[ordered[0][0] * scale + pen, baseline - ordered[0][1] * scale]];
      for (let i = 1; i <= ordered.length; i++) {
        const point = ordered[i % ordered.length];
        if (point[2]) output.push([point[0] * scale + pen, baseline - point[1] * scale]);
        else {
          const from = ordered[(i - 1) % ordered.length], to = ordered[(i + 1) % ordered.length];
          const steps = Math.max(3, Math.ceil((Math.hypot(point[0] - from[0], point[1] - from[1]) + Math.hypot(to[0] - point[0], to[1] - point[1])) * scale / 5));
          for (let j = 1; j <= steps; j++) {
            const t = j / steps, u = 1 - t;
            output.push([(u * u * from[0] + 2 * u * t * point[0] + t * t * to[0]) * scale + pen,
              baseline - (u * u * from[1] + 2 * u * t * point[1] + t * t * to[1]) * scale]);
          }
          i++;
        }
      }
      return output;
    });
    for (const contour of flat) for (const [px, py] of contour) {
      bounds[0] = Math.min(bounds[0], px / SS); bounds[1] = Math.min(bounds[1], py / SS);
      bounds[2] = Math.max(bounds[2], px / SS); bounds[3] = Math.max(bounds[3], py / SS);
    }
    fillContours(flat, color);
    pen += font.advance(char) * scale;
  }
  if (bounds[0] < 0 || bounds[1] < 0 || bounds[2] > SIZE || bounds[3] > SIZE) {
    throw new Error(`Clipped text: ${value}`);
  }
  layout.push({ text: value, x, y: top, size, width, maxWidth, bounds });
}

// Six symbols: price collapse, scales, damaged bridge, summit, oil, outage.
function market(x, y) {
  line(x + 2, y + 7, x + 2, y + 86, BORDER, 2);
  line(x + 2, y + 86, x + 103, y + 86, BORDER, 2);
  const points = [[8, 14], [27, 31], [44, 25], [61, 51], [75, 47], [96, 77]];
  for (let i = 1; i < points.length; i++) line(x + points[i - 1][0], y + points[i - 1][1], x + points[i][0], y + points[i][1], ACCENT, 5);
  polygon([[x + 84, y + 78], [x + 101, y + 83], [x + 101, y + 65]], ACCENT);
}
function justice(x, y) {
  line(x + 52, y + 10, x + 52, y + 84, ACCENT, 4);
  line(x + 12, y + 25, x + 92, y + 25, ACCENT, 4);
  ring(x + 52, y + 13, 5, ACCENT, 3);
  for (const cx of [x + 20, x + 84]) {
    line(cx, y + 26, cx - 15, y + 59, ACCENT, 2);
    line(cx, y + 26, cx + 15, y + 59, ACCENT, 2);
    polygon([[cx - 18, y + 59], [cx + 18, y + 59], [cx + 10, y + 70], [cx - 10, y + 70]], ACCENT);
  }
  line(x + 26, y + 85, x + 78, y + 85, ACCENT, 4);
}
function bridge(x, y) {
  for (const [bx, h] of [[6, 40], [23, 54], [82, 44]]) rect(x + bx, y + 81 - h, 13, h, BORDER);
  line(x, y + 66, x + 44, y + 66, ACCENT, 5);
  line(x + 62, y + 72, x + 106, y + 66, ACCENT, 5);
  line(x + 23, y + 67, x + 23, y + 91, ACCENT, 4);
  line(x + 85, y + 69, x + 85, y + 91, ACCENT, 4);
  line(x + 50, y + 41, x + 56, y + 52, ACCENT, 3);
  line(x + 63, y + 38, x + 60, y + 49, ACCENT, 3);
  line(x + 42, y + 52, x + 49, y + 55, ACCENT, 3);
  polygon([[x + 77, y + 7], [x + 57, y + 27], [x + 62, y + 31], [x + 83, y + 12]], INK);
  line(x + 4, y + 97, x + 101, y + 97, BORDER, 2);
}
function summit(x, y) {
  for (const [cx, cy] of [[22, 30], [54, 18], [86, 30]]) {
    ring(x + cx, y + cy, 10, ACCENT, 3);
    line(x + cx - 13, y + cy + 29, x + cx - 10, y + cy + 17, ACCENT, 3);
    line(x + cx - 10, y + cy + 17, x + cx + 10, y + cy + 17, ACCENT, 3);
    line(x + cx + 10, y + cy + 17, x + cx + 13, y + cy + 29, ACCENT, 3);
  }
  polygon([[x + 5, y + 68], [x + 103, y + 68], [x + 88, y + 82], [x + 20, y + 82]], ACCENT);
  line(x + 25, y + 82, x + 25, y + 96, ACCENT, 3);
  line(x + 83, y + 82, x + 83, y + 96, ACCENT, 3);
}
function climate(x, y) {
  // An oil drop crossed out: the omitted fossil-fuel phaseout.
  const drop = [[54, 6], [30, 38], [24, 55], [25, 70], [35, 82], [54, 88], [73, 82], [83, 70], [84, 55], [78, 38]];
  for (let i = 0; i < drop.length; i++) line(x + drop[i][0], y + drop[i][1], x + drop[(i + 1) % drop.length][0], y + drop[(i + 1) % drop.length][1], ACCENT, 3);
  line(x + 12, y + 92, x + 96, y + 10, BG, 11);
  line(x + 12, y + 92, x + 96, y + 10, ACCENT, 4);
}
function outage(x, y) {
  line(x + 40, y + 6, x + 40, y + 28, ACCENT, 4);
  line(x + 67, y + 6, x + 67, y + 28, ACCENT, 4);
  polygon([[x + 28, y + 29], [x + 79, y + 29], [x + 79, y + 48], [x + 65, y + 63], [x + 42, y + 63], [x + 28, y + 48]], ACCENT);
  line(x + 54, y + 62, x + 54, y + 72, ACCENT, 4);
  line(x + 54, y + 83, x + 54, y + 98, ACCENT, 4);
  line(x + 29, y + 71, x + 39, y + 76, INK, 3);
  line(x + 68, y + 76, x + 78, y + 71, INK, 3);
}

text('WORLD / DAY BRIEF', 44, 30, 18, ACCENT, bold);
text('SIX STORIES / ONE DAY', 733, 32, 15, MUTED, regular, 247);
text('FRIDAY 20', 40, 65, 86, INK, bold, 944);
text('NOVEMBER 2026', 40, 144, 86, INK, bold, 944);
rect(44, 229, 936, 5, ACCENT);

const stories = [
  { region: 'ASIA', beat: 'MARKETS', headline: ['Taiwan stocks', 'fall 6.2%'], detail: 'Taiex week -18%; AI-bubble fears; Anthropic $81B IPO.', icon: market },
  { region: 'THE HAGUE', beat: 'JUSTICE', headline: ['UN court finds', 'genocide'], detail: 'ICJ: Myanmar targeted Rohingya; sanctions urged.', icon: justice },
  { region: 'KYIV', beat: 'WAR', headline: ['Russian missiles', 'hit Kyiv'], detail: 'Bridges hit; civilians killed; power cut.', icon: bridge },
  { region: 'SHENZHEN', beat: 'DIPLOMACY', headline: ['Trump, Xi,', 'Putin meet'], detail: 'First three-way summit; Russia: a snub to Europe.', icon: summit },
  { region: 'COP31', beat: 'CLIMATE', headline: ['Climate talks', 'falter'], detail: 'Fossil phaseout cut from draft; activists: shame.', icon: climate },
  { region: 'UNITED STATES', beat: 'TECH', headline: ['Outages hit', 'banks, flights'], detail: 'Banking, flights and email fail all week.', icon: outage },
];
for (let i = 0; i < stories.length; i++) {
  const s = stories[i], x = 44 + (i % 2) * 478, y = 258 + Math.floor(i / 2) * 238;
  const tw = 458, th = 220;
  rect(x, y, tw, 1, BORDER); rect(x, y + th - 1, tw, 1, BORDER);
  rect(x, y, 1, th, BORDER); rect(x + tw - 1, y, 1, th, BORDER);
  rect(x + 18, y + 19, 4, 16, ACCENT);
  text(`${s.region} / ${s.beat}`, x + 32, y + 19, 18, ACCENT, bold, tw - 50);
  s.icon(x + 20, y + 68);
  text(s.headline[0], x + 140, y + 76, 32, INK, bold, tw - 158);
  text(s.headline[1], x + 140, y + 116, 32, INK, bold, tw - 158);
  text(s.detail, x + 18, y + 186, 15, MUTED, regular, tw - 36);
}
text('20.11.2026', 44, 978, 14, MUTED, bold);
text('MARKETS / JUSTICE / WAR / DIPLOMACY / CLIMATE / TECH', 486, 979, 12, MUTED, regular, 494);

const crcTable = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, data) {
  const name = Buffer.from(type), result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); name.copy(result, 4); data.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return result;
}
function png(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size), ratio = W / size;
  // Area averaging works for both the exact 3x master and the small QA preview.
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    for (let x = 0; x < size; x++) {
      const sums = [0, 0, 0];
      let weight = 0;
      for (let sy = Math.floor(y * ratio); sy < Math.ceil((y + 1) * ratio); sy++) {
        const wy = Math.min(sy + 1, (y + 1) * ratio) - Math.max(sy, y * ratio);
        for (let sx = Math.floor(x * ratio); sx < Math.ceil((x + 1) * ratio); sx++) {
          const wx = Math.min(sx + 1, (x + 1) * ratio) - Math.max(sx, x * ratio), w = wx * wy;
          const at = (sy * W + sx) * 3;
          for (let c = 0; c < 3; c++) sums[c] += pixels[at + c] * w;
          weight += w;
        }
      }
      for (let c = 0; c < 3; c++) raw[row + 1 + x * 3 + c] = Math.round(sums[c] / weight);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const output = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(output, { recursive: true });
const image = png(SIZE);
if (image.length > 1048576) throw new Error('Image exceeds 1 MiB.');
writeFileSync(join(output, 'entry.png'), image);
if (process.env.MAKEFUN_QA === '1') {
  writeFileSync(join(output, 'preview.png'), png(350));
  writeFileSync(join(output, 'layout.json'), JSON.stringify(layout, null, 2) + '\n');
}
console.log(`Wrote entry.png: ${SIZE}x${SIZE}, ${image.length} bytes.`);
