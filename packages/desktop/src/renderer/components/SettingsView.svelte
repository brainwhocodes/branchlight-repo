<script lang="ts">
	import { onMount, tick } from "svelte";
	import type { BranchlightSettings, UpdateBranchlightSettingsInput } from "../../shared/contracts";

	export let onBack: () => void;
	export let onSettingsChange: ((settings: BranchlightSettings) => void) | undefined = undefined;

	type SettingsTabId = "general" | "terminal" | "browser" | "workspace";

	const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTabId; label: string }> = [
		{ id: "general", label: "General" },
		{ id: "terminal", label: "Terminal" },
		{ id: "browser", label: "Browser" },
		{ id: "workspace", label: "Workspace" },
	];

	let selectedTab: SettingsTabId = "general";
	let settings: BranchlightSettings | undefined;
	let statusMessage = "";
	let errorMessage = "";
	let loading = true;
	let saving = false;
	let writeQueue = Promise.resolve();

	onMount(() => {
		void loadSettings();
	});

	async function loadSettings(announce = false): Promise<void> {
		loading = true;
		errorMessage = "";
		if (announce) statusMessage = "";
		try {
			settings = await window.branchlight.getAppSettings();
			if (announce) statusMessage = "Settings refreshed.";
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			loading = false;
		}
	}

	async function updateField(updates: UpdateBranchlightSettingsInput, label: string): Promise<void> {
		saving = true;
		errorMessage = "";
		writeQueue = writeQueue.then(async () => {
			try {
				settings = await window.branchlight.updateAppSettings(updates);
				if (settings) onSettingsChange?.(settings);
				statusMessage = `${label} updated.`;
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : String(error);
			} finally {
				saving = false;
			}
		});
		await writeQueue;
	}

	async function resetDefaults(): Promise<void> {
		saving = true;
		errorMessage = "";
		try {
			settings = await window.branchlight.resetAppSettings();
			if (settings) onSettingsChange?.(settings);
			statusMessage = "Reset to default settings.";
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			saving = false;
		}
	}
	function handleSettingsTabKeydown(event: KeyboardEvent, index: number): void {
		let nextIndex: number | undefined;
		if (event.key === "ArrowRight" || event.key === "ArrowDown") {
			nextIndex = (index + 1) % SETTINGS_TABS.length;
		} else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
			nextIndex = (index - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
		} else if (event.key === "Home") {
			nextIndex = 0;
		} else if (event.key === "End") {
			nextIndex = SETTINGS_TABS.length - 1;
		}
		if (nextIndex !== undefined) {
			event.preventDefault();
			const nextTab = SETTINGS_TABS[nextIndex];
			selectedTab = nextTab.id;
			void tick().then(() => {
				document.getElementById(`tab-${nextTab.id}`)?.focus();
			});
		}
	}

</script>

