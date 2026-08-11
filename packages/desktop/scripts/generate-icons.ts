import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deflateSync } from "node:zlib";

const size = 256;
const pixels = Buffer.alloc(size * size * 4, 0);
function pixel(x: number, y: number, color: [number, number, number, number]): void {
	if (x < 0 || y < 0 || x >= size || y >= size) return;
	const index = (y * size + x) * 4;
	pixels[index] = color[0];
	pixels[index + 1] = color[1];
	pixels[index + 2] = color[2];
	pixels[index + 3] = color[3];
}
function line(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	width: number,
	color: [number, number, number, number],
): void {
	const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
	for (let step = 0; step <= steps; step++) {
		const x = x1 + ((x2 - x1) * step) / steps;
		const y = y1 + ((y2 - y1) * step) / steps;
		for (let dx = -width; dx <= width; dx++)
			for (let dy = -width; dy <= width; dy++)
				if (dx * dx + dy * dy <= width * width) pixel(Math.round(x + dx), Math.round(y + dy), color);
	}
}
function circle(cx: number, cy: number, radius: number, color: [number, number, number, number]): void {
	for (let y = -radius; y <= radius; y++)
		for (let x = -radius; x <= radius; x++) if (x * x + y * y <= radius * radius) pixel(cx + x, cy + y, color);
}
const blue: [number, number, number, number] = [23, 104, 166, 255];
const teal: [number, number, number, number] = [20, 127, 118, 255];
line(64, 192, 64, 112, 12, blue);
line(64, 112, 120, 56, 12, blue);
line(120, 56, 192, 56, 12, blue);
line(120, 56, 120, 32, 12, blue);
line(120, 56, 120, 136, 12, blue);
line(120, 136, 168, 184, 12, blue);
line(168, 184, 200, 184, 12, blue);
circle(64, 192, 16, blue);
circle(168, 32, 16, blue);
circle(200, 112, 16, blue);
circle(200, 184, 16, blue);
circle(200, 112, 8, teal);

function chunk(type: string, data: Buffer): Buffer {
	const typeBytes = Buffer.from(type);
	const result = Buffer.alloc(8 + data.length + 4);
	result.writeUInt32BE(data.length, 0);
	typeBytes.copy(result, 4);
	data.copy(result, 8);
	result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
	return result;
}
function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
const rows = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) {
	rows[y * (size * 4 + 1)] = 0;
	pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
}
const png = Buffer.concat([
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	chunk("IHDR", Buffer.from([0, 0, 1, 0, 0, 0, 1, 0, 8, 6, 0, 0, 0])),
	chunk("IDAT", deflateSync(rows)),
	chunk("IEND", Buffer.alloc(0)),
]);
const resources = path.resolve(import.meta.dir, "../resources");
await fs.mkdir(resources, { recursive: true });
await fs.writeFile(path.join(resources, "icon.png"), png);
const ico = Buffer.alloc(6 + 16 + png.length);
ico.writeUInt16LE(0, 0);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt8(0, 6);
ico.writeUInt8(0, 7);
ico.writeUInt8(0, 8);
ico.writeUInt8(0, 9);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
png.copy(ico, 22);
await fs.writeFile(path.join(resources, "icon.ico"), ico);
process.stdout.write("Generated Branchlight icon.png and icon.ico\n");
