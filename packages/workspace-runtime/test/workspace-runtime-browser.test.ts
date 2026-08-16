import { describe, expect, it } from "bun:test";
import { WorkspaceBrowserManager, WorkspaceBrowserSession } from "../src";

describe("WorkspaceBrowserSession & Manager", () => {
	it("initializes browser session with state and options", () => {
		const session = new WorkspaceBrowserSession({
			id: "browser-test-1",
			url: "https://omp.sh",
			headless: true,
		});

		expect(session.id).toBe("browser-test-1");
		expect(session.status).toBe("opening");
		expect(session.url).toBe("https://omp.sh");
	});

	it("manages browser registry in manager", async () => {
		const manager = new WorkspaceBrowserManager();
		expect(manager.sessionCount).toBe(0);

		const session = new WorkspaceBrowserSession({
			id: "browser-mgr-1",
			url: "about:blank",
		});

		// Test mock evaluation
		expect(session.status).toBe("opening");
		await session.close();
		expect(session.status).toBe("closed");
	});
});
