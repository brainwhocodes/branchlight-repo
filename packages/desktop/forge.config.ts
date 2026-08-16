import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";

const root = path.dirname(fileURLToPath(import.meta.url));
const backendName = process.platform === "win32" ? "omp.exe" : "omp";
const config: ForgeConfig = {
	packagerConfig: {
		name: "Mars Kommander",
		asar: {
			unpackDir: path.join(".vite", "native"),
		},
		prune: false,
		executableName: "Mars Kommander",
		appBundleId: "labs.mars-kommander.desktop",
		win32metadata: {
			CompanyName: "Mars Kommander Labs",
			FileDescription: "Mars Kommander desktop agent workspace",
			ProductName: "Mars Kommander",
			OriginalFilename: "Mars Kommander.exe",
		},
		icon: path.join(root, "resources", "icon"),
		extraResource: [
			path.join(root, "..", "coding-agent", "dist", backendName),
			path.join(root, "THIRD_PARTY_LICENSES.txt"),
			path.join(root, "resources", "rpc-config.yml"),
		],
		ignore: [/\\test\\/, /\\scripts\\check-styles\.ts$/, /[\\/]node_modules[\\/]/],
	},
	rebuildConfig: {},
	makers: [
		new MakerSquirrel({
			name: "branchlight",
			authors: "Branchlight Labs",
			description: "Branchlight desktop agent workspace",
			setupExe: "BranchlightSetup.exe",
			setupIcon: path.join(root, "resources", "icon.ico"),
			noMsi: true,
		}),
	],
	plugins: [
		new VitePlugin({
			build: [
				{ entry: "src/main/main.ts", config: "vite.main.config.ts" },
				{ entry: "src/main/preload.ts", config: "vite.preload.config.ts" },
			],
			renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
		}),
		new FusesPlugin({
			version: FuseVersion.V1,
			[FuseV1Options.RunAsNode]: false,
			[FuseV1Options.EnableCookieEncryption]: true,
			[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
			[FuseV1Options.EnableNodeCliInspectArguments]: false,
			[FuseV1Options.OnlyLoadAppFromAsar]: true,
			[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
		}),
	],
};

export default config;
