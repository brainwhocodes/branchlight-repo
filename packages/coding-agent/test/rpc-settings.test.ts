import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getRpcSettings, setRpcSetting } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-settings";

describe("RPC settings", () => {
	test("lists curated scalar settings with finite controls", () => {
		const settings = getRpcSettings(Settings.isolated());

		expect(settings.length).toBeGreaterThanOrEqual(30);
		expect(settings.find(setting => setting.path === "generate_image.enabled")).toMatchObject({
			label: "Generate Image",
			control: "toggle",
			value: false,
			apply: "next-session",
		});
		expect(settings.find(setting => setting.path === "personality")?.options?.map(option => option.value)).toEqual([
			"default",
			"friendly",
			"pragmatic",
			"none",
		]);
		expect(settings.every(setting => setting.control === "toggle" || (setting.options?.length ?? 0) > 0)).toBe(true);
	});

	test("validates mutations and applies live prompt and vision side effects", async () => {
		const settings = Settings.isolated();
		let promptRefreshes = 0;
		let visionRefreshes = 0;
		const session = {
			settings,
			refreshBaseSystemPrompt: async () => {
				promptRefreshes++;
			},
			applyInspectImageModeChange: async () => {
				visionRefreshes++;
				return true;
			},
		};

		const personality = await setRpcSetting(session, "personality", "pragmatic");
		expect(personality.value).toBe("pragmatic");
		expect(settings.get("personality")).toBe("pragmatic");
		expect(promptRefreshes).toBe(1);

		await setRpcSetting(session, "inspect_image.mode", "on");
		expect(settings.get("inspect_image.mode")).toBe("on");
		expect(visionRefreshes).toBe(1);

		await expect(setRpcSetting(session, "personality", "reckless")).rejects.toThrow("not a supported value");
		await expect(setRpcSetting(session, "auth.apiKey", "secret")).rejects.toThrow("not available over RPC");
	});
});
