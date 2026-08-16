/** Chrome-for-Testing installer used by OMP's Playwright runtime. */

import type * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

const CHROME_FOR_TESTING_BASE_URL = "https://storage.googleapis.com/chrome-for-testing-public";
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_DIRECTORY_MODE = 0o040000;
const ZIP_REGULAR_FILE_MODE = 0o100000;
const ZIP_SYMLINK_MODE = 0o120000;
const ZIP_FILE_TYPE_MASK = 0o170000;

const CHROMIUM_CACHE_PRODUCT = "chrome";

/**
 * Full Chrome-for-Testing version declared by playwright-core 1.62.1 in its
 * browsers.json metadata. Keep the dependency metadata contract test in sync.
 */
export const PLAYWRIGHT_CHROMIUM_VERSION = "151.0.7922.34";

/** Chrome-for-Testing download platform identifiers used by the OMP cache. */
export enum ChromiumPlatform {
	LINUX = "linux",
	LINUX_ARM = "linux_arm",
	MAC = "mac",
	MAC_ARM = "mac_arm",
	WIN32 = "win32",
	WIN64 = "win64",
}

const CHROMIUM_PLATFORMS = [
	ChromiumPlatform.LINUX,
	ChromiumPlatform.LINUX_ARM,
	ChromiumPlatform.MAC,
	ChromiumPlatform.MAC_ARM,
	ChromiumPlatform.WIN32,
	ChromiumPlatform.WIN64,
] as const;

/** Download progress reported while the Chromium archive is streamed to disk. */
export interface ChromiumDownloadProgress {
	downloadedBytes: number;
	totalBytes: number;
}

/** Inputs used to locate the OMP-managed Chromium executable. */
export interface ChromiumExecutableOptions {
	version: string;
	cacheDir: string;
	platform?: ChromiumPlatform;
}

/** Inputs used to download and install OMP-managed Chromium. */
export interface ChromiumInstallOptions extends ChromiumExecutableOptions {
	baseUrl?: string;
	onProgress?: (progress: ChromiumDownloadProgress) => void;
}

/** Metadata for one Chromium installation found in the OMP browser cache. */
export interface ChromiumInstallation {
	version: string;
	platform: ChromiumPlatform;
	path: string;
	executablePath: string;
}

interface ZipEntry {
	name: string;
	method: number;
	crc: number;
	compressedSize: number;
	uncompressedSize: number;
	externalAttributes: number;
	localHeaderOffset: number;
}

/** Detect the current host's Chrome-for-Testing platform. */
export function detectChromiumPlatform(): ChromiumPlatform | undefined {
	const platform = os.platform();
	const arch = os.arch();
	if (platform === "darwin") return arch === "arm64" ? ChromiumPlatform.MAC_ARM : ChromiumPlatform.MAC;
	if (platform === "linux") return arch === "arm64" ? ChromiumPlatform.LINUX_ARM : ChromiumPlatform.LINUX;
	if (platform === "win32") return arch === "ia32" ? ChromiumPlatform.WIN32 : ChromiumPlatform.WIN64;
	return undefined;
}

/** Return the Chrome-for-Testing archive URL for a Chromium version. */
export function chromiumDownloadUrl(
	platform: ChromiumPlatform,
	version: string,
	baseUrl = CHROME_FOR_TESTING_BASE_URL,
): URL {
	const archivePlatform = chromeArchivePlatform(platform);
	const root = baseUrl.replace(/\/$/, "");
	return new URL(`${root}/${version}/${archivePlatform}/chrome-${archivePlatform}.zip`);
}

/** Compute an OMP-managed Chrome-for-Testing executable path. */
export function chromiumExecutablePath(options: ChromiumExecutableOptions): string {
	const platform = options.platform ?? detectChromiumPlatform();
	if (!platform) throw new Error("Cannot determine a Chromium platform for this host");
	const installDir = installationDir(options.cacheDir, platform, options.version);
	switch (platform) {
		case ChromiumPlatform.LINUX:
		case ChromiumPlatform.LINUX_ARM:
			return path.join(installDir, "chrome-linux64", "chrome");
		case ChromiumPlatform.MAC:
			return path.join(
				installDir,
				"chrome-mac-x64",
				"Google Chrome for Testing.app",
				"Contents",
				"MacOS",
				"Google Chrome for Testing",
			);
		case ChromiumPlatform.MAC_ARM:
			return path.join(
				installDir,
				"chrome-mac-arm64",
				"Google Chrome for Testing.app",
				"Contents",
				"MacOS",
				"Google Chrome for Testing",
			);
		case ChromiumPlatform.WIN32:
			return path.join(installDir, "chrome-win32", "chrome.exe");
		case ChromiumPlatform.WIN64:
			return path.join(installDir, "chrome-win64", "chrome.exe");
	}
}

