import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import sharp from "sharp";

const desktopResources = path.resolve(import.meta.dir, "../resources");
const sourceCandidate = path.join(os.homedir(), "Downloads/mars-ascii-logo-hd.png");
const iconPngPath = path.join(desktopResources, "icon.png");
const iconIcoPath = path.join(desktopResources, "icon.ico");
const icnsDest = path.join(desktopResources, "icon.icns");

let sourceBuffer: Buffer;
try {
	sourceBuffer = await fs.readFile(sourceCandidate);
} catch {
	sourceBuffer = await fs.readFile(iconPngPath);
}

// 1. Generate master macOS squircle icon.png (1024x1024 with 824x824 body and drop shadow)
const artworkBuffer = await sharp(sourceBuffer).resize(824, 824, { fit: "cover" }).png().toBuffer();

const artworkBase64 = artworkBuffer.toString("base64");

const squircleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <filter id="macShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="#000000" flood-opacity="0.32" />
      <feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#000000" flood-opacity="0.45" />
    </filter>
    <clipPath id="squircleClip">
      <rect x="100" y="100" width="824" height="824" rx="185" ry="185" />
    </clipPath>
    <linearGradient id="bevelStroke" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.22" />
      <stop offset="40%" stop-color="#ffffff" stop-opacity="0.06" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.0" />
    </linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" ry="185" fill="#0c0204" filter="url(#macShadow)" />
  <g clip-path="url(#squircleClip)">
    <image x="100" y="100" width="824" height="824" href="data:image/png;base64,${artworkBase64}" preserveAspectRatio="xMidYMid slice" />
  </g>
  <rect x="100.5" y="100.5" width="823" height="823" rx="184.5" ry="184.5" fill="none" stroke="url(#bevelStroke)" stroke-width="1.5" pointer-events="none" />
</svg>`;

const masterPngBuffer = await sharp(Buffer.from(squircleSvg)).png({ quality: 100, compressionLevel: 9 }).toBuffer();

await fs.mkdir(desktopResources, { recursive: true });
await fs.writeFile(iconPngPath, masterPngBuffer);

// 2. Generate macOS .iconset and compile .icns
if (process.platform === "darwin") {
	const iconsetDir = path.join(os.tmpdir(), "mars-squircle.iconset");
	await fs.mkdir(iconsetDir, { recursive: true });

	const iconSpecs = [
		{ name: "icon_16x16.png", size: 16 },
		{ name: "icon_16x16@2x.png", size: 32 },
		{ name: "icon_32x32.png", size: 32 },
		{ name: "icon_32x32@2x.png", size: 64 },
		{ name: "icon_128x128.png", size: 128 },
		{ name: "icon_128x128@2x.png", size: 256 },
		{ name: "icon_256x256.png", size: 256 },
		{ name: "icon_256x256@2x.png", size: 512 },
		{ name: "icon_512x512.png", size: 512 },
		{ name: "icon_512x512@2x.png", size: 1024 },
	];

	for (const spec of iconSpecs) {
		const dest = path.join(iconsetDir, spec.name);
		await sharp(masterPngBuffer)
			.resize(spec.size, spec.size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.png({ quality: 100, compressionLevel: 9 })
			.toFile(dest);
	}

	await $`iconutil -c icns ${iconsetDir} -o ${icnsDest}`.quiet();
	await fs.rm(iconsetDir, { recursive: true, force: true });
}

// 3. Generate multi-resolution Windows icon.ico
const sizes = [256, 128, 64, 48, 32, 16];
const pngBuffers = await Promise.all(
	sizes.map(size =>
		sharp(masterPngBuffer)
			.resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.png({ quality: 100, compressionLevel: 9 })
			.toBuffer(),
	),
);

const count = sizes.length;
const headerSize = 6;
const dirEntrySize = 16;
const dirSize = count * dirEntrySize;
let offset = headerSize + dirSize;

const icoHeader = Buffer.alloc(headerSize);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(count, 4);

const entries: Buffer[] = [];
for (let i = 0; i < count; i++) {
	const s = sizes[i];
	const buf = pngBuffers[i];
	const entry = Buffer.alloc(dirEntrySize);
	entry.writeUInt8(s === 256 ? 0 : s, 0);
	entry.writeUInt8(s === 256 ? 0 : s, 1);
	entry.writeUInt8(0, 2);
	entry.writeUInt8(0, 3);
	entry.writeUInt16LE(1, 4);
	entry.writeUInt16LE(32, 6);
	entry.writeUInt32LE(buf.length, 8);
	entry.writeUInt32LE(offset, 12);
	entries.push(entry);
	offset += buf.length;
}

const finalIco = Buffer.concat([icoHeader, ...entries, ...pngBuffers]);
await fs.writeFile(iconIcoPath, finalIco);

process.stdout.write("Generated Mars Kommander squircle icon.png, icon.ico, and icon.icns\n");
