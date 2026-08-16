import * as fs from "node:fs/promises";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		{
			name: "md-text-loader",
			async load(id) {
				if (id.endsWith(".md") || id.includes(".md?")) {
					const filePath = id.split("?")[0];
					const content = await fs.readFile(filePath, "utf-8");
					return `export default ${JSON.stringify(content)};`;
				}
			},
		},
	],
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		testTimeout: 10_000,
	},
});