<main class="settings-page" aria-labelledby="settings-title" aria-busy={loading || saving}>
	<div class="settings-inner">
		<header class="settings-header">
			<div class="settings-heading">
				<span class="settings-kicker">Application preferences</span>
				<h1 id="settings-title">Settings</h1>
				<p>Configure Branchlight appearance, terminal, browser, and workspace preferences.</p>
			</div>
			<div class="settings-header-actions">
				<button
					type="button"
					class="settings-button secondary"
					disabled={loading || saving}
					onclick={() => void loadSettings(true)}
				>
					Refresh
				</button>
				<button
					type="button"
					class="settings-button secondary"
					disabled={loading || saving}
					onclick={() => void resetDefaults()}
				>
					Reset defaults
				</button>
				<button type="button" class="settings-button secondary" onclick={onBack}>Back to workspace</button>
			</div>
		</header>

		{#if errorMessage}
			<div class="settings-feedback error" role="alert">
				<strong>Settings error</strong>
				<span>{errorMessage}</span>
			</div>
		{:else if statusMessage}
			<p class="settings-feedback" role="status">{statusMessage}</p>
		{/if}

		<section class="settings-section agent-settings-section" aria-labelledby="app-settings-title">
			<header class="settings-section-heading">
				<div>
					<h2 id="app-settings-title">Preferences</h2>
					<p>Desktop preferences stored locally on this machine.</p>
				</div>
			</header>

			<div class="settings-tablist" role="tablist" aria-label="Setting categories">
				{#each SETTINGS_TABS as tab, index (tab.id)}
					<button
						type="button"
						role="tab"
						id={`tab-${tab.id}`}
						aria-controls={`panel-${tab.id}`}
						aria-selected={selectedTab === tab.id}
						tabindex={selectedTab === tab.id ? 0 : -1}
						class:active={selectedTab === tab.id}
						onclick={() => (selectedTab = tab.id)}
						onkeydown={(event) => handleSettingsTabKeydown(event, index)}
					>
						{tab.label}
					</button>
				{/each}
			</div>

			{#if loading && !settings}
				<div class="settings-skeleton" role="status" aria-label="Loading settings">
					<span></span><span></span><span></span><span></span>
				</div>
			{:else if settings}
				{#if selectedTab === "general"}
					<div class="agent-settings-panel" role="tabpanel" id="panel-general" aria-labelledby="tab-general">
						<div class="agent-settings-group">
							<h3>Appearance & Behavior</h3>
							<div class="settings-form-grid">
								<label class="settings-control">
									<div class="settings-control-copy">
										<span class="settings-control-label"><strong>Theme</strong></span>
										<small>Color palette for the desktop window and controls.</small>
									</div>
									<select
										value={settings.theme}
										onchange={(e) => void updateField({ theme: e.currentTarget.value as BranchlightSettings["theme"] }, "Theme")}
									>
										<option value="dark">Dark</option>
										<option value="light">Light</option>
										<option value="system">System</option>
									</select>
								</label>

								<label class="settings-control">
									<div class="settings-control-copy">
										<span class="settings-control-label"><strong>Confirm before closing tabs</strong></span>
										<small>Prompt for confirmation when closing a tab containing active panes.</small>
									</div>
									<input
										type="checkbox"
										checked={settings.confirmCloseTab}
										onchange={(e) => void updateField({ confirmCloseTab: e.currentTarget.checked }, "Tab close confirmation")}
									/>
								</label>
							</div>
						</div>
					</div>
				{:else if selectedTab === "terminal"}
					<div class="agent-settings-panel" role="tabpanel" id="panel-terminal" aria-labelledby="tab-terminal">
						<div class="agent-settings-group">
							<h3>Terminal Shell & Styling</h3>
							<div class="settings-form-grid">
								<label class="settings-control field">
									<div class="settings-control-copy">
										<span class="settings-control-label"><strong>Shell program path</strong></span>
										<small>Default shell executable launched for new terminal panes.</small>
									</div>
									<input
										type="text"
										value={settings.terminal.shell}
										onchange={(e) => void updateField({ terminal: { shell: e.currentTarget.value } }, "Shell")}
									/>
								</label>

								<label class="settings-control field">
									<div class="settings-control-copy">
										<span class="settings-control-label"><strong>Font size (pt)</strong></span>
										<small>Terminal text font size in points.</small>
									</div>
									<select
										value={settings.terminal.fontSize}
										onchange={(e) => void updateField({ terminal: { fontSize: Number(e.currentTarget.value) } }, "Font size")}
									>
										<option value={11}>11 pt</option>
										<option value={12}>12 pt</option>
										<option value={13}>13 pt</option>
										<option value={14}>14 pt (Default)</option>
										<option value={15}>15 pt</option>
										<option value={16}>16 pt</option>
										<option value={18}>18 pt</option>
										<option value={20}>20 pt</option>
									</select>
								</label>

								<label class="settings-control field">
									<div class="settings-control-copy">
										<span class="settings-control-label"><strong>Font family</strong></span>
										<small>CSS font family list for terminal text rendering.</small>
									</div>
									<input
										type="text"
										value={settings.terminal.fontFamily}
										onchange={(e) => void updateField({ terminal: { fontFamily: e.currentTarget.value } }, "Font family")}
									/>
								</label>

								<label class="settings-control">
									<div class="settings-control-copy">
										<span class="settings-control-label"><strong>Cursor style</strong></span>
										<small>Terminal cursor shape indicator.</small>
									</div>
									<select
										value={settings.terminal.cursorStyle}
										onchange={(e) => void updateField({ terminal: { cursorStyle: e.currentTarget.value as BranchlightSettings["terminal"]["cursorStyle"] } }, "Cursor style")}
									>
										<option value="bar">Bar</option>
										<option value="block">Block</option>
										<option value="underline">Underline</option>
									</select>
								</label>

								<label class="settings-control">
									<div class="settings-control-copy">
										<span class="settings-control-label"><strong>Cursor blink</strong></span>
										<small>Animate terminal cursor blinking when active.</small>
									</div>
									<input
										type="checkbox"
										checked={settings.terminal.cursorBlink}
										onchange={(e) => void updateField({ terminal: { cursorBlink: e.currentTarget.checked } }, "Cursor blink")}
									/>
								</label>

								<label class="settings-control field">
									<div class="settings-control-copy">
										<span class="settings-control-label"><strong>Scrollback buffer (lines)</strong></span>
										<small>Maximum retained history lines in terminal buffer.</small>
									</div>
									<select
										value={settings.terminal.scrollback}
										onchange={(e) => void updateField({ terminal: { scrollback: Number(e.currentTarget.value) } }, "Scrollback buffer")}
									>
										<option value={2000}>2,000 lines</option>
										<option value={5000}>5,000 lines</option>
										<option value={10000}>10,000 lines (Default)</option>
										<option value={25000}>25,000 lines</option>
										<option value={50000}>50,000 lines</option>
									</select>
								</label>
							</div>
						</div>
					</div>
				{:else if selectedTab === "browser"}
					<div class="agent-settings-panel" role="tabpanel" id="panel-browser" aria-labelledby="tab-browser">
						<div class="agent-settings-group">
							<h3>Embedded Browser Defaults</h3>
							<div class="settings-form-grid">
								<label class="settings-control field">
									<div class="settings-control-copy">
										<span class="settings-control-label"><strong>Default homepage URL</strong></span>
										<small>Address loaded when creating new browser tabs.</small>
									</div>
									<input
										type="text"
										value={settings.browser.defaultUrl}
										onchange={(e) => void updateField({ browser: { defaultUrl: e.currentTarget.value } }, "Default URL")}
									/>
								</label>

								<label class="settings-control field">
									<div class="settings-control-copy">
										<span class="settings-control-label"><strong>Search engine URL template</strong></span>
										<small>Query format used when entering search terms in the address bar.</small>
									</div>
									<input
										type="text"
										value={settings.browser.searchEngine}
										onchange={(e) => void updateField({ browser: { searchEngine: e.currentTarget.value } }, "Search engine")}
									/>
								</label>
							</div>
						</div>
					</div>
				{:else if selectedTab === "workspace"}
					<div class="agent-settings-panel" role="tabpanel" id="panel-workspace" aria-labelledby="tab-workspace">
						<div class="agent-settings-group">
							<h3>Workspace Directory</h3>
							<div class="settings-form-grid">
								<label class="settings-control field">
									<div class="settings-control-copy">
										<span class="settings-control-label"><strong>Default root directory</strong></span>
										<small>Root folder used for new workspaces and default terminals.</small>
									</div>
									<input
										type="text"
										value={settings.workspace.defaultPath}
										onchange={(e) => void updateField({ workspace: { defaultPath: e.currentTarget.value } }, "Workspace path")}
									/>
								</label>
							</div>
						</div>
					</div>
				{/if}
			{/if}
		</section>
	</div>
</main>
