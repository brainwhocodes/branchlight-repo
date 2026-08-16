export const RESERVED_CHILD_ENV_PREFIX = "BRANCHLIGHT_";
export const RESERVED_EXACT_ENV_NAMES = new Set([
	"PI_BROWSER_CDP_URL",
	"PI_RUNTIME_DIR",
	"PI_RUNTIME_TOKEN",
	"PI_RUNTIME_ENDPOINT",
]);

export function isReservedChildEnvName(name: string): boolean {
	if (name.startsWith(RESERVED_CHILD_ENV_PREFIX)) return true;
	if (RESERVED_EXACT_ENV_NAMES.has(name)) return true;
	return false;
}

let sanitizedUserEnvSnapshot: Readonly<Record<string, string>> | undefined;

/** Capture an immutable snapshot of user environment once at runtime entry, stripping reserved vars. */
export function captureSanitizedUserEnvironment(): Readonly<Record<string, string>> {
	if (sanitizedUserEnvSnapshot) return sanitizedUserEnvSnapshot;

	const snapshot: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (isReservedChildEnvName(key)) continue;
		snapshot[key] = value;
	}
	sanitizedUserEnvSnapshot = Object.freeze(snapshot);
	return sanitizedUserEnvSnapshot;
}

export interface BuildChildEnvironmentOptions {
	mode?: "inherit-current" | "clean";
	explicitBindings?: Record<string, string>;
	scopedDescriptor?: Record<string, string>;
}

export function buildChildEnvironment(options: BuildChildEnvironmentOptions = {}): Record<string, string> {
	const mode = options.mode ?? "inherit-current";
	const userSnapshot = captureSanitizedUserEnvironment();

	let base: Record<string, string>;
	if (mode === "clean") {
		base = {
			PATH:
				userSnapshot.PATH ??
				(process.platform === "win32" ? "C:\\Windows\\system32;C:\\Windows" : "/usr/bin:/bin:/usr/sbin:/sbin"),
			HOME: userSnapshot.HOME ?? userSnapshot.USERPROFILE ?? "/tmp",
			USER: userSnapshot.USER ?? userSnapshot.USERNAME ?? "user",
			TMPDIR: userSnapshot.TMPDIR ?? "/tmp",
			LC_ALL: "C",
		};
	} else {
		base = { ...userSnapshot };
	}

	// Apply explicit bindings, rejecting any reserved names
	if (options.explicitBindings) {
		for (const [key, value] of Object.entries(options.explicitBindings)) {
			if (isReservedChildEnvName(key)) continue;
			base[key] = value;
		}
	}

	// Internal step: append approved scoped descriptors
	if (options.scopedDescriptor) {
		for (const [key, value] of Object.entries(options.scopedDescriptor)) {
			base[key] = value;
		}
	}

	return base;
}
