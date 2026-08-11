import type { Settings } from "../../config/settings";
import {
	getEnumValues,
	getType,
	getUi,
	isCredential,
	type SettingPath,
	type SettingTab,
} from "../../config/settings-schema";
import type { AgentSession } from "../../session/agent-session";
import type { RpcSettingOption, RpcSettingTab, RpcSettingValue, RpcSettingView } from "./rpc-types";

type RpcSettingsSession = Pick<AgentSession, "settings" | "refreshBaseSystemPrompt" | "applyInspectImageModeChange">;

const RPC_SETTING_PATHS = [
	"images.autoResize",
	"images.blockImages",
	"images.describeForTextModels",
	"includeModelInPrompt",
	"personality",
	"temperature",
	"retry.maxRetries",
	"retry.modelFallback",
	"retry.usageAwareFallback",
	"compaction.midTurnEnabled",
	"compaction.strategy",
	"compaction.remoteEnabled",
	"compaction.supersedeReads",
	"compaction.dropUseless",
	"tools.approvalMode",
	"todo.enabled",
	"launch.enabled",
	"generate_image.enabled",
	"inspect_image.mode",
	"tools.intentTracing",
	"tools.abortOnFabricatedResult",
	"tools.maxTimeout",
	"async.enabled",
	"tools.xdev",
	"tools.xdevDocs",
	"plan.enabled",
	"goal.enabled",
	"task.eager",
	"task.batch",
	"task.enableEffort",
	"task.maxConcurrency",
	"task.enableLsp",
] as const satisfies readonly SettingPath[];

type RpcSettingPath = (typeof RPC_SETTING_PATHS)[number];

const RPC_SETTING_PATH_SET = new Set<string>(RPC_SETTING_PATHS);
const NEXT_SESSION_PATHS = new Set<RpcSettingPath>([
	"launch.enabled",
	"generate_image.enabled",
	"tools.xdev",
	"plan.enabled",
	"goal.enabled",
]);

export function getRpcSettings(settings: Settings): RpcSettingView[] {
	return RPC_SETTING_PATHS.map(path => toRpcSetting(settings, path));
}

export async function setRpcSetting(
	session: RpcSettingsSession,
	pathInput: string,
	value: unknown,
): Promise<RpcSettingView> {
	if (!isRpcSettingPath(pathInput)) throw new Error(`Setting is not available over RPC: ${pathInput}`);
	const path = pathInput;
	const nextValue = validateSettingValue(path, value);
	session.settings.set(path, nextValue as never);

	if (path === "personality" || path === "includeModelInPrompt" || path === "tools.xdevDocs") {
		await session.refreshBaseSystemPrompt();
	} else if (path === "inspect_image.mode") {
		await session.applyInspectImageModeChange();
	}

	return toRpcSetting(session.settings, path);
}

function isRpcSettingPath(path: string): path is RpcSettingPath {
	return RPC_SETTING_PATH_SET.has(path);
}

function toRpcSetting(settings: Settings, path: RpcSettingPath): RpcSettingView {
	if (isCredential(path)) throw new Error(`Credential setting cannot be exposed over RPC: ${path}`);
	const ui = getUi(path);
	if (!ui) throw new Error(`Setting has no UI metadata: ${path}`);
	const value = settings.get(path);
	if (!isRpcSettingValue(value)) throw new Error(`Setting is not scalar: ${path}`);
	const type = getType(path);
	const options = type === "boolean" ? undefined : getSettingOptions(path);
	if (type !== "boolean" && (!options || options.length === 0)) {
		throw new Error(`Setting has no finite choices: ${path}`);
	}
	return {
		path,
		tab: normalizeRpcSettingTab(ui.tab),
		group: ui.group,
		label: ui.label,
		description: ui.description,
		control: type === "boolean" ? "toggle" : "select",
		value,
		options,
		apply: NEXT_SESSION_PATHS.has(path) ? "next-session" : "immediate",
	};
}

function getSettingOptions(path: RpcSettingPath): RpcSettingOption[] | undefined {
	const ui = getUi(path);
	const configured = ui && Array.isArray(ui.options) ? ui.options : undefined;
	const values = configured ?? getEnumValues(path)?.map(value => ({ value, label: formatOptionLabel(value) }));
	if (!values) return undefined;
	const numberSetting = getType(path) === "number";
	return values.map(option => ({
		value: numberSetting ? parseNumberOption(path, option.value) : option.value,
		label: option.label,
		description: option.description,
	}));
}

function parseNumberOption(path: RpcSettingPath, value: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric option for ${path}: ${value}`);
	return parsed;
}

function validateSettingValue(path: RpcSettingPath, value: unknown): RpcSettingValue {
	const type = getType(path);
	if (type === "boolean") {
		if (typeof value !== "boolean") throw new TypeError(`${path} must be boolean`);
		return value;
	}
	if (!isRpcSettingValue(value)) throw new TypeError(`${path} must be a scalar value`);
	const options = getSettingOptions(path);
	if (!options?.some(option => Object.is(option.value, value))) {
		throw new RangeError(`${String(value)} is not a supported value for ${path}`);
	}
	return value;
}

function isRpcSettingValue(value: unknown): value is RpcSettingValue {
	return (
		typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
	);
}

function normalizeRpcSettingTab(tab: SettingTab): RpcSettingTab {
	if (
		tab === "appearance" ||
		tab === "model" ||
		tab === "interaction" ||
		tab === "context" ||
		tab === "tools" ||
		tab === "tasks"
	)
		return tab;
	throw new Error(`Setting tab is not available over RPC: ${tab}`);
}

function formatOptionLabel(value: string): string {
	return value
		.split("-")
		.map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}
