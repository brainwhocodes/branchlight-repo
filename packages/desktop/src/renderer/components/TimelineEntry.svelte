<script lang="ts">
  import type { SessionKind, TimelineImage, TimelineItem } from "../../shared/contracts";
  import { renderMarkdown } from "../markdown";

  export let item: TimelineItem;
  export let kind: SessionKind;
  export let reasoningLoading: Set<string>;
  export let openReasoning: Set<string>;
  export let onReasoning: (item: TimelineItem) => void;
  export let onFile: (path: string) => void;

  function toolLabel(value: TimelineItem): string {
    return value.toolName === "generate_image" ? "Generate image" : value.toolName ?? value.text;
  }

  function toolStatus(value: TimelineItem): string {
    if (value.toolName === "generate_image" && value.status === "running") return "generating image";
    return value.status ?? "pending";
  }

  function imageSource(image: TimelineImage): string {
    return `data:${image.mimeType};base64,${image.data}`;
  }

  function itemText(value: TimelineItem): string {
    return value.text || value.detail || "";
  }
</script>

<article class="timeline-item item-{item.kind}" class:has-error={item.isError}>
  <div class="timeline-gutter"><span>{item.kind === "user" ? "YOU" : item.kind === "assistant" ? "OMP" : item.kind === "tool" ? "TOOL" : item.kind === "thinking" ? "THINK" : "LOG"}</span></div>
  <div class="timeline-body">
    {#if item.kind === "tool"}
      <div class="activity-row">
        <span class="activity-icon">{item.status === "running" ? "◌" : item.status === "error" ? "!" : "✓"}</span>
        <strong>{toolLabel(item)}</strong>
        <span class="activity-status">{toolStatus(item)}</span>
      </div>
      {#if item.files && item.files.length > 0}
        <div class="file-change-list" aria-label="Changed files">
          {#each item.files as file (file.path)}
            <button
              type="button"
              class="file-change"
              aria-label={`View git diff for ${file.path}`}
              disabled={item.status !== "complete" || item.isError === true}
              onclick={() => onFile(file.path)}
            >
              <span class="file-operation">{file.operation === "edit" ? "Edited" : "Wrote"}</span>
              <code title={file.path}>{file.path}</code>
              <span class="file-diff-action">View diff</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if item.images && item.images.length > 0}
        <div class="tool-images" aria-label="Generated images">
          {#each item.images as image, index (image.mimeType + ":" + index)}
            <figure class="tool-image">
              <img src={imageSource(image)} alt={`Generated image ${index + 1}`} loading="lazy" />
              <figcaption>{image.mimeType.replace("image/", "").toUpperCase()}</figcaption>
            </figure>
          {/each}
        </div>
      {/if}
      {#if kind === "code"}
        <details class="technical-details"><summary>Technical details</summary>{#if item.args}<pre>{JSON.stringify(item.args, null, 2)}</pre>{/if}{#if item.detail}<pre>{item.detail}</pre>{/if}</details>
      {/if}
    {:else if item.kind === "thinking"}
      <details class="reasoning-details" open={openReasoning.has(item.id)}>
        <summary aria-busy={reasoningLoading.has(item.id)} onclick={() => onReasoning(item)}>Reasoning {item.status === "error" ? "· error" : "· available"}</summary>
        {#if item.text.length > 64 * 1024}<pre class="reasoning-copy">{item.text.slice(0, 16 * 1024)}{"\n\n[Preview truncated for responsiveness]"}</pre>{:else}<div class="reasoning-copy">{@html renderMarkdown(item.text)}</div>{/if}
      </details>
    {:else if item.kind === "marker" || item.kind === "notice" || item.kind === "todo"}
      <div class="marker-row"><span class="marker-label">{item.kind}</span><span>{itemText(item)}</span></div>
      {#if item.detail && kind === "code"}<details class="technical-details"><summary>Details</summary><pre>{item.detail}</pre></details>{/if}
    {:else}
      <div class="message-copy">{@html renderMarkdown(item.text)}</div>
      {#if kind === "code" && item.detail}<details class="technical-details"><summary>Technical details</summary><pre>{item.detail}</pre></details>{/if}
    {/if}
  </div>
</article>
