import { isRecord } from "@oh-my-pi/pi-utils";
import {
	getOpenRouterIgnoredProviders,
	isOpenRouterProviderId,
	normalizeOpenRouterModelId,
} from "../../config/openrouter-routing";
import type { Settings } from "../../config/settings";

const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
const PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000;

export interface RpcOpenRouterProvider {
	id: string;
	name: string;
	enabled: boolean;
}

export interface RpcOpenRouterModelRouting {
	modelId: string;
	providers: RpcOpenRouterProvider[];
}

interface OpenRouterProviderMetadata {
	id: string;
	name: string;
}

interface CachedProviders {
	expiresAt: number;
	providers: Promise<OpenRouterProviderMetadata[]>;
}

const providerCache = new Map<string, CachedProviders>();

export async function getRpcOpenRouterModelRouting(
	settings: Settings,
	modelIdInput: string,
): Promise<RpcOpenRouterModelRouting> {
	const modelId = normalizeOpenRouterModelId(modelIdInput);
	const providers = await loadOpenRouterProviders(modelId);
	return toRoutingView(settings, modelId, providers);
}

export async function setRpcOpenRouterProviderEnabled(
	settings: Settings,
	modelIdInput: string,
	providerIdInput: string,
	enabled: boolean,
): Promise<RpcOpenRouterModelRouting> {
	const modelId = normalizeOpenRouterModelId(modelIdInput);
	const providerId = providerIdInput.trim();
	if (!isOpenRouterProviderId(providerId)) throw new TypeError("invalid OpenRouter provider id");
	const providers = await loadOpenRouterProviders(modelId);
	if (!providers.some(provider => provider.id === providerId)) {
		throw new RangeError(`Provider ${providerId} is not available for ${modelId}`);
	}

	const ignored = new Set(getOpenRouterIgnoredProviders(settings, modelId));
	if (enabled) {
		ignored.delete(providerId);
	} else if (!ignored.has(providerId)) {
		const enabledCount = providers.reduce((count, provider) => count + Number(!ignored.has(provider.id)), 0);
		if (enabledCount <= 1) throw new RangeError("At least one OpenRouter provider must remain enabled");
		ignored.add(providerId);
	}

	const configured = settings.get("providers.openrouterIgnoredProviders");
	const next = { ...configured };
	if (ignored.size > 0) next[modelId] = [...ignored].sort();
	else delete next[modelId];
	settings.set("providers.openrouterIgnoredProviders", next);
	return toRoutingView(settings, modelId, providers);
}

function toRoutingView(
	settings: Settings,
	modelId: string,
	providers: OpenRouterProviderMetadata[],
): RpcOpenRouterModelRouting {
	const ignored = new Set(getOpenRouterIgnoredProviders(settings, modelId));
	return {
		modelId,
		providers: providers.map(provider => ({ ...provider, enabled: !ignored.has(provider.id) })),
	};
}

async function loadOpenRouterProviders(modelId: string): Promise<OpenRouterProviderMetadata[]> {
	const now = Date.now();
	const cached = providerCache.get(modelId);
	if (cached && cached.expiresAt > now) return await cached.providers;

	const providers = fetchOpenRouterProviders(modelId).catch(error => {
		if (providerCache.get(modelId)?.providers === providers) providerCache.delete(modelId);
		throw error;
	});
	providerCache.set(modelId, { expiresAt: now + PROVIDER_CACHE_TTL_MS, providers });
	return await providers;
}

async function fetchOpenRouterProviders(modelId: string): Promise<OpenRouterProviderMetadata[]> {
	const path = modelId.split("/").map(encodeURIComponent).join("/");
	const response = await fetch(`${OPENROUTER_API_BASE_URL}/models/${path}/endpoints`, {
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`OpenRouter provider lookup failed (${response.status})`);
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.endpoints)) {
		throw new Error("OpenRouter provider lookup returned an invalid response");
	}

	const providers = new Map<string, OpenRouterProviderMetadata>();
	for (const value of payload.data.endpoints) {
		if (!isRecord(value) || typeof value.tag !== "string" || !isOpenRouterProviderId(value.tag)) continue;
		const name =
			typeof value.provider_name === "string" && value.provider_name.trim() ? value.provider_name.trim() : value.tag;
		if (!providers.has(value.tag)) providers.set(value.tag, { id: value.tag, name });
	}
	if (providers.size === 0) throw new Error(`OpenRouter reported no providers for ${modelId}`);
	return [...providers.values()].sort(
		(left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
	);
}
