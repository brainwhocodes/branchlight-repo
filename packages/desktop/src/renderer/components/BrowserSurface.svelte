<script lang="ts">
	import { onMount, tick } from "svelte";
	import type { BrowserBounds, BrowserViewState } from "../../shared/contracts";
	export let paneId: string;
	export let url: string;
	export let workspaceId: string;
	export let tabId: string;
	export let active: boolean;
	export let onCreated: (state: BrowserViewState) => void;
	export let onError: (message: string) => void;

	let host: HTMLDivElement;
	let mounted = false;
	let created = false;
	let frame = 0;
	let lastSentBounds: BrowserBounds | undefined;

	function scheduleBounds(): void {
		if (!mounted || !created || !active || frame !== 0) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			if (!mounted || !created || !active || !host) return;
			const rect = host.getBoundingClientRect();
			if (
				!Number.isFinite(rect.left) ||
				!Number.isFinite(rect.top) ||
				!Number.isFinite(rect.width) ||
				!Number.isFinite(rect.height)
			) {
				return;
			}
			const x = Math.round(rect.left);
			const y = Math.round(rect.top);
			const width = Math.round(rect.width);
			const height = Math.round(rect.height);
			if (width < 1 || height < 1) return;

			if (
				lastSentBounds &&
				lastSentBounds.x === x &&
				lastSentBounds.y === y &&
				lastSentBounds.width === width &&
				lastSentBounds.height === height
			) {
				return;
			}

			const nextBounds = { x, y, width, height };
			lastSentBounds = nextBounds;
			void window.branchlight.setBrowserBounds(paneId, nextBounds);
		});
	}

	$: if (active) {
		lastSentBounds = undefined;
		scheduleBounds();
	}

	onMount(() => {
		mounted = true;
		const observer = new ResizeObserver(scheduleBounds);
		observer.observe(host);

		window.addEventListener("resize", scheduleBounds);
		window.visualViewport?.addEventListener("resize", scheduleBounds);
		window.visualViewport?.addEventListener("scroll", scheduleBounds);
		document.addEventListener("transitionend", scheduleBounds);
		document.addEventListener("animationend", scheduleBounds);

		void (async () => {
			try {
				const state = await window.branchlight.createBrowser({ id: paneId, url, workspaceId, tabId });
				if (!mounted) return;
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
			window.removeEventListener("resize", scheduleBounds);
			window.visualViewport?.removeEventListener("resize", scheduleBounds);
			window.visualViewport?.removeEventListener("scroll", scheduleBounds);
			document.removeEventListener("transitionend", scheduleBounds);
			document.removeEventListener("animationend", scheduleBounds);
			if (frame !== 0) cancelAnimationFrame(frame);
		};
	});
</script>

<div
	bind:this={host}
	class="browser-surface"
	class:is-active={active}
	role="region"
	aria-label="Browser content"
	aria-hidden={!active}
></div>
