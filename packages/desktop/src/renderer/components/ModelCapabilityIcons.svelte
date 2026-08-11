<script lang="ts">
  import DocumentText from "@solar-icons/svelte/linear/document-text";
  import Gallery from "@solar-icons/svelte/linear/gallery";
  import Lightbulb from "@solar-icons/svelte/linear/lightbulb";
  import type { ModelInputModality } from "../../shared/contracts";

  export let input: ModelInputModality[];
  export let reasoning: boolean;

  $: labels = [
    ...(input.includes("text") ? ["text input"] : []),
    ...(input.includes("image") ? ["image input"] : []),
    ...(reasoning ? ["reasoning"] : []),
  ];
</script>

<span class="model-capabilities" aria-label={`Capabilities: ${labels.join(", ") || "not reported"}`}>
  {#if input.includes("text")}
    <span class="model-capability" title="Text input"><DocumentText size={15} aria-hidden="true" /><span class="sr-only">Text input</span></span>
  {/if}
  {#if input.includes("image")}
    <span class="model-capability" title="Image input"><Gallery size={15} aria-hidden="true" /><span class="sr-only">Image input</span></span>
  {/if}
  {#if reasoning}
    <span class="model-capability reasoning" title="Reasoning"><Lightbulb size={15} aria-hidden="true" /><span class="sr-only">Reasoning</span></span>
  {/if}
</span>
