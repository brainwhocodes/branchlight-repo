import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
	root: "src/renderer",
	publicDir: "../../e2e/public",
	plugins: [svelte()],
	base: "./",
});
