import path from "node:path";

const launcher = path.resolve(import.meta.dir, "check-svelte.cjs");
const child = Bun.spawn(["node", launcher, ...Bun.argv.slice(2)], {
	stderr: "inherit",
	stdout: "inherit",
});

process.exit(await child.exited);