/** Scan the OMP browser cache for Chromium installation directories. */
export async function getInstalledChromium(options: { cacheDir: string }): Promise<ChromiumInstallation[]> {
	const installed: ChromiumInstallation[] = [];
	const browserDir = path.join(options.cacheDir, CHROMIUM_CACHE_PRODUCT);
	let entries: fs.Dirent[];
	try {
		entries = await fsp.readdir(browserDir, { withFileTypes: true });
	} catch (error) {
		if (isMissingPath(error)) return installed;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const parsed = parseInstallationName(entry.name);
		if (!parsed) continue;
		installed.push({
			version: parsed.version,
			platform: parsed.platform,
			path: path.join(browserDir, entry.name),
			executablePath: chromiumExecutablePath({
				version: parsed.version,
				cacheDir: options.cacheDir,
				platform: parsed.platform,
			}),
		});
	}
	return installed;
}

/** Download and unpack OMP-managed Chrome for Testing. */
export async function installChromium(options: ChromiumInstallOptions): Promise<ChromiumInstallation> {
	const platform = options.platform ?? detectChromiumPlatform();
	if (!platform) throw new Error("Cannot determine a Chromium platform for this host");
	const executablePath = chromiumExecutablePath({ ...options, platform });
	const installPath = installationDir(options.cacheDir, platform, options.version);
	if (await pathExists(executablePath)) {
		return { version: options.version, platform, path: installPath, executablePath };
	}

	await fsp.mkdir(options.cacheDir, { recursive: true });
	const nonce = `${process.pid}-${crypto.randomUUID()}`;
	const archivePath = path.join(options.cacheDir, `.chromium-${nonce}.zip`);
	const stagingPath = path.join(options.cacheDir, `.chromium-${nonce}`);
	try {
		await downloadArchive(
			chromiumDownloadUrl(platform, options.version, options.baseUrl),
			archivePath,
			options.onProgress,
		);
		await extractZipArchive(archivePath, stagingPath);
		await fsp.mkdir(path.dirname(installPath), { recursive: true });
		await fsp.rm(installPath, { recursive: true, force: true });
		await fsp.rename(stagingPath, installPath);
	} finally {
		await Promise.all([
			fsp.rm(archivePath, { force: true }).catch(() => {}),
			fsp.rm(stagingPath, { recursive: true, force: true }).catch(() => {}),
		]);
	}
	if (!(await pathExists(executablePath)))
		throw new Error(`Chromium archive did not contain its expected executable: ${executablePath}`);
	return { version: options.version, platform, path: installPath, executablePath };
}

function chromeArchivePlatform(platform: ChromiumPlatform): string {
	switch (platform) {
		case ChromiumPlatform.LINUX:
		case ChromiumPlatform.LINUX_ARM:
			return "linux64";
		case ChromiumPlatform.MAC:
			return "mac-x64";
		case ChromiumPlatform.MAC_ARM:
			return "mac-arm64";
		case ChromiumPlatform.WIN32:
			return "win32";
		case ChromiumPlatform.WIN64:
			return "win64";
	}
}

function installationDir(cacheDir: string, platform: ChromiumPlatform, version: string): string {
	return path.join(cacheDir, CHROMIUM_CACHE_PRODUCT, `${platform}-${version}`);
}

function parseInstallationName(name: string): { platform: ChromiumPlatform; version: string } | undefined {
	for (const platform of CHROMIUM_PLATFORMS) {
		const prefix = `${platform}-`;
		if (name.startsWith(prefix) && name.length > prefix.length)
			return { platform, version: name.slice(prefix.length) };
	}
	return undefined;
}

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fsp.access(filePath);
		return true;
	} catch (error) {
		if (isMissingPath(error)) return false;
		throw error;
	}
}

async function downloadArchive(
	url: URL,
	destination: string,
	onProgress: ((progress: ChromiumDownloadProgress) => void) | undefined,
): Promise<void> {
	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(`Chromium download failed (${response.status} ${response.statusText}) from ${url}`);
	}
	const totalBytes = Number(response.headers.get("content-length") ?? 0);
	const file = await fsp.open(destination, "wx");
	let downloadedBytes = 0;
	try {
		const reader = response.body.getReader();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			let offset = 0;
			while (offset < chunk.value.byteLength) {
				const write = await file.write(chunk.value, offset, chunk.value.byteLength - offset, null);
				if (write.bytesWritten === 0) throw new Error(`Chromium download stalled while writing ${destination}`);
				offset += write.bytesWritten;
			}
			downloadedBytes += chunk.value.byteLength;
			onProgress?.({ downloadedBytes, totalBytes });
		}
	} finally {
		await file.close();
	}
}

async function extractZipArchive(archivePath: string, destination: string): Promise<void> {
	const archive = await fsp.readFile(archivePath);
	const entries = readCentralDirectory(archive);
	await fsp.mkdir(destination, { recursive: true });
	const root = path.resolve(destination);
	for (const entry of entries) {
		const outputPath = safeArchivePath(root, entry.name);
		const mode = entry.externalAttributes >>> 16;
		const type = mode & ZIP_FILE_TYPE_MASK;
		if (entry.name.endsWith("/") || type === ZIP_DIRECTORY_MODE) {
			await fsp.mkdir(outputPath, { recursive: true });
			if (mode & 0o777) await fsp.chmod(outputPath, mode & 0o777);
			continue;
		}

		const contents = readZipEntry(archive, entry);
		await fsp.mkdir(path.dirname(outputPath), { recursive: true });
		if (type === ZIP_SYMLINK_MODE) {
			const target = contents.toString("utf8");
			validateSymlinkTarget(root, outputPath, target);
			await fsp.symlink(target, outputPath);
			continue;
		}
		await fsp.writeFile(outputPath, contents, { mode: mode & 0o777 ? mode & 0o777 : 0o644 });
		if ((mode & ZIP_FILE_TYPE_MASK) === ZIP_REGULAR_FILE_MODE && mode & 0o777)
			await fsp.chmod(outputPath, mode & 0o777);
	}
}

