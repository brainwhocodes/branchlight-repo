#!/usr/bin/env bun
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const packageDir = path.join(import.meta.dir, "..");
const distDir = path.join(packageDir, "dist");
const entry = path.join(packageDir, "src", "cli.ts");
const outName = process.platform === "win32" ? "branchlight.exe" : "branchlight";
const outfile = path.join(distDir, outName);

await fsp.mkdir(distDir, { recursive: true });

const buildResult = await Bun.build({
	entrypoints: [entry],
	outdir: distDir,
	naming: outName,
	target: "bun",
	compile: true,
	minify: false,
});

if (!buildResult.success) {
	for (const log of buildResult.logs) {
		console.error(log);
	}
	process.exit(1);
}

console.log(`Successfully built workspace runtime binary -> ${outfile}`);
