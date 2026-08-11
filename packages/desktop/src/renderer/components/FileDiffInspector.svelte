<script lang="ts">
  import type { FileDiffView } from "../../shared/contracts";

  export let path: string;
  export let diff: FileDiffView | undefined;
  export let loading: boolean;
  export let error: string;
  export let onClose: () => void;
  export let onOpenFile: () => void;

  $: lines = diff?.diff ? diff.diff.split("\n") : [];

  function lineKind(line: string): "added" | "removed" | "hunk" | "meta" | "context" {
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+") && !line.startsWith("+++")) return "added";
    if (line.startsWith("-") && !line.startsWith("---")) return "removed";
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) return "meta";
    return "context";
  }
</script>

<section class="diff-inspector" aria-label={`Git diff for ${path}`} aria-busy={loading}>
  <header class="diff-header">
    <div class="diff-title">
      <span class="eyebrow">Git diff</span>
      <h2 title={path}>{path}</h2>
    </div>
    <div class="diff-actions">
      <button
        type="button"
        class="icon-button"
        aria-label={`Open ${path}`}
        title="Open file"
        disabled={!diff || diff.status === "deleted" || diff.status === "unavailable"}
        onclick={onOpenFile}
      >↗</button>
      <button type="button" class="icon-button" aria-label="Close git diff" title="Close diff" onclick={onClose}>×</button>
    </div>
  </header>

  {#if diff}
    <div class="diff-summary" aria-label="Diff summary">
      <span class="diff-status status-{diff.status}">{diff.status}</span>
      <span class="diff-additions">+{diff.additions}</span>
      <span class="diff-deletions">−{diff.deletions}</span>
    </div>
  {/if}

  {#if loading}
    <div class="diff-state" role="status"><span class="spinner"></span><span>Loading current working-tree diff…</span></div>
  {:else if error}
    <div class="diff-state diff-error" role="alert"><strong>Diff unavailable</strong><span>{error}</span></div>
  {:else if diff?.diff}
    <div class="diff-code" role="document" aria-label={`Patch for ${path}`}>
      {#each lines as line}
        <div class="diff-line line-{lineKind(line)}"><code>{line || " "}</code></div>
      {/each}
    </div>
    {#if diff.truncated}<p class="diff-note">Preview capped at 2,000 lines or 256 KiB. Counts cover the complete patch.</p>{/if}
  {:else if diff}
    <div class="diff-state"><strong>{diff.status === "clean" ? "No Git changes" : diff.status === "binary" ? "Binary change" : "No text preview"}</strong><span>{diff.message ?? "No patch content is available for this file."}</span></div>
  {/if}
</section>
