import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	getRpcOpenRouterModelRouting,
	setRpcOpenRouterProviderEnabled,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-openrouter-routing";

function mockProviderResponse(onFetch: () => void): void {
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async () => {
			onFetch();
			return new Response(
				JSON.stringify({
					data: {
						endpoints: [
							{ provider_name: "OpenAI", tag: "openai" },
							{ provider_name: "Azure", tag: "azure" },
							{ provider_name: "Azure duplicate", tag: "azure" },
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
}

describe("OpenRouter model routing RPC", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("loads model providers once and persists exclusions without allowing every route to be disabled", async () => {
		let fetchCalls = 0;
		mockProviderResponse(() => fetchCalls++);
		const settings = Settings.isolated({});

		const initial = await getRpcOpenRouterModelRouting(settings, "acme/routing-test:nitro");
		expect(initial).toEqual({
			modelId: "acme/routing-test",
			providers: [
				{ id: "azure", name: "Azure", enabled: true },
				{ id: "openai", name: "OpenAI", enabled: true },
			],
		});

		const updated = await setRpcOpenRouterProviderEnabled(settings, "acme/routing-test", "azure", false);
		expect(updated.providers).toEqual([
			{ id: "azure", name: "Azure", enabled: false },
			{ id: "openai", name: "OpenAI", enabled: true },
		]);
		expect(settings.get("providers.openrouterIgnoredProviders")).toEqual({
			"acme/routing-test": ["azure"],
		});
		await expect(setRpcOpenRouterProviderEnabled(settings, "acme/routing-test", "openai", false)).rejects.toThrow(
			"At least one OpenRouter provider must remain enabled",
		);
		expect(fetchCalls).toBe(1);
	});
});
