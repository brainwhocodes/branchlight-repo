import { defineConfig } from "vite";

export default defineConfig({
	build: {
		rollupOptions: {
			external: [
				"electron",
				"node:child_process",
				"node:fs",
				"node:fs/promises",
				"node:path",
				"node:os",
				"node:url",
				"node:crypto",
			],
		},
	},
});
