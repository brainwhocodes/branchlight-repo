import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const desktopRoot = path.resolve(import.meta.dir, "..");
const outRoot = path.join(desktopRoot, "out");
const distRoot = path.join(desktopRoot, "dist");
const platform = process.platform;
const arch = process.env.MARS_DESKTOP_ARCH?.trim() || process.arch;

if (platform !== "darwin" && platform !== "win32") {
	throw new Error(`Contained desktop artifacts can only be built on macOS or Windows, not ${platform}`);
}
if (arch !== "x64" && arch !== "arm64") {
	throw new Error(`Unsupported desktop architecture: ${arch}`);
}
if (platform === "win32" && arch !== "x64") {
	throw new Error("Mars Kommander currently ships Windows 10/11 as an x64 build");
}

async function run(command: string[], cwd = desktopRoot): Promise<void> {
	console.log(`$ ${command.join(" ")}`);
	const child = Bun.spawn(command, {
		cwd,
		env: { ...Bun.env },
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

async function assertPath(target: string, kind: "file" | "directory"): Promise<void> {
	const stat = await fs.stat(target).catch(() => undefined);
	if (!stat || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
		throw new Error(`Expected packaged ${kind} was not found: ${target}`);
	}
}

async function checksum(file: string): Promise<string> {
	const hash = createHash("sha256");
	hash.update(await fs.readFile(file));
	return hash.digest("hex");
}

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(distRoot, { recursive: true });
await run([process.execPath, "run", "backend:build"]);

const packageId = `Mars Kommander-${platform}-${arch}`;
const packageRoot = path.join(outRoot, packageId);

if (platform === "darwin") {
	await run([process.execPath, "run", "package", "--", "--platform=darwin", `--arch=${arch}`]);
	const appPath = path.join(packageRoot, "Mars Kommander.app");
	const backendPath = path.join(appPath, "Contents", "Resources", "omp");
	await assertPath(appPath, "directory");
	await assertPath(backendPath, "file");
	await run([backendPath, "--version"]);

	// Ad-hoc signing keeps development artifacts launchable while preserving a
	// clean seam for a future Developer ID/notarization step.
	await run(["codesign", "--force", "--deep", "--sign", "-", appPath]);
	await run(["codesign", "--verify", "--deep", "--strict", appPath]);

	const archive = path.join(distRoot, `Mars-Kommander-macOS-${arch}.zip`);
	await run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", appPath, archive]);
	const digest = await checksum(archive);
	await fs.writeFile(path.join(distRoot, "SHA256SUMS.txt"), `${digest}  ${path.basename(archive)}\n`, "utf8");
	console.log(`Created ${archive}`);
} else {
	await run([process.execPath, "run", "make", "--", "--platform=win32", "--arch=x64"]);
	const backendPath = path.join(packageRoot, "resources", "omp.exe");
	await assertPath(packageRoot, "directory");
	await assertPath(backendPath, "file");
	await run([backendPath, "--version"]);

	const portable = path.join(distRoot, "Mars-Kommander-Windows-10-11-x64-portable.zip");
	await run(["tar.exe", "-a", "-c", "-f", portable, "-C", packageRoot, "."]);

	const makeRoot = path.join(outRoot, "make", "squirrel.windows", "x64");
	const setup = path.join(makeRoot, "MarsKommanderSetup.exe");
	const releases = path.join(makeRoot, "RELEASES");
	await assertPath(setup, "file");
	await assertPath(releases, "file");
	await fs.copyFile(setup, path.join(distRoot, path.basename(setup)));
	await fs.copyFile(releases, path.join(distRoot, "RELEASES"));
	for (const entry of await fs.readdir(makeRoot)) {
		if (entry.endsWith(".nupkg")) await fs.copyFile(path.join(makeRoot, entry), path.join(distRoot, entry));
	}

	const distributables = (await fs.readdir(distRoot)).filter(entry => entry !== "SHA256SUMS.txt").sort();
	const sums = await Promise.all(
		distributables.map(async entry => `${await checksum(path.join(distRoot, entry))}  ${entry}`),
	);
	await fs.writeFile(path.join(distRoot, "SHA256SUMS.txt"), `${sums.join("\n")}\n`, "utf8");
	console.log(`Created Windows 10/11 artifacts in ${distRoot}`);
}
