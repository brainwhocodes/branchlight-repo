import nunitoUrl from "@fontsource-variable/nunito-sans/index.css?url";
import soraUrl from "@fontsource-variable/sora/index.css?url";
import { mount } from "svelte";
import App from "./App.svelte";
import appUrl from "./styles/app.scss?url";

if (import.meta.env.DEV) document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.remove();

function loadStylesheet(url: string): Promise<void> {
	const result = Promise.withResolvers<void>();
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = url;
	link.addEventListener("load", () => result.resolve(), { once: true });
	link.addEventListener("error", () => result.reject(new Error(`Failed to load stylesheet: ${url}`)), { once: true });
	document.head.append(link);
	return result.promise;
}

await Promise.all([nunitoUrl, soraUrl, appUrl].map(loadStylesheet));

const target = document.getElementById("app");
if (!target) throw new Error("Branchlight renderer mount target is missing");
mount(App, { target });
