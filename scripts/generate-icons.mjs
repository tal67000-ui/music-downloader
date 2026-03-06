import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '..', 'client', 'public');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function createPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);

  const setPixel = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) {
      return;
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    raw[offset] = r;
    raw[offset + 1] = g;
    raw[offset + 2] = b;
    raw[offset + 3] = a;
  };

  const fillRect = (x0, y0, x1, y1, color) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        setPixel(x, y, color);
      }
    }
  };

  const fillCircle = (cx, cy, radius, color) => {
    const r2 = radius * radius;
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(size - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(size - 1, Math.ceil(cy + radius));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) {
          setPixel(x, y, color);
        }
      }
    }
  };

  const bgTop = [29, 34, 40, 255];
  const bgBottom = [18, 20, 23, 255];
  const accentA = [255, 180, 91, 255];
  const accentB = [255, 227, 151, 255];
  const note = [255, 231, 183, 255];

  for (let y = 0; y < size; y += 1) {
    const t = y / Math.max(1, size - 1);
    const color = [
      Math.round(bgTop[0] * (1 - t) + bgBottom[0] * t),
      Math.round(bgTop[1] * (1 - t) + bgBottom[1] * t),
      Math.round(bgTop[2] * (1 - t) + bgBottom[2] * t),
      255,
    ];
    fillRect(0, y, size, y + 1, color);
  }

  fillCircle(size * 0.32, size * 0.28, size * 0.36, [accentA[0], accentA[1], accentA[2], 36]);
  fillCircle(size * 0.74, size * 0.82, size * 0.34, [accentB[0], accentB[1], accentB[2], 26]);

  fillRect(size * 0.58, size * 0.2, size * 0.66, size * 0.68, note);
  fillRect(size * 0.66, size * 0.2, size * 0.83, size * 0.28, note);
  fillRect(size * 0.66, size * 0.41, size * 0.83, size * 0.49, note);
  fillCircle(size * 0.5, size * 0.72, size * 0.12, note);
  fillCircle(size * 0.76, size * 0.62, size * 0.12, note);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  return png;
}

await mkdir(publicDir, { recursive: true });
await writeFile(path.join(publicDir, 'pwa-192.png'), createPng(192));
await writeFile(path.join(publicDir, 'pwa-512.png'), createPng(512));
await writeFile(path.join(publicDir, 'apple-touch-icon.png'), createPng(180));
