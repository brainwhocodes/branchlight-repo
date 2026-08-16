import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [svelte()],
	optimizeDeps: {
		exclude: ["fsevents", "@oh-my-pi/pi-natives"],
	},
	base: "./",
	build: {
		rollupOptions: {
			input: "src/renderer/index.html",
		},
	},
});
