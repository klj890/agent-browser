#!/usr/bin/env node
/**
 * Generate a minimal 1024x1024 PNG placeholder icon at build/icon.png.
 *
 * Intentionally dep-free: uses only Node's built-in zlib to emit a valid PNG
 * with a solid navy background (#1a3a6e). Real brand asset should replace
 * build/icon.png before v0.1 release — see build/icon.svg for the design.
 *
 * Run: node build/generate-icon.mjs
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const WIDTH = 1024;
const HEIGHT = 1024;
// #1a3a6e — CAMP-style dark blue
const R = 0x1a;
const G = 0x3a;
const B = 0x6e;
const A = 0xff;

function crc32(bytes) {
	// iterative CRC32 (IEEE 802.3) — no deps.
	let c;
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	let crc = 0xffffffff;
	for (const b of bytes) {
		crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff];
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, "ascii");
	const crcInput = Buffer.concat([typeBuf, data]);
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(crcInput), 0);
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// --- Build raw image data -------------------------------------------------
// PNG filter byte (0 = none) per scanline, then RGBA.
const row = Buffer.alloc(1 + WIDTH * 4);
row[0] = 0;
for (let x = 0; x < WIDTH; x++) {
	const off = 1 + x * 4;
	row[off] = R;
	row[off + 1] = G;
	row[off + 2] = B;
	row[off + 3] = A;
}
const raw = Buffer.alloc(HEIGHT * row.length);
for (let y = 0; y < HEIGHT; y++) row.copy(raw, y * row.length);

// --- PNG signature + chunks ----------------------------------------------
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type (RGBA)
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const idat = deflateSync(raw);
const iend = Buffer.alloc(0);

const png = Buffer.concat([
	signature,
	chunk("IHDR", ihdr),
	chunk("IDAT", idat),
	chunk("IEND", iend),
]);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "icon.png");
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
