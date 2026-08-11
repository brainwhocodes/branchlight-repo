if (import.meta.env.DEV) document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.remove();

const [{ mount }, { default: App }, { default: nunitoUrl }, { default: soraUrl }, { default: appUrl }] =
	await Promise.all([
		import("svelte"),
		import("./App.svelte"),
		import("@fontsource-variable/nunito-sans/index.css?url"),
		import("@fontsource-variable/sora/index.css?url"),
		import("./styles/app.scss?url"),
	]);

for (const url of [nunitoUrl, soraUrl, appUrl]) {
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = url;
	document.head.append(link);
}

const target = document.getElementById("app");
if (!target) throw new Error("Branchlight renderer mount target is missing");
mount(App, { target });
