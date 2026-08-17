<script lang="ts">
  import type { ModelOption, OpenRouterModelRouting } from "../../shared/contracts";
  import ModelCapabilityIcons from "./ModelCapabilityIcons.svelte";

  export let model: ModelOption;
  export let contextLabel: string | undefined;
  export let selected: boolean;
  export let open: boolean;
  export let loading: boolean;
  export let routing: OpenRouterModelRouting | undefined;
  export let error: string;
  export let busyProviders: Set<string>;
  export let modelChangeDisabled: boolean;
  export let onToggle: () => void;
  export let onSelect: () => void;
  export let onProviderChange: (providerId: string, enabled: boolean) => void;

  $: enabledProviderCount = routing?.providers.filter(provider => provider.enabled).length ?? 0;
  $: regionId = `openrouter-${model.id.replace(/[^a-z0-9_-]+/gi, "-")}`;
</script>

<article class="model-accordion" class:selected>
  <button
    type="button"
    class="model-accordion-toggle"
    aria-expanded={open}
    aria-controls={regionId}
    onclick={onToggle}
  >
    <span class="model-option-copy"><strong>{model.name}</strong><small>openrouter / {model.id}</small></span>
    <span class="model-option-meta">
      <ModelCapabilityIcons input={model.input} reasoning={model.reasoning} />
      {#if contextLabel}<span class="model-context-badge">{contextLabel}</span>{/if}
      <span class="accordion-chevron" aria-hidden="true">⌄</span>
    </span>
  </button>

  {#if open}
    <div class="model-accordion-panel" id={regionId} role="region" aria-label={`${model.name} routing details`}>
      <div class="model-routing-intro">
        <div><strong>OpenRouter upstreams</strong><p>Clear a provider to exclude it for this model. At least one route stays enabled.</p></div>
        <button type="button" class="secondary-button compact" disabled={modelChangeDisabled || selected} onclick={onSelect}>
          {selected ? "Current model" : "Use model"}
        </button>
      </div>

      {#if error}
        <div class="model-routing-state error" role="alert"><strong>{routing ? "Route not updated" : "Routes unavailable"}</strong><span>{error}</span></div>
      {/if}
      {#if loading}
        <div class="model-routing-state" role="status"><span class="spinner"></span><span>Loading provider routes…</span></div>
      {:else if routing}
        <div class="provider-route-list" aria-label={`Providers for ${model.name}`}>
          {#each routing.providers as provider (provider.id)}
            {@const lastEnabled = provider.enabled && enabledProviderCount === 1}
            <label class="provider-route" class:excluded={!provider.enabled}>
              <input
                type="checkbox"
                checked={provider.enabled}
                disabled={busyProviders.has(provider.id) || lastEnabled}
                aria-label={`Allow ${provider.name} for ${model.name}`}
                onchange={(event) => onProviderChange(provider.id, (event.currentTarget as HTMLInputElement).checked)}
              />
              <span class="provider-route-copy"><strong>{provider.name}</strong><small>{provider.id}</small></span>
              <span class="provider-route-state">{busyProviders.has(provider.id) ? "Saving…" : provider.enabled ? "Allowed" : "Excluded"}</span>
            </label>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</article>
