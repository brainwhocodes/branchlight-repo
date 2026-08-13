<script lang="ts">
	import { onMount, tick } from "svelte";
	import type { BrowserViewState } from "../../shared/contracts";

	export let paneId: string;
	export let url: string;
	export let active: boolean;
	export let onCreated: (state: BrowserViewState) => void;
	export let onError: (message: string) => void;

	let host: HTMLDivElement;
	let mounted = false;
	let created = false;
	let frame = 0;

	function scheduleBounds(): void {
		if (!mounted || !created || !active || frame !== 0) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			const rect = host.getBoundingClientRect();
			if (rect.width < 1 || rect.height < 1) return;
			void window.branchlight.setBrowserBounds(paneId, {
				x: rect.left,
				y: rect.top,
				width: rect.width,
				height: rect.height,
			});
		});
	}

	$: if (active) scheduleBounds();

	onMount(() => {
		mounted = true;
		const observer = new ResizeObserver(scheduleBounds);
		observer.observe(host);
		void (async () => {
			try {
				const state = await window.branchlight.createBrowser(paneId, url);
				if (!mounted) {
					void window.branchlight.closeBrowser(paneId);
					return;
				}
				created = true;
				onCreated(state);
				await tick();
				scheduleBounds();
			} catch (error) {
				onError(error instanceof Error ? error.message : String(error));
			}
		})();
		return () => {
			mounted = false;
			created = false;
			observer.disconnect();
			if (frame !== 0) cancelAnimationFrame(frame);
			void window.branchlight.closeBrowser(paneId);
		};
	});
</script>

<div
	bind:this={host}
	class="browser-surface"
	class:is-active={active}
	aria-label="Browser content"
	aria-hidden={!active}
></div>
