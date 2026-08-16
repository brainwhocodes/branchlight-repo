import * as fs from "node:fs";
import * as path from "node:path";
import { defineConfig, type Plugin } from "vite";

function rawTextPlugin() {
	return {
		name: "raw-text-loader",
		transform(code: string, id: string) {
			if (id.endsWith(".md")) {
				return {
					code: `export default ${JSON.stringify(code)};`,
					map: { mappings: "" },
				};
			}
		},
	};
}
function stageNativeAddonPlugin(): Plugin {
	const nativeSourceDir = path.resolve(import.meta.dirname, "../natives/native");
	return {
		name: "stage-pi-natives-addon",
		writeBundle(outputOptions) {
			const outputDir = outputOptions.dir;
			if (!outputDir) throw new Error("Vite main build did not provide an output directory");
			const sourceEntries = fs.readdirSync(nativeSourceDir).filter(entry => /^pi_natives\..+\.node$/.test(entry));
			if (sourceEntries.length === 0) {
				throw new Error(`No pi_natives native addon found in ${nativeSourceDir}`);
			}
			const targetDir = path.resolve(outputDir, "..", "native");
			fs.mkdirSync(targetDir, { recursive: true });
			for (const entry of sourceEntries) {
				fs.copyFileSync(path.join(nativeSourceDir, entry), path.join(targetDir, entry));
			}
		},
	};
}
export default defineConfig({
	plugins: [rawTextPlugin(), stageNativeAddonPlugin()],
	optimizeDeps: {
		exclude: ["fsevents"],
	},
	ssr: {
		external: ["fsevents"],
	},
	build: {
		rollupOptions: {
			external: ["electron", "fsevents", /^node:/],
		},
	},
});
