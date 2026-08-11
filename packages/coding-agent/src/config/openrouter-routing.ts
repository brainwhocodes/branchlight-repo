import type { Settings } from "./settings";

const ROUTING_VARIANT_SUFFIX = /:(?:nitro|floor|online|exacto)$/i;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export function normalizeOpenRouterModelId(value: string): string {
	const modelId = value.trim().replace(ROUTING_VARIANT_SUFFIX, "");
	const segments = modelId.split("/");
	if (
		modelId.length === 0 ||
		modelId.length > 512 ||
		segments.length < 2 ||
		segments.some(segment => segment.length === 0)
	) {
		throw new TypeError("invalid OpenRouter model id");
	}
	return modelId;
}

export function isOpenRouterProviderId(value: string): boolean {
	return PROVIDER_ID_PATTERN.test(value);
}

export function getOpenRouterIgnoredProviders(settings: Settings, modelIdInput: string): string[] {
	const modelId = normalizeOpenRouterModelId(modelIdInput);
	const configured = settings.get("providers.openrouterIgnoredProviders")[modelId] ?? [];
	return [...new Set(configured.filter(isOpenRouterProviderId))];
}
