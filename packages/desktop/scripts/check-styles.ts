import * as path from "node:path";
import * as sass from "sass";

sass.compile("src/renderer/styles/app.scss", {
	loadPaths: [path.resolve("node_modules"), path.resolve("../../node_modules")],
	style: "expanded",
	quietDeps: false,
	logger: {
		// Bulma 1.0.4 emits Sass's legacy if() deprecations under Sass 1.102.
		// Keep dependency warnings visible while making application warnings fatal.
		warn(message, options) {
			if (String(options.span?.url ?? "").includes("node_modules") || message.includes("repetitive deprecation"))
				return;
			throw new Error(`Sass warning: ${message}`);
		},
	},
});
process.stdout.write("Sass check passed\n");