function readCentralDirectory(archive: Buffer): ZipEntry[] {
	const minimumOffset = Math.max(0, archive.length - 65_557);
	let endOffset = -1;
	for (let offset = archive.length - 22; offset >= minimumOffset; offset--) {
		if (archive.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
			endOffset = offset;
			break;
		}
	}
	if (endOffset < 0) throw new Error("Invalid ZIP archive: central directory was not found");
	const disk = archive.readUInt16LE(endOffset + 4);
	const centralDisk = archive.readUInt16LE(endOffset + 6);
	const entryCount = archive.readUInt16LE(endOffset + 10);
	const centralSize = archive.readUInt32LE(endOffset + 12);
	const centralOffset = archive.readUInt32LE(endOffset + 16);
	if (disk !== 0 || centralDisk !== 0) throw new Error("Multi-disk ZIP archives are not supported");
	if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
		throw new Error("ZIP64 archives are not supported");
	}
	if (centralOffset + centralSize > endOffset)
		throw new Error("Invalid ZIP archive: central directory is out of bounds");

	const entries: ZipEntry[] = [];
	let offset = centralOffset;
	for (let index = 0; index < entryCount; index++) {
		if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
			throw new Error("Invalid ZIP archive: malformed central directory entry");
		}
		const flags = archive.readUInt16LE(offset + 8);
		if (flags & 1) throw new Error("Encrypted ZIP entries are not supported");
		const nameLength = archive.readUInt16LE(offset + 28);
		const extraLength = archive.readUInt16LE(offset + 30);
		const commentLength = archive.readUInt16LE(offset + 32);
		const end = offset + 46 + nameLength + extraLength + commentLength;
		if (end > archive.length) throw new Error("Invalid ZIP archive: truncated central directory entry");
		entries.push({
			name: archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"),
			method: archive.readUInt16LE(offset + 10),
			crc: archive.readUInt32LE(offset + 16),
			compressedSize: archive.readUInt32LE(offset + 20),
			uncompressedSize: archive.readUInt32LE(offset + 24),
			externalAttributes: archive.readUInt32LE(offset + 38),
			localHeaderOffset: archive.readUInt32LE(offset + 42),
		});
		offset = end;
	}
	return entries;
}

function readZipEntry(archive: Buffer, entry: ZipEntry): Buffer {
	const offset = entry.localHeaderOffset;
	if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== ZIP_LOCAL_FILE_HEADER) {
		throw new Error(`Invalid ZIP archive: malformed local header for ${entry.name}`);
	}
	const nameLength = archive.readUInt16LE(offset + 26);
	const extraLength = archive.readUInt16LE(offset + 28);
	const start = offset + 30 + nameLength + extraLength;
	const end = start + entry.compressedSize;
	if (end > archive.length) throw new Error(`Invalid ZIP archive: truncated data for ${entry.name}`);
	const compressed = archive.subarray(start, end);
	let contents: Buffer;
	if (entry.method === 0) contents = Buffer.from(compressed);
	else if (entry.method === 8) contents = zlib.inflateRawSync(compressed);
	else throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
	if (contents.length !== entry.uncompressedSize)
		throw new Error(`Invalid uncompressed size for ZIP entry ${entry.name}`);
	if (crc32(contents) !== entry.crc) throw new Error(`CRC mismatch for ZIP entry ${entry.name}`);
	return contents;
}

function safeArchivePath(root: string, name: string): string {
	if (!name || name.includes("\0") || name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) {
		throw new Error(`Unsafe path in ZIP archive: ${name}`);
	}
	const segments = name.replaceAll("\\", "/").split("/");
	if (segments.some(segment => segment === "..")) throw new Error(`Unsafe path in ZIP archive: ${name}`);
	const target = path.resolve(root, ...segments.filter(Boolean));
	if (target !== root && !target.startsWith(`${root}${path.sep}`))
		throw new Error(`Unsafe path in ZIP archive: ${name}`);
	return target;
}

function validateSymlinkTarget(root: string, linkPath: string, target: string): void {
	if (!target || target.includes("\0") || path.isAbsolute(target) || /^[A-Za-z]:/.test(target)) {
		throw new Error(`Unsafe symlink target in ZIP archive: ${target}`);
	}
	const resolved = path.resolve(path.dirname(linkPath), target);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
		throw new Error(`Unsafe symlink target in ZIP archive: ${target}`);
	}
}

function crc32(contents: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of contents) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
