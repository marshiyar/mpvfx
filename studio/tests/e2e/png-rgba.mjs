import { deflateSync, inflateSync } from "node:zlib";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Decode the 8-bit RGB/RGBA PNGs emitted by packaged Chromium screenshots. */
export function decodePng(bytes) {
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error("Screenshot is not PNG");
  let offset = 8, width, height, channels;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("Truncated PNG chunk");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length))
      throw new Error(`Invalid PNG ${type} checksum`);
    if (type === "IHDR") {
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      if (payload[8] !== 8 || ![2, 6].includes(payload[9]) || payload[10] !== 0 || payload[11] !== 0 || payload[12] !== 0)
        throw new Error("Unsupported screenshot PNG format");
      channels = payload[9] === 2 ? 3 : 4;
    } else if (type === "IDAT") compressed.push(payload);
    else if (type === "IEND") break;
    offset = end;
  }
  if (!width || !height || !channels || !compressed.length) throw new Error("Incomplete screenshot PNG");
  const scanline = width * channels;
  const raw = inflateSync(Buffer.concat(compressed));
  if (raw.length !== height * (scanline + 1)) throw new Error("Wrong screenshot PNG data length");
  const rgba = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(scanline);
  for (let y = 0; y < height; y++) {
    const base = y * (scanline + 1);
    const filter = raw[base];
    if (filter > 4) throw new Error(`Unsupported PNG filter ${filter}`);
    const row = Buffer.allocUnsafe(scanline);
    for (let x = 0; x < scanline; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const above = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) {
        const p = left + above - upperLeft;
        const a = Math.abs(p - left), b = Math.abs(p - above), c = Math.abs(p - upperLeft);
        predictor = a <= b && a <= c ? left : b <= c ? above : upperLeft;
      }
      row[x] = (raw[base + 1 + x] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const source = x * channels, target = (y * width + x) * 4;
      rgba[target] = row[source];
      rgba[target + 1] = row[source + 1];
      rgba[target + 2] = row[source + 2];
      rgba[target + 3] = channels === 4 ? row[source + 3] : 255;
    }
    previous = row;
  }
  return { width, height, rgba };
}

export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error("Wrong RGBA pixel count");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const scanlines = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) rgba.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))]);
}
