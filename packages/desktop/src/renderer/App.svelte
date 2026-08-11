<script lang="ts">
  import { onMount, tick } from "svelte";
  import InfoCircle from "@solar-icons/svelte/linear/info-circle";
  import type { AgentSettingTab, AgentSettingValue, AgentSettingView, AuthAccountView, AuthEvent, BootstrapSnapshot, BranchlightEvent, ExtensionView, FileDiffView, InterruptMode, ModelOption, OpenRouterModelRouting, QueueMode, SessionKind, SessionSnapshot, SlashCommand, SubagentView, ThinkingLevel, TimelineItem } from "../shared/contracts";
  import { changedFiles, projectTimeline } from "../shared/projection";
  import BranchMark from "./components/BranchMark.svelte";
  import FileDiffInspector from "./components/FileDiffInspector.svelte";
  import ModelCapabilityIcons from "./components/ModelCapabilityIcons.svelte";
  import OpenRouterModelAccordion from "./components/OpenRouterModelAccordion.svelte";
  import TimelineEntry from "./components/TimelineEntry.svelte";
  import { commandInsertion, searchSlashCommands, slashCommandQuery } from "./command-search";
  import CommandMenu from "./components/CommandMenu.svelte";

  type SettingKey = "model" | "thinking" | "fast" | "steering" | "follow-up" | "interrupt" | "compaction" | "retry";
  const AGENT_SETTING_TABS: ReadonlyArray<{ id: AgentSettingTab; label: string }> = [
    { id: "model", label: "Model defaults" },
    { id: "appearance", label: "Media" },
    { id: "interaction", label: "Safety" },
    { id: "context", label: "Context" },
    { id: "tools", label: "Tools" },
    { id: "tasks", label: "Delegation" },
  ];
  let bootstrap: BootstrapSnapshot | undefined;
  let kind: SessionKind = "work";
  let activeId = "";
  let current: SessionSnapshot | undefined;
  let draft = "";
  let errorMessage = "";
  let notice = "";
  let extensionStatus = "";
  let extensionWidget = "";
  let extensionTitle = "";
  let aboutOpen = false;
  let aboutButton: HTMLButtonElement | undefined;
  let loading = false;
  let loadingOlder = false;
  let reasoningLoading = new Set<string>();
  let openReasoning = new Set<string>();
  let renameValue = "";
  let renaming = false;
  let pendingExtension: ExtensionView | undefined;
  let selectedSubagent = "";
  let subagentTranscript = "";
  let subagentByte = 0;
  let subagentLoading = false;
  let unsubscribe: (() => void) | undefined;
  let renderedTimeline: TimelineItem[] = [];
  let timelineSource: TimelineItem[] | undefined;
  let timelineRenderToken = 0;
  let timelineScrollToken = 0;
  let timelineSessionSource: string | undefined;
  let timelineScroller: HTMLDivElement | undefined;
  let followTimeline = true;
  let view: "workspace" | "settings" = "workspace";
  let authAccounts: AuthAccountView[] = [];
  let authBusyProvider = "";
  let authStatusMessage = "";
  let authQuery = "";
  let authPrompt: Extract<AuthEvent, { type: "prompt" }> | undefined;
  let authPromptValue = "";
  let unsubscribeAuth: (() => void) | undefined;
  let availableCommands: SlashCommand[] = [];
  let availableModels: ModelOption[] = [];
  let modelQuery = "";
  let modelProviderFilter = "all";
  let commandsLoading = false;
  let commandError = "";
  let commandMenuDismissed = false;
  let selectedCommandIndex = 0;
  let composerInput: HTMLTextAreaElement | undefined;
  let modelsLoading = false;
  const EMPTY_PROVIDER_IDS = new Set<string>();
  let expandedOpenRouterModel = "";
  let openRouterRouting = new Map<string, OpenRouterModelRouting>();
  let openRouterRoutingLoading = new Set<string>();
  let openRouterRoutingErrors = new Map<string, string>();
  let openRouterProviderBusy = new Map<string, Set<string>>();
  let settingsRefreshing = false;
  let settingsBusy = new Set<SettingKey>();
  let settingsStatusMessage = "";
  let agentSettings: AgentSettingView[] = [];
  let agentSettingsBusy = new Set<string>();
  let selectedAgentSettingsTab: AgentSettingTab = "model";
  let selectedDiffPath = "";
  let selectedDiff: FileDiffView | undefined;
  let diffLoading = false;
  let diffError = "";
  let diffRequestToken = 0;
  let inspectorPanel: HTMLElement | undefined;

  $: sessions = bootstrap?.registry.sessions.filter(session => session.kind === kind) ?? [];
  $: hasSessions = sessions.length > 0;
  $: isRunning = current?.state === "running";
  $: canCompose = current !== undefined && current.state !== "starting" && current.state !== "stopping" && current.state !== "error";
  $: timelineItems = projectTimeline(kind, current?.timeline ?? []);
  $: {
    const sessionId = current?.record.id;
    if (timelineItems !== timelineSource || sessionId !== timelineSessionSource) {
      const previous = timelineSource;
      const sameSession = sessionId === timelineSessionSource;
      timelineSource = timelineItems;
      timelineSessionSource = sessionId;
      if (sameSession && previous && timelineExtends(previous, timelineItems)) {
        timelineRenderToken += 1;
        renderedTimeline = timelineItems;
      } else {
        followTimeline = true;
        void renderTimeline(timelineItems, !sameSession, sessionId);
      }
    }
  }
  $: visibleTimeline = renderedTimeline;
  $: hiddenTimelineCount = current?.timelineStart ?? 0;
  $: outputFiles = changedFiles(current?.timeline ?? []);
  $: selectedAgent = current?.subagents.find(agent => agent.id === selectedSubagent);
  $: commandQuery = slashCommandQuery(draft);
  $: commandMatches = commandQuery === null ? [] : searchSlashCommands(availableCommands, commandQuery);
  $: commandMenuVisible = commandQuery !== null && !commandMenuDismissed && canCompose;
  $: if (selectedCommandIndex >= commandMatches.length) selectedCommandIndex = Math.max(0, commandMatches.length - 1);
  $: modelProviders = Array.from(new Set(availableModels.map(model => model.provider))).sort((left, right) => left.localeCompare(right));
  $: filteredModels = filterModelOptions(availableModels, modelQuery, modelProviderFilter, current?.model);
  $: visibleModels = filteredModels.slice(0, 120);
  $: filteredAuthAccounts = filterAuthAccounts(authAccounts, authQuery);
  $: selectedModelOption = availableModels.find(model => modelIdentifier(model) === current?.model);
  $: signedInAccountCount = authAccounts.filter(account => account.signedIn).length;
  $: availableAgentSettingTabs = AGENT_SETTING_TABS.filter(tab => agentSettings.some(setting => setting.tab === tab.id));
  $: if (availableAgentSettingTabs.length > 0 && !availableAgentSettingTabs.some(tab => tab.id === selectedAgentSettingsTab)) {
    selectedAgentSettingsTab = availableAgentSettingTabs[0].id;
  }
  $: agentSettingGroups = groupAgentSettings(agentSettings, selectedAgentSettingsTab);

  onMount(() => {
    unsubscribe = window.branchlight.onEvent(handleEvent);
    unsubscribeAuth = window.branchlight.onAuthEvent(handleAuthEvent);
    void (async () => {
      try {
        bootstrap = await window.branchlight.bootstrap();
        authAccounts = await window.branchlight.getAuthStatus();
        const initial = bootstrap.registry.activeByKind[kind] ?? bootstrap.registry.sessions.find(session => session.kind === kind)?.id;
        if (initial) await selectSession(initial);
      } catch (error) { showError(error); }
    })();
    return () => { unsubscribe?.(); unsubscribeAuth?.(); };
  });

  async function selectSession(id: string): Promise<void> {
    resetFileDiff();
    resetOpenRouterModelState();
    openReasoning = new Set();
    activeId = id;
    errorMessage = "";
    try {
      current = await window.branchlight.openSession(id);
      availableCommands = current.commands ?? [];
      commandError = "";
      availableModels = [];
      if (bootstrap) bootstrap = { ...bootstrap, registry: { ...bootstrap.registry, activeByKind: { ...bootstrap.registry.activeByKind, [kind]: id } } };
      await tick();
      await scrollTimelineToEnd(true, id);
    } catch (error) { showError(error); }
  }

  async function selectKind(next: SessionKind): Promise<void> {
    kind = next;
    resetFileDiff();
    selectedSubagent = "";
    subagentTranscript = "";
    const id = bootstrap?.registry.activeByKind[next] ?? bootstrap?.registry.sessions.find(session => session.kind === next)?.id;
    if (id) {
      await selectSession(id);
      loading = false;
    } else {
      activeId = "";
      current = undefined;
      loading = false;
      availableCommands = [];
      availableModels = [];
      resetOpenRouterModelState();
    }
  }

  async function openFileDiff(path: string): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    const requestToken = ++diffRequestToken;
    selectedDiffPath = path;
    selectedDiff = undefined;
    diffLoading = true;
    diffError = "";
    await tick();
    inspectorPanel?.focus();
    try {
      const result = await window.branchlight.loadFileDiff(sessionId, path);
      if (requestToken !== diffRequestToken || current?.record.id !== sessionId) return;
      selectedDiff = result;
    } catch (error) {
      if (requestToken !== diffRequestToken || current?.record.id !== sessionId) return;
      diffError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestToken === diffRequestToken) diffLoading = false;
    }
  }

  function resetFileDiff(): void {
    diffRequestToken += 1;
    selectedDiffPath = "";
    selectedDiff = undefined;
    diffLoading = false;
    diffError = "";
  }

  function closeFileDiff(): void {
    resetFileDiff();
    void tick().then(() => inspectorPanel?.focus());
  }

  async function openSelectedFile(): Promise<void> {
    if (!current || !selectedDiffPath) return;
    try {
      await window.branchlight.openWorkspaceFile(current.record.id, selectedDiffPath);
    } catch (error) {
      showError(error);
    }
  }

  async function revealOlder(): Promise<void> {
    if (!current || loadingOlder || hiddenTimelineCount <= 0) return;
    loadingOlder = true;
    try {
      const page = await window.branchlight.loadTimelinePage(current.record.id, hiddenTimelineCount, 100);
      const scroller = timelineScroller;
      const previousHeight = scroller?.scrollHeight ?? 0;
      const previousTop = scroller?.scrollTop ?? 0;
      current = {
        ...current,
        timeline: [...page.items, ...current.timeline],
        timelineStart: page.start,
        timelineTotal: page.total,
      };
      await tick();
      if (scroller && scroller === timelineScroller) {
        scroller.scrollTop = previousTop + scroller.scrollHeight - previousHeight;
        followTimeline = timelineAtBottom();
      }
    } catch (error) {
      showError(error);
    } finally {
      loadingOlder = false;
    }
  }
  async function renderTimeline(
    items: TimelineItem[],
    forceLatest = false,
    sessionId = timelineSessionSource,
  ): Promise<void> {
    const token = ++timelineRenderToken;
    const shouldFollow = forceLatest || followTimeline;
    renderedTimeline = [];
    for (let start = 0; start < items.length; start += 5) {
      if (token !== timelineRenderToken) return;
      const end = Math.min(start + 5, items.length);
      renderedTimeline = items.slice(0, end);
      if (end < items.length) await nextAnimationFrame();
    }
    if (token !== timelineRenderToken || sessionId !== timelineSessionSource) return;
    if (forceLatest) await scrollTimelineToEnd(true, sessionId);
    else if (shouldFollow && followTimeline) await scrollTimelineToEnd();
  }

  function timelineExtends(previous: TimelineItem[], next: TimelineItem[]): boolean {
    if (previous.length > next.length) return false;
    const prefixMatches = previous.every((item, index) => item.id === next[index]?.id);
    if (prefixMatches) return true;
    const offset = next.length - previous.length;
    return previous.every((item, index) => item.id === next[index + offset]?.id);
  }

  function timelineAtBottom(): boolean {
    if (!timelineScroller) return true;
    return timelineScroller.scrollHeight - timelineScroller.scrollTop - timelineScroller.clientHeight <= 48;
  }

  function handleTimelineScroll(): void {
    timelineScrollToken += 1;
    followTimeline = timelineAtBottom();
  }

  async function scrollTimelineToEnd(force = false, sessionId = timelineSessionSource): Promise<void> {
    const token = ++timelineScrollToken;
    await tick();
    if (!timelineScroller || sessionId !== timelineSessionSource || (!force && token !== timelineScrollToken)) return;
    timelineScroller.scrollTop = timelineScroller.scrollHeight;
    followTimeline = true;
  }

  function nextAnimationFrame(): Promise<void> {
    const gate = Promise.withResolvers<void>();
    requestAnimationFrame(() => gate.resolve());
    return gate.promise;
  }

  async function createSession(): Promise<void> {
    loading = true;
    errorMessage = "";
    try {
      const snapshot = await window.branchlight.chooseAndCreate(kind);
      if (snapshot) {
        current = snapshot;
        activeId = snapshot.record.id;
        if (bootstrap) bootstrap = { ...bootstrap, registry: { ...bootstrap.registry, sessions: [...bootstrap.registry.sessions, snapshot.record], activeByKind: { ...bootstrap.registry.activeByKind, [kind]: snapshot.record.id } } };
        availableCommands = snapshot.commands ?? [];
        availableModels = [];
        resetOpenRouterModelState();
      }
    } catch (error) { showError(error); }
    finally { loading = false; }
  }

  async function resumeSession(): Promise<void> {
    if (!current) return;
    loading = true;
    try {
      current = await window.branchlight.resume(current.record.id);
      availableCommands = current.commands ?? [];
      void loadCommands(current.record.id);
    }
    catch (error) { showError(error); }
    finally { loading = false; }
  }

  async function stopSession(): Promise<void> {
    if (!current) return;
    if (current.state === "running" && !window.confirm("Stop Branchlight and interrupt this turn?")) return;
    loading = true;
    try { current = await window.branchlight.stop(current.record.id); }
    catch (error) { showError(error); }
    finally { loading = false; }
  }

  async function sendPrimary(): Promise<void> {
    const text = draft.trim();
    if (!text || !current) return;
    const sessionId = current.record.id;
    const optimisticId = appendOptimisticUserMessage(sessionId, text);
    draft = "";
    commandMenuDismissed = true;
    errorMessage = "";
    try {
      if (isRunning) await window.branchlight.steer(sessionId, text);
      else await window.branchlight.prompt(sessionId, text);
    } catch (error) {
      removeOptimisticUserMessage(sessionId, optimisticId);
      draft = text;
      commandMenuDismissed = false;
      showError(error);
    }
  }

  async function queueNext(): Promise<void> {
    if (!current || !draft.trim()) return;
    const text = draft.trim();
    const sessionId = current.record.id;
    const optimisticId = appendOptimisticUserMessage(sessionId, text);
    draft = "";
    try {
      await window.branchlight.queueFollowUp(sessionId, text);
      notice = "Queued for the next turn";
    } catch (error) {
      removeOptimisticUserMessage(sessionId, optimisticId);
      draft = text;
      showError(error);
    }
  }

  async function abortTurn(): Promise<void> {
    if (!current) return;
    try { await window.branchlight.abort(current.record.id); notice = "Abort requested"; }
    catch (error) { showError(error); }
  }

  async function saveRename(): Promise<void> {
    if (!current || !renameValue.trim()) return;
    try {
      current = await window.branchlight.rename(current.record.id, renameValue.trim());
      if (bootstrap) bootstrap = { ...bootstrap, registry: { ...bootstrap.registry, sessions: bootstrap.registry.sessions.map(session => session.id === current?.record.id ? current.record : session) } };
      renaming = false;
    } catch (error) { showError(error); }
  }

  async function changeSetting(type: "thinking" | "fast", value: ThinkingLevel | boolean): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    if (type === "thinking" && typeof value === "string") {
      await saveSessionSetting("thinking", () => window.branchlight.setThinking(sessionId, value), { thinkingLevel: value }, "Thinking level updated.");
    }
    if (type === "fast" && typeof value === "boolean") {
      await saveSessionSetting("fast", () => window.branchlight.setFastMode(sessionId, value), { fastMode: value }, value ? "Fast mode enabled." : "Fast mode disabled.");
    }
  }

  async function changeModel(model: ModelOption): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    await saveSessionSetting(
      "model",
      () => window.branchlight.setModel(sessionId, model.provider, model.id),
      { model: `${model.provider}/${model.id}` },
      `Model changed to ${model.name}.`,
    );
  }

  async function changeQueueSetting(kind: "steering" | "follow-up", mode: QueueMode): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    await saveSessionSetting(
      kind,
      () => window.branchlight.setQueueMode(sessionId, kind, mode),
      kind === "steering" ? { steeringMode: mode } : { followUpMode: mode },
      `${kind === "steering" ? "Steering" : "Follow-up"} delivery updated.`,
    );
  }

  async function changeInterruptSetting(mode: InterruptMode): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    await saveSessionSetting(
      "interrupt",
      () => window.branchlight.setInterruptMode(sessionId, mode),
      { interruptMode: mode },
      "Interrupt behavior updated.",
    );
  }

  async function changeAutoCompaction(enabled: boolean): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    await saveSessionSetting(
      "compaction",
      () => window.branchlight.setAutoCompaction(sessionId, enabled),
      { autoCompactionEnabled: enabled },
      enabled ? "Automatic compaction enabled." : "Automatic compaction disabled.",
    );
  }

  async function changeAutoRetry(enabled: boolean): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    await saveSessionSetting(
      "retry",
      () => window.branchlight.setAutoRetry(sessionId, enabled),
      { autoRetryEnabled: enabled },
      enabled ? "Automatic retry enabled." : "Automatic retry disabled.",
    );
  }

  async function saveSessionSetting(
    key: SettingKey,
    action: () => Promise<void>,
    patch: Partial<SessionSnapshot>,
    message: string,
  ): Promise<void> {
    if (!current || settingsBusy.has(key)) return;
    const sessionId = current.record.id;
    setSettingBusy(key, true);
    settingsStatusMessage = "";
    try {
      await action();
      if (current?.record.id === sessionId) current = { ...current, ...patch };
      settingsStatusMessage = message;
    } catch (error) {
      if (current?.record.id === sessionId) current = { ...current };
      settingsStatusMessage = error instanceof Error ? error.message : String(error);
      showError(error);
    } finally {
      setSettingBusy(key, false);
    }
  }

  function setSettingBusy(key: SettingKey, busy: boolean): void {
    const next = new Set(settingsBusy);
    if (busy) next.add(key);
    else next.delete(key);
    settingsBusy = next;
  }

  async function changeAgentSetting(setting: AgentSettingView, value: AgentSettingValue): Promise<void> {
    if (agentSettingsBusy.has(setting.path)) return;
    setAgentSettingBusy(setting.path, true);
    settingsStatusMessage = "";
    const sessionId =
      current && current.state !== "stopped" && current.state !== "error" ? current.record.id : undefined;
    try {
      const updated = await window.branchlight.setAgentSetting(sessionId, setting.path, value);
      agentSettings = agentSettings.map(candidate => candidate.path === updated.path ? updated : candidate);
      settingsStatusMessage = `${updated.label} updated.${updated.apply === "next-session" ? " Starts with the next session." : ""}`;
    } catch (error) {
      settingsStatusMessage = error instanceof Error ? error.message : String(error);
      showError(error);
    } finally {
      setAgentSettingBusy(setting.path, false);
    }
  }

  function setAgentSettingBusy(path: string, busy: boolean): void {
    const next = new Set(agentSettingsBusy);
    if (busy) next.add(path);
    else next.delete(path);
    agentSettingsBusy = next;
  }

  function selectedAgentSettingValue(setting: AgentSettingView, rawValue: string): AgentSettingValue | undefined {
    return setting.options?.find(option => String(option.value) === rawValue)?.value;
  }

  function changeAgentSettingFromSelect(setting: AgentSettingView, event: Event): void {
    const value = selectedAgentSettingValue(setting, (event.currentTarget as HTMLSelectElement).value);
    if (value !== undefined) void changeAgentSetting(setting, value);
  }

  async function loadCommands(sessionId: string): Promise<void> {
    if (commandsLoading) return;
    commandsLoading = true;
    commandError = "";
    try {
      const commands = await window.branchlight.getAvailableCommands(sessionId);
      if (current?.record.id === sessionId) availableCommands = commands;
    } catch (error) {
      if (current?.record.id === sessionId) commandError = error instanceof Error ? error.message : String(error);
    } finally {
      commandsLoading = false;
    }
  }

  async function loadModels(sessionId: string): Promise<void> {
    if (modelsLoading) return;
    modelsLoading = true;
    try {
      const models = await window.branchlight.getAvailableModels(sessionId);
      if (current?.record.id === sessionId) availableModels = models;
    } finally {
      modelsLoading = false;
    }
  }
  function resetOpenRouterModelState(): void {
    expandedOpenRouterModel = "";
    openRouterRouting = new Map();
    openRouterRoutingLoading = new Set();
    openRouterRoutingErrors = new Map();
    openRouterProviderBusy = new Map();
  }

  function toggleOpenRouterModel(model: ModelOption): void {
    if (expandedOpenRouterModel === model.id) {
      expandedOpenRouterModel = "";
      return;
    }
    expandedOpenRouterModel = model.id;
    if (!openRouterRouting.has(model.id) && !openRouterRoutingLoading.has(model.id)) {
      void loadOpenRouterModelRouting(model.id);
    }
  }

  async function loadOpenRouterModelRouting(modelId: string): Promise<void> {
    if (!current || openRouterRoutingLoading.has(modelId)) return;
    const sessionId = current.record.id;
    openRouterRoutingLoading = new Set(openRouterRoutingLoading).add(modelId);
    const errors = new Map(openRouterRoutingErrors);
    errors.delete(modelId);
    openRouterRoutingErrors = errors;
    try {
      const routing = await window.branchlight.getOpenRouterModelRouting(sessionId, modelId);
      if (current?.record.id === sessionId) {
        const next = new Map(openRouterRouting);
        next.set(modelId, routing);
        openRouterRouting = next;
      }
    } catch (error) {
      if (current?.record.id === sessionId) {
        const next = new Map(openRouterRoutingErrors);
        next.set(modelId, error instanceof Error ? error.message : String(error));
        openRouterRoutingErrors = next;
      }
    } finally {
      const next = new Set(openRouterRoutingLoading);
      next.delete(modelId);
      openRouterRoutingLoading = next;
    }
  }

  async function changeOpenRouterProvider(model: ModelOption, providerId: string, enabled: boolean): Promise<void> {
    if (!current) return;
    const sessionId = current.record.id;
    const providerName = openRouterRouting.get(model.id)?.providers.find(provider => provider.id === providerId)?.name ?? providerId;
    setOpenRouterProviderBusy(model.id, providerId, true);
    const errors = new Map(openRouterRoutingErrors);
    errors.delete(model.id);
    openRouterRoutingErrors = errors;
    try {
      const routing = await window.branchlight.setOpenRouterProviderEnabled(sessionId, model.id, providerId, enabled);
      if (current?.record.id === sessionId) {
        const next = new Map(openRouterRouting);
        next.set(model.id, routing);
        openRouterRouting = next;
        settingsStatusMessage = `${providerName} ${enabled ? "enabled" : "excluded"} for ${model.name}.`;
      }
    } catch (error) {
      if (current?.record.id === sessionId) {
        const message = error instanceof Error ? error.message : String(error);
        const next = new Map(openRouterRoutingErrors);
        next.set(model.id, message);
        openRouterRoutingErrors = next;
        settingsStatusMessage = message;
      }
    } finally {
      setOpenRouterProviderBusy(model.id, providerId, false);
    }
  }

  function setOpenRouterProviderBusy(modelId: string, providerId: string, busy: boolean): void {
    const next = new Map(openRouterProviderBusy);
    const providers = new Set(next.get(modelId) ?? EMPTY_PROVIDER_IDS);
    if (busy) providers.add(providerId);
    else providers.delete(providerId);
    if (providers.size > 0) next.set(modelId, providers);
    else next.delete(modelId);
    openRouterProviderBusy = next;
  }

  function openSettings(): void {
    view = "settings";
    settingsStatusMessage = "";
    void refreshSettingsData();
  }

  async function refreshSettingsData(): Promise<void> {
    if (settingsRefreshing) return;
    settingsRefreshing = true;
    const activeSessionId =
      current && current.state !== "stopped" && current.state !== "error" ? current.record.id : undefined;
    const tasks: Promise<unknown>[] = [
      window.branchlight.getAuthStatus().then(accounts => { authAccounts = accounts; }),
      window.branchlight.getAgentSettings(activeSessionId).then(settings => { agentSettings = settings; }),
    ];
    if (activeSessionId) tasks.push(loadModels(activeSessionId));
    const results = await Promise.allSettled(tasks);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") settingsStatusMessage = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
    settingsRefreshing = false;
  }

  function handleComposerInput(event: Event): void {
    const value = (event.currentTarget as HTMLTextAreaElement).value;
    commandMenuDismissed = false;
    selectedCommandIndex = 0;
    if (slashCommandQuery(value) !== null && availableCommands.length === 0 && current) void loadCommands(current.record.id);
  }

  function handleComposerKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (commandMenuVisible) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        selectedCommandIndex = commandMatches.length === 0
          ? 0
          : (selectedCommandIndex + direction + commandMatches.length) % commandMatches.length;
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        commandMenuDismissed = true;
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        const selected = commandMatches[selectedCommandIndex];
        if (selected) applyCommand(selected);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendPrimary();
    }
  }

  function applyCommand(command: SlashCommand): void {
    draft = commandInsertion(command);
    commandMenuDismissed = true;
    void tick().then(() => composerInput?.focus());
  }
  function modelIdentifier(model: ModelOption): string {
    return `${model.provider}/${model.id}`;
  }

  function filterModelOptions(
    models: ModelOption[],
    query: string,
    provider: string,
    selectedModel: string | undefined,
  ): ModelOption[] {
    const needle = query.trim().toLowerCase();
    return models
      .filter(model => provider === "all" || model.provider === provider)
      .filter(model => !needle || `${model.name} ${model.provider} ${model.id}`.toLowerCase().includes(needle))
      .sort((left, right) =>
        Number(modelIdentifier(right) === selectedModel) - Number(modelIdentifier(left) === selectedModel) ||
        left.name.localeCompare(right.name) ||
        left.provider.localeCompare(right.provider),
      );
  }

  function filterAuthAccounts(accounts: AuthAccountView[], query: string): AuthAccountView[] {
    const needle = query.trim().toLowerCase();
    return needle
      ? accounts.filter(account => `${account.name} ${account.provider}`.toLowerCase().includes(needle))
      : accounts;
  }

  function groupAgentSettings(
    settings: AgentSettingView[],
    tab: AgentSettingTab,
  ): Array<{ name: string; settings: AgentSettingView[] }> {
    const groups = new Map<string, AgentSettingView[]>();
    for (const setting of settings) {
      if (setting.tab !== tab) continue;
      const name = setting.group ?? "General";
      const values = groups.get(name);
      if (values) values.push(setting);
      else groups.set(name, [setting]);
    }
    return Array.from(groups, ([name, values]) => ({ name, settings: values }));
  }

  function formatContextWindow(tokens: number | undefined): string | undefined {
    if (!tokens) return undefined;
    if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M context`;
    return `${Math.round(tokens / 1_000)}K context`;
  }

  async function resumeSettingsSession(): Promise<void> {
    await resumeSession();
    if (current && current.state !== "stopped" && current.state !== "error") {
      await loadModels(current.record.id).catch(showError);
    }
  }


  async function inspectSubagent(agent: SubagentView): Promise<void> {
    if (!current) return;
    selectedSubagent = agent.id;
    subagentLoading = true;
    try {
      const result = await window.branchlight.getSubagentMessages(current.record.id, agent.id, subagentByte);
      const value = result as { nextByte?: number; reset?: boolean; messages?: unknown[] };
      if (value.reset) { subagentByte = 0; subagentTranscript = ""; }
      if (Array.isArray(value.messages)) subagentTranscript += value.messages.map(message => formatMessage(message)).join("\n\n");
      if (typeof value.nextByte === "number") subagentByte = value.nextByte;
    } catch (error) { showError(error); }
    finally { subagentLoading = false; }
  }
  async function respondExtension(response: Record<string, unknown>): Promise<void> {
    if (!current || !pendingExtension) return;
    try {
      await window.branchlight.extensionResponse(current.record.id, { id: pendingExtension.id, ...response });
      pendingExtension = undefined;
    } catch (error) { showError(error); }
  }
  async function handleAuthEvent(event: AuthEvent): Promise<void> {
    if (event.type === "progress" || event.type === "auth-url") authStatusMessage = event.message;
    if (event.type === "prompt") {
      authPrompt = event;
      authPromptValue = "";
      authStatusMessage = event.message;
      return;
    }
    if (event.type === "complete") {
      authPrompt = undefined;
      authPromptValue = "";
      authStatusMessage = event.message;
      authAccounts = await window.branchlight.getAuthStatus();
      authBusyProvider = "";
    }
    if (event.type === "error") {
      authPrompt = undefined;
      authBusyProvider = "";
      authStatusMessage = event.message;
    }
  }

  async function loginProvider(account: AuthAccountView): Promise<void> {
    if (!account.available || authBusyProvider) return;
    authBusyProvider = account.provider;
    authStatusMessage = `Starting ${account.name} sign-in…`;
    try {
      authAccounts = await window.branchlight.loginProvider(account.provider);
    } catch (error) {
      authStatusMessage = error instanceof Error ? error.message : String(error);
    } finally {
      authBusyProvider = "";
    }
  }

  async function logoutProvider(account: AuthAccountView): Promise<void> {
    if (authBusyProvider) return;
    authBusyProvider = account.provider;
    try {
      authAccounts = await window.branchlight.logoutProvider(account.provider);
    } catch (error) {
      authStatusMessage = error instanceof Error ? error.message : String(error);
    } finally {
      authBusyProvider = "";
    }
  }

  async function submitAuthPrompt(): Promise<void> {
    const value = authPromptValue;
    authPromptValue = "";
    authPrompt = undefined;
    try { await window.branchlight.respondAuthPrompt(value); }
    catch (error) { authStatusMessage = error instanceof Error ? error.message : String(error); }
  }
  async function cancelAuthPrompt(): Promise<void> {
    authPrompt = undefined;
    authPromptValue = "";
    try { await window.branchlight.respondAuthPrompt(""); } catch { /* login flow surfaces cancellation */ }
  }

  async function loadReasoning(item: TimelineItem): Promise<void> {
    if (!current || item.kind !== "thinking") return;
    openReasoning = new Set(openReasoning).add(item.id);
    if (item.textLoaded !== false || reasoningLoading.has(item.id)) return;
    reasoningLoading = new Set(reasoningLoading).add(item.id);
    try {
      const loaded = await window.branchlight.loadTimelineItem(current.record.id, item.id);
      current = { ...current, timeline: current.timeline.map(candidate => candidate.id === loaded.id ? loaded : candidate) };
    } catch (error) {
      showError(error);
    } finally {
      const next = new Set(reasoningLoading);
      next.delete(item.id);
      reasoningLoading = next;
    }
  }


  async function handleEvent(event: BranchlightEvent): Promise<void> {
    if (event.type === "warning") { notice = event.message ?? "Recovery warning"; return; }
    if (!current || event.sessionId !== current.record.id) return;
    const shouldFollowTimeline = event.type === "timeline" && timelineAtBottom();
    const timelineElement = event.type === "timeline" ? timelineScroller : undefined;
    const previousTimelineScrollTop = timelineElement?.scrollTop;
    if (event.type === "session" && event.record) {
      const record = event.record;
      if (event.state) current = { ...current, record, state: event.state };
      else current = { ...current, record };
      if (bootstrap) {
        bootstrap = {
          ...bootstrap,
          registry: {
            ...bootstrap.registry,
            sessions: bootstrap.registry.sessions.map(session => session.id === record.id ? record : session),
          },
        };
      }
    }
    if (event.type === "commands" && event.commands) {
      availableCommands = event.commands;
      current = { ...current, commands: event.commands };
    }
    if (event.type === "config" && event.config) current = { ...current, ...event.config };
    if (event.type === "timeline" && event.item) {
      const optimisticIndex = event.item.kind === "user"
        ? current.timeline.findIndex(candidate => candidate.id.startsWith("optimistic-user-") && candidate.text === event.item?.text)
        : -1;
      const existed = optimisticIndex >= 0 || current.timeline.some(candidate => candidate.id === event.item?.id);
      const timeline = optimisticIndex >= 0
        ? current.timeline.map((candidate, index) => index === optimisticIndex ? event.item as TimelineItem : candidate)
        : appendTimeline(current.timeline, event.item);
      const timelineTotal = (current.timelineTotal ?? current.timeline.length) + (existed ? 0 : 1);
      current = { ...current, timeline, timelineStart: Math.max(0, timelineTotal - timeline.length), timelineTotal };
    }
    if (event.type === "timeline") {
      if (shouldFollowTimeline) {
        await scrollTimelineToEnd();
      } else if (timelineElement && timelineElement === timelineScroller && previousTimelineScrollTop !== undefined) {
        await tick();
        timelineElement.scrollTop = previousTimelineScrollTop;
        followTimeline = timelineAtBottom();
      }
    }
    if (event.type === "subagents" && event.subagents) current = { ...current, subagents: event.subagents };
    if (event.type !== "extension" || !event.extension) return;
    const extension = event.extension;
    if (extension.method === "cancel") {
      if (!pendingExtension || pendingExtension.id === extension.targetId) pendingExtension = undefined;
      return;
    }
    if (extension.method === "set_editor_text") { draft = extension.text ?? ""; return; }
    if (extension.method === "notify") { notice = extension.message ?? "Extension notification"; return; }
    if (extension.method === "setStatus") { extensionStatus = extension.statusText ?? ""; return; }
    if (extension.method === "setWidget") { extensionWidget = (extension.widgetLines ?? []).join("\n"); return; }
    if (extension.method === "setTitle") { extensionTitle = extension.title ?? ""; return; }
    pendingExtension = extension;
    if (extension.method === "open_url" && extension.url) {
      try { await window.branchlight.openExternal(extension.url); await respondExtension({ cancelled: true }); } catch (error) { showError(error); }
    }
  }

  function closeAbout(): void {
    aboutOpen = false;
    aboutButton?.focus();
  }

  function appendTimeline(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
    const existing = items.findIndex(candidate => candidate.id === item.id);
    if (existing < 0) return [...items, item];
    return items.map((candidate, index) => index === existing ? { ...candidate, ...item } : candidate);
  }

  let optimisticMessageSequence = 0;
  function appendOptimisticUserMessage(sessionId: string, text: string): string {
    optimisticMessageSequence += 1;
    const id = `optimistic-user-${Date.now()}-${optimisticMessageSequence}`;
    if (current?.record.id !== sessionId) return id;
    const timeline = [...current.timeline, { id, kind: "user" as const, text, timestamp: new Date().toISOString() }];
    const timelineTotal = (current.timelineTotal ?? current.timeline.length) + 1;
    current = { ...current, timeline, timelineStart: Math.max(0, timelineTotal - timeline.length), timelineTotal };
    followTimeline = true;
    void scrollTimelineToEnd();
    return id;
  }

  function removeOptimisticUserMessage(sessionId: string, id: string): void {
    if (current?.record.id !== sessionId || !current.timeline.some(item => item.id === id)) return;
    const timeline = current.timeline.filter(item => item.id !== id);
    const timelineTotal = Math.max(0, (current.timelineTotal ?? current.timeline.length) - 1);
    current = { ...current, timeline, timelineStart: Math.max(0, timelineTotal - timeline.length), timelineTotal };
  }

  function showError(error: unknown): void { errorMessage = error instanceof Error ? error.message : String(error); }
  let windowMaximized = false;
  function minimizeWindow(): void { void window.branchlight.minimizeWindow().catch(showError); }
  async function toggleMaximizeWindow(): Promise<void> {
    try { windowMaximized = await window.branchlight.toggleMaximizeWindow(); }
    catch (error) { showError(error); }
  }
  function closeWindow(): void { void window.branchlight.closeWindow().catch(showError); }
  function formatMessage(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "[message]"; }
  function handleTranscriptClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href");
    if (href && !href.startsWith("#")) void window.branchlight.openExternal(href).catch(showError);
  }

  function handleTranscriptKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && selectedDiffPath) {
      closeFileDiff();
      return;
    }
    if (event.key === "Enter" || event.key === " ") handleTranscriptClick(event);
  }
</script>
<svelte:window onclick={handleTranscriptClick} onkeydown={handleTranscriptKeydown} />

<svelte:head><title>Branchlight · {extensionTitle || (kind === "work" ? "Work" : "Code")}</title></svelte:head>

<div class="app-shell">
  <header class="window-bar" aria-label="Window bar">
    <div class="window-drag"><span class="window-bar-title">Branchlight</span><span class="window-bar-meta">Branchlight Labs · local</span></div>
    <div class="window-controls">
      <button type="button" aria-label="Minimize Branchlight" title="Minimize" onclick={minimizeWindow}>−</button>
      <button type="button" aria-label={windowMaximized ? "Restore Branchlight" : "Maximize Branchlight"} title={windowMaximized ? "Restore" : "Maximize"} aria-pressed={windowMaximized} onclick={() => void toggleMaximizeWindow()}>□</button>
      <button type="button" class="close-window" aria-label="Close Branchlight" title="Close" onclick={closeWindow}>×</button>
    </div>
  </header>
  <header class="topbar">
    <div class="brand"><BranchMark size={28} /><div><strong>Branchlight</strong><span>Branchlight Labs</span></div></div>
    <div class="mode-tabs" role="tablist" aria-label="Session type">
      <button class:active={kind === "work"} role="tab" aria-selected={kind === "work"} aria-controls="session-rail" onclick={() => void selectKind("work")}><span class="tab-kicker">01</span>Work</button>
      <button class:active={kind === "code"} role="tab" aria-selected={kind === "code"} aria-controls="session-rail" onclick={() => void selectKind("code")}><span class="tab-kicker">02</span>Code</button>
    </div>
    <div class="top-actions"><span class="connection"><span class="status-dot"></span>{extensionStatus || "Local runtime"}</span><button class="text-button settings-link" aria-label="Open settings" onclick={openSettings}>Settings</button><button bind:this={aboutButton} class="icon-button" title="About Branchlight" aria-label="About Branchlight" onclick={() => aboutOpen = true}><InfoCircle size={18} aria-hidden="true" /></button></div>
  </header>
  {#if view === "workspace"}

  <div class="workspace-grid" class:work-layout={kind === "work"}>
    <aside id="session-rail" class="session-rail" aria-label="{kind === 'work' ? 'Workspaces' : 'Code workspaces'}">
      <div class="rail-heading"><div><span class="eyebrow">{kind === "work" ? "Workspaces" : "Code workspaces"}</span><h1>{kind === "work" ? "Work" : "Code"}</h1></div><button class="small-action" aria-label="Create {kind} session" title="Create {kind} session" disabled={loading} onclick={() => void createSession()}>+</button></div>
      <p class="rail-summary">{kind === "work" ? "Outcome-first sessions for research, documents, and files." : "High-density sessions for implementation, debugging, and review."}</p>
      <div class="session-list" role="listbox" aria-label="Sessions">
        {#each sessions as session (session.id)}
          <button class="session-row" class:selected={activeId === session.id} role="option" aria-selected={activeId === session.id} onclick={() => void selectSession(session.id)}>
            <span class="session-row-mark">{session.title ? session.title.slice(0, 1).toUpperCase() : kind === "work" ? "W" : "C"}</span>
            <span class="session-row-copy"><strong>{session.title ?? (kind === "work" ? "Untitled workspace" : "Untitled code workspace")}</strong><span>{session.cwd}</span></span>
            <span class="session-row-state">{activeId === session.id && current ? current.state : "stopped"}</span>
          </button>
        {:else}
          <div class="rail-empty"><span class="empty-index">00</span><p>No {kind} sessions yet.</p><button class="text-button" onclick={() => void createSession()}>Choose a folder <span>→</span></button></div>
        {/each}
      </div>
      <div class="rail-footer"><span>Sessions are local</span><span class="mono">v0.1</span></div>
    </aside>
    <main class="transcript-pane" aria-live="polite">
      {#if !current}
        <section class="welcome-state"><div class="welcome-mark"><BranchMark size={64} /></div><span class="eyebrow">{kind === "work" ? "Outcome workspace" : "Operator workspace"}</span><h2>{kind === "work" ? "Make the next useful thing." : "Keep the whole technical record in view."}</h2><p>{kind === "work" ? "Choose a local folder to start a focused conversation with OMP. Outputs and collaborators surface here without the implementation noise." : "Start in a repository folder. Tool calls, diffs, commands, reasoning, and subagents stay paired in one reviewable timeline."}</p><button class="primary-button" onclick={() => void createSession()} disabled={loading}>Choose a {kind === "work" ? "workspace" : "code workspace"} <span>→</span></button><div class="prompt-suggestions"><span>{kind === "work" ? "Try asking" : "Start with"}</span><button onclick={() => draft = kind === "work" ? "Research this folder and summarize the useful files." : "Inspect this repository and identify the next implementation step."}>“{kind === "work" ? "Research this folder…" : "Inspect this repository…"}”</button></div></section>
      {:else}
        <div class="transcript-header"><div class="transcript-title"><span class="eyebrow">{kind === "work" ? "Workspace narrative" : "Technical record"}</span><div class="title-line">{#if renaming}<input class="rename-input" bind:value={renameValue} aria-label="Session name" onkeydown={(event) => event.key === "Enter" && void saveRename()} /><button class="inline-save" onclick={() => void saveRename()}>Save</button>{:else}<h2>{current.record.title ?? current.record.cwd.split(/[\\/]/).pop()}</h2><button class="rename-button" title="Rename session" aria-label="Rename session" onclick={() => { renameValue = current?.record.title ?? ""; renaming = true; }}>✎</button>{/if}</div><span class="path-label">{current.record.cwd}</span></div><div class="transcript-actions"><span class="state-pill state-{current.state}"><span></span>{current.state}</span>{#if current.state === "stopped" || current.state === "error"}<button class="secondary-button" onclick={() => void resumeSession()} disabled={loading}>Resume</button>{:else}<button class="danger-button" onclick={() => void stopSession()} disabled={loading}>{current.state === "running" ? "Stop" : "Stop session"}</button>{/if}</div></div>
        <div class="timeline-scroll" bind:this={timelineScroller} onscroll={handleTimelineScroll}>
          {#if current.timeline.length === 0 && current.state === "ready"}<div class="session-empty"><span class="empty-index">01</span><h3>{kind === "work" ? "What outcome should we pursue?" : "What should we inspect or change?"}</h3><p>{kind === "work" ? "Ask for research, a summary, a document, or a set of files." : "Ask for an implementation plan, a debug pass, or a review of the current tree."}</p><div class="suggestion-grid"><button onclick={() => draft = kind === "work" ? "Find the important documents in this workspace and explain them." : "Review the current repository for risks and open issues."}>{kind === "work" ? "Find important documents" : "Review repository risks"}<span>→</span></button><button onclick={() => draft = kind === "work" ? "Create a concise brief from the relevant files." : "Trace the main path and propose a safe fix."}>{kind === "work" ? "Create a concise brief" : "Trace a main path"}<span>→</span></button></div></div>{/if}
          {#if hiddenTimelineCount > 0}<button class="secondary-button older-entries" onclick={() => void revealOlder()} disabled={loadingOlder}>Load 100 older entries <span>({hiddenTimelineCount} remaining)</span></button>{/if}
          {#each visibleTimeline as item (item.id)}
            <TimelineEntry item={item} kind={kind} reasoningLoading={reasoningLoading} openReasoning={openReasoning} onReasoning={loadReasoning} onFile={openFileDiff} />
          {/each}
          {#if current.state === "starting"}<div class="lifecycle-card"><span class="spinner"></span><div><strong>Starting local runtime</strong><span>Loading OMP state and transcript…</span></div></div>{/if}
          {#if current.state === "running"}<div class="lifecycle-card live"><span class="pulse"></span><div><strong>Turn in progress</strong><span>{kind === "work" ? "Building the outcome…" : "Streaming technical work…"}</span></div></div>{/if}
          {#if current.state === "error"}<div class="error-card"><strong>Runtime stopped unexpectedly</strong><span>{current.warning ?? "Resume to reconnect and recover the saved transcript."}</span><button class="secondary-button" onclick={() => void resumeSession()}>Reconnect</button></div>{/if}
        </div>
      {/if}

      {#if current}
        <section class="composer-wrap">
        {#if extensionWidget}<pre class="extension-widget" role="status">{extensionWidget}</pre>{/if}
      {#if commandMenuVisible}
        <CommandMenu
          commands={commandMatches}
          error={commandError}
          loading={commandsLoading}
          selectedIndex={selectedCommandIndex}
          onSelect={applyCommand}
          onHighlight={(index) => selectedCommandIndex = index}
        />
      {/if}
          <div class="composer-meta">
            <span>{commandError && commandQuery !== null ? commandError : isRunning ? "Steer the current turn or queue the next one" : "Enter sends · Shift+Enter adds a line break · / opens commands"}</span>
            <span class="mono">{current.queuedMessageCount ?? 0} queued</span>
          </div>
          <div class="composer">
            <textarea
              bind:this={composerInput}
              bind:value={draft}
              aria-label="Message OMP"
              role="combobox"
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-expanded={commandMenuVisible}
              aria-controls={commandMenuVisible ? "slash-command-menu" : undefined}
              aria-activedescendant={commandMenuVisible && commandMatches.length > 0 ? `slash-command-option-${selectedCommandIndex}` : undefined}
              placeholder={isRunning ? "Steer the current turn…" : "Ask OMP to work in this folder…"}
              disabled={!canCompose}
              oninput={handleComposerInput}
              onkeydown={handleComposerKeydown}
            ></textarea>
            <div class="composer-actions">
              {#if isRunning}
                <button class="secondary-button" onclick={() => void queueNext()} disabled={!draft.trim()}>Queue next</button>
                <button class="danger-button" onclick={() => void abortTurn()}>Abort</button>
                <button class="primary-button" onclick={() => void sendPrimary()} disabled={!draft.trim()}>Steer <span>↗</span></button>
              {:else}
                <label class="select-control">{current.thinkingLevel ?? "inherit"}
                  <select
                    aria-label="Thinking level"
                    value={current.thinkingLevel ?? "inherit"}
                    disabled={settingsBusy.has("thinking")}
                    onchange={(event) => void changeSetting("thinking", (event.currentTarget as HTMLSelectElement).value as ThinkingLevel)}
                  >
                    <option value="inherit">session default</option>
                    <option value="off">off</option>
                    <option value="minimal">minimal</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                    <option value="max">max</option>
                  </select>
                </label>
                <button class="primary-button" onclick={() => void sendPrimary()} disabled={!draft.trim()}>Send <span>↗</span></button>
              {/if}
            </div>
          </div>
        </section>
      {/if}
    </main>

    <aside
      bind:this={inspectorPanel}
      class="inspector"
      aria-label={selectedDiffPath ? `Git diff for ${selectedDiffPath}` : "Session inspector"}
      tabindex="-1"
    >
      {#if current}
        {#if selectedDiffPath}
          <FileDiffInspector
            path={selectedDiffPath}
            diff={selectedDiff}
            loading={diffLoading}
            error={diffError}
            onClose={closeFileDiff}
            onOpenFile={openSelectedFile}
          />
        {:else}
          <section class="inspector-section">
            <div class="section-heading"><span class="eyebrow">Session</span><button class="icon-button" title="Toggle fast mode" aria-label="Toggle fast mode" class:active={current.fastMode} onclick={() => void changeSetting("fast", !current?.fastMode)}>速</button></div>
            <div class="stats-grid"><div><span>Model</span><strong>{current.model?.split("/").pop() ?? "Provider default"}</strong></div><div><span>Thinking</span><strong>{current.thinkingLevel ?? "auto"}</strong></div><div><span>Context</span><strong>{current.contextTokens ? `${Math.round((current.contextTokens / (current.contextWindow ?? current.contextTokens)) * 100)}%` : "—"}</strong></div><div><span>Throughput</span><strong>{current.tokensPerSecond ? `${Math.round(current.tokensPerSecond)} tok/s` : "—"}</strong></div></div>
          </section>
          <section class="inspector-section">
            <div class="section-heading"><span class="eyebrow">Changes</span><span class="count-badge">{outputFiles.length}</span></div>
            {#if outputFiles.length === 0}
              <p class="muted-copy">Successful file edits and writes will appear here with an on-demand Git diff.</p>
            {:else}
              <div class="output-list">
                {#each outputFiles as file (file.path)}
                  <button aria-label={`View git diff for ${file.path}`} onclick={() => void openFileDiff(file.path)}><span class="file-mark">↳</span><code>{file.path}</code><span>{file.operation === "edit" ? "Edited" : "Wrote"}</span></button>
                {/each}
              </div>
            {/if}
          </section>
          <section class="inspector-section collaborators">
            <div class="section-heading"><span class="eyebrow">Collaborators</span><span class="count-badge">{current.subagents.length}</span></div>
            {#if current.subagents.length === 0}<p class="muted-copy">No subagents in this session.</p>{:else}<div class="agent-list">{#each current.subagents as agent (agent.id)}<button class:selected={selectedSubagent === agent.id} class="agent-card" onclick={() => void inspectSubagent(agent)}><span class="agent-icon">{agent.status === "running" ? "◌" : "✓"}</span><span><strong>{agent.agent}</strong><small>{agent.progress?.currentTool ?? agent.progress?.lastIntent ?? agent.status}</small></span><span class="agent-status">{agent.progress?.tokens ? `${agent.progress.tokens} tok` : agent.status}</span></button>{/each}</div>{/if}
          </section>
          {#if selectedAgent}<section class="inspector-section agent-detail"><div class="section-heading"><span class="eyebrow">Subagent inspector</span><span class="mono">{selectedAgent.agent}</span></div><p>{selectedAgent.task ?? selectedAgent.assignment ?? "No assignment text"}</p>{#if selectedAgent.progress}<div class="agent-metrics"><span>{selectedAgent.progress.resolvedModel ?? "fallback"}</span><span>{selectedAgent.progress.cost !== undefined ? `$${selectedAgent.progress.cost.toFixed(3)}` : "—"}</span><span>{selectedAgent.progress.durationMs ? `${Math.round(selectedAgent.progress.durationMs / 1000)}s` : "—"}</span></div>{/if}<pre class="subagent-transcript">{subagentLoading ? "Loading transcript…" : subagentTranscript || "No transcript bytes yet."}</pre></section>{/if}
          <section class="inspector-section technical-summary"><details><summary>Technical details</summary><dl><dt>Session ID</dt><dd>{current.record.ompSessionId || "pending"}</dd><dt>Session file</dt><dd>{current.record.sessionFile || "pending"}</dd><dt>Kind</dt><dd>{current.record.kind}</dd></dl></details></section>
        {/if}
      {:else}
        <div class="inspector-empty"><span class="eyebrow">Inspector</span><p>Select a session to see state, changes, collaborators, and technical details.</p></div>
      {/if}
    </aside>
  </div>
  {/if}
  {#if view === "settings"}
    <main class="settings-page" aria-labelledby="settings-title">
      <div class="settings-header">
        <div>
          <span class="eyebrow">Agent control center</span>
          <h1 id="settings-title">Settings</h1>
          <p>Shape the active runtime, choose provider accounts, and manage local OMP defaults from one place.</p>
        </div>
        <div class="settings-header-actions">
          <button class="secondary-button" disabled={settingsRefreshing} onclick={() => void refreshSettingsData()}>{settingsRefreshing ? "Refreshing…" : "Refresh"}</button>
          <button class="secondary-button" onclick={() => view = "workspace"}>Back to workspace</button>
        </div>
      </div>
      {#if settingsStatusMessage}<p class="settings-global-status" role="status">{settingsStatusMessage}</p>{/if}

      <section class="settings-section" aria-labelledby="runtime-title">
        <div class="settings-section-heading">
          <div><span class="eyebrow">Active session</span><h2 id="runtime-title">Runtime</h2></div>
          {#if current}<span class="state-pill state-{current.state}"><span></span>{current.state}</span>{/if}
        </div>
        {#if !current}
          <div class="settings-empty"><strong>No active session</strong><p>Choose a workspace before configuring its model and reasoning behavior.</p></div>
        {:else if current.state === "stopped" || current.state === "error"}
          <div class="settings-empty"><strong>{current.record.title ?? current.record.cwd}</strong><p>Resume this session before changing runtime settings.</p><button class="secondary-button" disabled={loading} onclick={() => void resumeSettingsSession()}>{loading ? "Resuming…" : "Resume session"}</button></div>
        {:else}
          <p class="settings-context">{current.record.title ?? current.record.cwd}<span>{current.record.cwd}</span></p>
          <div class="model-picker">
            <div class="model-picker-head">
              <div>
                <span>Current model</span>
                <strong>{selectedModelOption?.name ?? current.model ?? "Provider default"}</strong>
                <small>{selectedModelOption ? `${selectedModelOption.provider} / ${selectedModelOption.id}` : current.model ?? "Inherited from OMP"}</small>
              </div>
              {#if selectedModelOption}<ModelCapabilityIcons input={selectedModelOption.input} reasoning={selectedModelOption.reasoning} />{/if}
            </div>
            <div class="model-picker-controls">
              <label>
                <span class="sr-only">Search models</span>
                <input type="search" aria-label="Search models" placeholder="Search by model, provider, or ID" bind:value={modelQuery} />
              </label>
              <label>
                <span class="sr-only">Filter models by provider</span>
                <select aria-label="Filter models by provider" bind:value={modelProviderFilter}>
                  <option value="all">All providers</option>
                  {#each modelProviders as provider (provider)}<option value={provider}>{provider}</option>{/each}
                </select>
              </label>
            </div>
            {#if modelsLoading}
              <div class="settings-empty compact"><p>Loading available models…</p></div>
            {:else if visibleModels.length === 0}
              <div class="settings-empty compact"><p>No models match these filters.</p></div>
            {:else}
              <div class="model-results" aria-label="Available models">
                {#each visibleModels as model (`${model.provider}:${model.id}`)}
                  {@const contextLabel = formatContextWindow(model.contextWindow)}
                  {@const selected = modelIdentifier(model) === current.model}
                  {#if model.provider === "openrouter"}
                    <OpenRouterModelAccordion
                      {model}
                      {contextLabel}
                      {selected}
                      open={expandedOpenRouterModel === model.id}
                      loading={openRouterRoutingLoading.has(model.id)}
                      routing={openRouterRouting.get(model.id)}
                      error={openRouterRoutingErrors.get(model.id) ?? ""}
                      busyProviders={openRouterProviderBusy.get(model.id) ?? EMPTY_PROVIDER_IDS}
                      modelChangeDisabled={settingsBusy.has("model")}
                      onToggle={() => toggleOpenRouterModel(model)}
                      onSelect={() => void changeModel(model)}
                      onProviderChange={(providerId, enabled) => void changeOpenRouterProvider(model, providerId, enabled)}
                    />
                  {:else}
                    <button
                      type="button"
                      class="model-option"
                      class:selected
                      aria-pressed={selected}
                      aria-label={`Use ${model.name} from ${model.provider}`}
                      disabled={settingsBusy.has("model")}
                      onclick={() => void changeModel(model)}
                    >
                      <span class="model-option-copy"><strong>{model.name}</strong><small>{model.provider} / {model.id}</small></span>
                      <span class="model-option-meta">
                        <ModelCapabilityIcons input={model.input} reasoning={model.reasoning} />
                        {#if contextLabel}<span class="model-context-badge">{contextLabel}</span>{/if}
                      </span>
                    </button>
                  {/if}
                {/each}
              </div>
              <p class="model-result-note">Showing {visibleModels.length} of {filteredModels.length} matching models{filteredModels.length > visibleModels.length ? " — refine your search to see more" : ""}.</p>
            {/if}
          </div>
          <div class="settings-form-grid runtime-options">
            <label class="settings-field">
              <span>Thinking level</span>
              <small>Reasoning depth for the active session.</small>
              <select aria-label="Settings thinking level" value={current.thinkingLevel ?? "inherit"} disabled={settingsBusy.has("thinking")} onchange={(event) => void changeSetting("thinking", (event.currentTarget as HTMLSelectElement).value as ThinkingLevel)}>
                <option value="inherit">Session default</option><option value="off">Off</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option><option value="max">Maximum supported</option>
              </select>
            </label>
            <label class="settings-toggle">
              <span><strong>Fast mode</strong><small>Use accelerated serving when the selected model supports it.</small></span>
              <input type="checkbox" aria-label="Fast mode" checked={current.fastMode === true} disabled={settingsBusy.has("fast")} onchange={(event) => void changeSetting("fast", (event.currentTarget as HTMLInputElement).checked)} />
            </label>
          </div>
        {/if}
      </section>

      <section class="settings-section" aria-labelledby="turn-title">
        <div class="settings-section-heading"><div><span class="eyebrow">Per session</span><h2 id="turn-title">Turn behavior</h2></div></div>
        <p class="settings-copy">Queue, interruption, compaction, and retry controls for the active runtime.</p>
        {#if current && current.state !== "stopped" && current.state !== "error"}
          <div class="settings-form-grid">
            <label class="settings-field"><span>Steering delivery</span><small>How messages steer an active turn.</small><select aria-label="Steering delivery" value={current.steeringMode ?? "all"} disabled={settingsBusy.has("steering")} onchange={(event) => void changeQueueSetting("steering", (event.currentTarget as HTMLSelectElement).value as QueueMode)}><option value="all">Deliver all</option><option value="one-at-a-time">One at a time</option></select></label>
            <label class="settings-field"><span>Follow-up delivery</span><small>How queued messages enter subsequent turns.</small><select aria-label="Follow-up delivery" value={current.followUpMode ?? "all"} disabled={settingsBusy.has("follow-up")} onchange={(event) => void changeQueueSetting("follow-up", (event.currentTarget as HTMLSelectElement).value as QueueMode)}><option value="all">Deliver all</option><option value="one-at-a-time">One at a time</option></select></label>
            <label class="settings-field"><span>Interrupt behavior</span><small>Whether new input interrupts immediately or waits.</small><select aria-label="Interrupt behavior" value={current.interruptMode ?? "immediate"} disabled={settingsBusy.has("interrupt")} onchange={(event) => void changeInterruptSetting((event.currentTarget as HTMLSelectElement).value as InterruptMode)}><option value="immediate">Interrupt immediately</option><option value="wait">Wait for a safe boundary</option></select></label>
            <label class="settings-toggle"><span><strong>Automatic compaction</strong><small>Compact context before it reaches the model limit.</small></span><input type="checkbox" aria-label="Automatic compaction" checked={current.autoCompactionEnabled !== false} disabled={settingsBusy.has("compaction")} onchange={(event) => void changeAutoCompaction((event.currentTarget as HTMLInputElement).checked)} /></label>
            <label class="settings-toggle"><span><strong>Automatic retry</strong><small>Retry recoverable provider failures without a manual resend.</small></span><input type="checkbox" aria-label="Automatic retry" checked={current.autoRetryEnabled !== false} disabled={settingsBusy.has("retry")} onchange={(event) => void changeAutoRetry((event.currentTarget as HTMLInputElement).checked)} /></label>
          </div>
        {:else}
          <div class="settings-empty compact"><p>Turn behavior becomes available when the active session is running.</p></div>
        {/if}
      </section>

      <section class="settings-section agent-settings-section" aria-labelledby="agent-settings-title">
        <div class="settings-section-heading">
          <div><span class="eyebrow">Local OMP preferences</span><h2 id="agent-settings-title">Agent defaults</h2></div>
          <span class="count-badge">{agentSettings.length}</span>
        </div>
        <p class="settings-copy">Credential-free defaults shared with OMP. Changes marked “Next session” require a new or reconnected runtime.</p>
        {#if agentSettings.length === 0}
          <div class="settings-empty compact"><p>{settingsRefreshing ? "Loading agent settings…" : "No configurable agent defaults were reported."}</p></div>
        {:else}
          <div class="settings-tablist" role="tablist" aria-label="Agent setting categories">
            {#each availableAgentSettingTabs as tab (tab.id)}
              <button type="button" role="tab" aria-selected={selectedAgentSettingsTab === tab.id} class:active={selectedAgentSettingsTab === tab.id} onclick={() => selectedAgentSettingsTab = tab.id}>{tab.label}</button>
            {/each}
          </div>
          <div class="agent-settings-panel" role="tabpanel" aria-label={AGENT_SETTING_TABS.find(tab => tab.id === selectedAgentSettingsTab)?.label}>
            {#each agentSettingGroups as group (group.name)}
              <section class="agent-settings-group" aria-labelledby={`agent-setting-${selectedAgentSettingsTab}-${group.name.replaceAll(" ", "-").toLowerCase()}`}>
                <h3 id={`agent-setting-${selectedAgentSettingsTab}-${group.name.replaceAll(" ", "-").toLowerCase()}`}>{group.name}</h3>
                <div class="settings-form-grid">
                  {#each group.settings as setting (setting.path)}
                    {#if setting.control === "toggle"}
                      <label class="settings-toggle">
                        <span><strong>{setting.label}</strong><small>{setting.description}</small>{#if setting.apply === "next-session"}<span class="setting-scope">Next session</span>{/if}</span>
                        <input type="checkbox" aria-label={setting.label} checked={setting.value === true} disabled={agentSettingsBusy.has(setting.path)} onchange={(event) => void changeAgentSetting(setting, (event.currentTarget as HTMLInputElement).checked)} />
                      </label>
                    {:else}
                      <label class="settings-field">
                        <span>{setting.label}{#if setting.apply === "next-session"}<span class="setting-scope">Next session</span>{/if}</span>
                        <small>{setting.description}</small>
                        <select aria-label={setting.label} value={String(setting.value)} disabled={agentSettingsBusy.has(setting.path)} onchange={(event) => changeAgentSettingFromSelect(setting, event)}>
                          {#each setting.options ?? [] as option (`${setting.path}:${String(option.value)}`)}
                            <option value={String(option.value)} title={option.description}>{option.label}</option>
                          {/each}
                        </select>
                      </label>
                    {/if}
                  {/each}
                </div>
              </section>
            {/each}
          </div>
        {/if}
      </section>

      <section class="settings-section" aria-labelledby="provider-title">
        <div class="settings-section-heading">
          <div><span class="eyebrow">Provider access</span><h2 id="provider-title">Provider accounts</h2></div>
          <span class:connected={signedInAccountCount > 0} class="provider-state">{signedInAccountCount === 1 ? "1 connected" : `${signedInAccountCount} connected`}</span>
        </div>
        <p class="settings-copy">Every OAuth provider advertised by the local OMP runtime. Authentication opens the provider’s official browser flow.</p>
        <label class="provider-search"><span class="sr-only">Search providers</span><input type="search" aria-label="Search providers" placeholder="Search providers" bind:value={authQuery} /></label>
        {#if filteredAuthAccounts.length === 0}
          <div class="settings-empty compact"><p>{authAccounts.length === 0 ? "No OAuth providers were reported by OMP." : "No providers match this search."}</p></div>
        {:else}
          <div class="provider-list">
            {#each filteredAuthAccounts as account (account.provider)}
              <article class="provider-row">
                <div class="provider-copy">
                  <span class="provider-name"><strong>{account.name}</strong><span class="mono">{account.provider}</span></span>
                  <small>{account.signedIn ? account.email ?? account.orgName ?? "Authenticated locally" : account.available ? "Ready to connect" : "Not available in this runtime"}</small>
                </div>
                <div class="provider-actions">
                  <span class:connected={account.signedIn} class:unavailable={!account.available} class="provider-state">{account.signedIn ? "Connected" : account.available ? "Available" : "Unavailable"}</span>
                  {#if account.signedIn}
                    <button type="button" class="secondary-button" aria-label={`Sign out of ${account.name}`} disabled={Boolean(authBusyProvider)} onclick={() => void logoutProvider(account)}>{authBusyProvider === account.provider ? "Signing out…" : "Sign out"}</button>
                  {:else if account.available}
                    <button type="button" class="primary-button" aria-label={`Sign in to ${account.name}`} disabled={Boolean(authBusyProvider)} onclick={() => void loginProvider(account)}>{authBusyProvider === account.provider ? "Waiting for sign-in…" : "Sign in"} <span>→</span></button>
                  {/if}
                </div>
              </article>
            {/each}
          </div>
        {/if}
        {#if authStatusMessage}<p class="settings-status" role="status">{authStatusMessage}</p>{/if}
      </section>
      <section class="settings-section security-note" aria-labelledby="security-title"><span class="eyebrow">Credential boundary</span><h2 id="security-title">Local and redacted</h2><p>Access and refresh tokens are used only by the local runtime. Branchlight exposes provider status and account identity, not credential material.</p></section>
    </main>
  {/if}

  {#if aboutOpen}<div class="modal-backdrop"><dialog open class="extension-dialog about-dialog" aria-labelledby="about-title" onkeydown={(event) => event.key === "Escape" && closeAbout()}><span class="eyebrow">Branchlight Labs</span><h2 id="about-title">Branchlight</h2><p>Local Work and Code sessions powered by the Oh My Pi RPC runtime.</p><dl class="about-list"><dt>Version</dt><dd>0.1.0</dd><dt>Backend</dt><dd>Oh My Pi · MIT License</dd><dt>Icons</dt><dd>Solar Icons by 480 Design · CC BY 4.0</dd><dt>Fonts</dt><dd>Sora and Nunito Sans · SIL Open Font License 1.1</dd></dl><p class="muted-copy">Full third-party notices are included in THIRD_PARTY_LICENSES.txt beside the packaged application.</p><div class="dialog-actions"><button class="primary-button" onclick={closeAbout}>Close</button></div></dialog></div>{/if}
  {#if authPrompt}<div class="modal-backdrop"><dialog open class="extension-dialog auth-prompt" aria-labelledby="auth-prompt-title"><span class="eyebrow">Private sign-in step</span><h2 id="auth-prompt-title">Authentication input</h2><p>{authPrompt.message}</p><input class="extension-editor" type="password" aria-label="Authentication input" autocomplete="one-time-code" placeholder={authPrompt.placeholder} bind:value={authPromptValue} onkeydown={(event) => event.key === "Enter" && void submitAuthPrompt()} /><div class="dialog-actions"><button class="secondary-button" onclick={() => void cancelAuthPrompt()}>Cancel</button><button class="primary-button" onclick={() => void submitAuthPrompt()}>Submit</button></div></dialog></div>{/if}
  {#if errorMessage}<div class="toast error-toast" role="alert"><strong>Action failed</strong><span>{errorMessage}</span><button aria-label="Dismiss error" onclick={() => errorMessage = ""}>&times;</button></div>{/if}
  {#if pendingExtension && pendingExtension.method !== "notify" && pendingExtension.method !== "set_editor_text" && pendingExtension.method !== "open_url"}<div class="modal-backdrop"><dialog open class="extension-dialog" aria-labelledby="extension-title"><span class="eyebrow">OMP extension</span><h2 id="extension-title">{pendingExtension.title ?? "Input required"}</h2>{#if pendingExtension.message}<p>{pendingExtension.message}</p>{/if}{#if pendingExtension.method === "select"}<div class="extension-options">{#each pendingExtension.options ?? [] as option}<button class="secondary-button" onclick={() => void respondExtension({ value: option })}>{option}</button>{/each}</div>{:else if pendingExtension.method === "confirm"}<div class="dialog-actions"><button class="secondary-button" onclick={() => void respondExtension({ confirmed: false })}>Cancel</button><button class="primary-button" onclick={() => void respondExtension({ confirmed: true })}>Confirm</button></div>{:else}{#if pendingExtension.method === "input" && pendingExtension.sensitive}<input class="extension-editor" type="password" aria-label="Sensitive input" autocomplete="current-password" placeholder={pendingExtension.placeholder} value={pendingExtension.prefill ?? ""} oninput={(event) => pendingExtension = pendingExtension ? { ...pendingExtension, prefill: (event.currentTarget as HTMLInputElement).value } : undefined} />{:else}<textarea class="extension-editor" aria-label={pendingExtension.method === "editor" ? "Editor input" : "Input"} placeholder={pendingExtension.placeholder} value={pendingExtension.prefill ?? ""} oninput={(event) => pendingExtension = pendingExtension ? { ...pendingExtension, prefill: (event.currentTarget as HTMLTextAreaElement).value } : undefined}></textarea>{/if}<div class="dialog-actions"><button class="secondary-button" onclick={() => void respondExtension({ cancelled: true })}>Cancel</button><button class="primary-button" onclick={() => void respondExtension({ value: pendingExtension?.prefill ?? "" })}>Submit</button></div>{/if}</dialog></div>{/if}
</div>
