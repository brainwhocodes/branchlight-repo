<script lang="ts">
  import type { SlashCommand } from "../../shared/contracts";

  export let commands: SlashCommand[] = [];
  export let error = "";
  export let loading = false;
  export let selectedIndex = 0;
  export let onSelect: (command: SlashCommand) => void;
  export let onHighlight: (index: number) => void;

  function sourceLabel(source: SlashCommand["source"]): string {
    if (source === "mcp_prompt") return "MCP";
    return source.charAt(0).toUpperCase() + source.slice(1);
  }

  function keepSelectedVisible(node: HTMLElement, selected: boolean): { update(next: boolean): void } {
    if (selected) queueMicrotask(() => node.scrollIntoView({ block: "nearest" }));
    return {
      update(next: boolean): void {
        if (next) queueMicrotask(() => node.scrollIntoView({ block: "nearest" }));
      },
    };
  }
</script>

<section id="slash-command-menu" class="command-menu" aria-label="Slash command suggestions">
  <header class="command-menu-header">
    <div><span class="eyebrow">Session commands</span><strong>{commands.length} match{commands.length === 1 ? "" : "es"}</strong></div>
    <span class="command-menu-hints"><kbd>↑</kbd><kbd>↓</kbd> browse · <kbd>Enter</kbd> choose · <kbd>Esc</kbd> close</span>
  </header>
  {#if loading}
    <div class="command-menu-state" role="status"><span class="spinner" aria-hidden="true"></span>Loading commands without blocking the editor…</div>
  {:else if error}
    <div class="command-menu-state error" role="status">{error}</div>
  {:else if commands.length === 0}
    <div class="command-menu-state">No command matches. Keep typing or press Escape to close.</div>
  {:else}
    <div id="slash-command-list" class="command-list" role="listbox" aria-label="Slash commands">
      {#each commands as command, index (`${command.source}:${command.name}`)}
        <button
          id={`slash-command-option-${index}`}
          type="button"
          role="option"
          aria-selected={index === selectedIndex}
          tabindex="-1"
          class:selected={index === selectedIndex}
          use:keepSelectedVisible={index === selectedIndex}
          onmouseenter={() => onHighlight(index)}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => onSelect(command)}
        >
          <span class="command-name">/{command.name}</span>
          <span class="command-description">{command.description ?? "Run this command in the active session"}</span>
          <span class="command-meta">
            <span class="command-source">{sourceLabel(command.source)}</span>
            {#if command.subcommands?.length}
              <span class="command-usage">{command.subcommands.slice(0, 4).map(subcommand => subcommand.name).join(" · ")}</span>
            {:else if command.input?.hint}
              <span class="command-usage">{command.input.hint}</span>
            {/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
</section>
