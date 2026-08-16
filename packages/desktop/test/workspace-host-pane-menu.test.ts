import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

interface CapturedMenuItem {
	label?: string;
	type?: "separator";
	enabled?: boolean;
	click?: () => void;
}

const menuHarness = vi.hoisted(() => ({
	templates: [] as CapturedMenuItem[][],
	menus: [] as Array<{ popup: Mock }>,
}));

vi.mock("electron", () => ({
	Menu: {
		buildFromTemplate: vi.fn((template: CapturedMenuItem[]) => {
			const menu = { popup: vi.fn() };
			menuHarness.templates.push(template);
			menuHarness.menus.push(menu);
			return menu;
		}),
	},
	WebContentsView: class {},
}));

import { WorkspaceHost } from "../src/main/workspace-host";

const PANE_ID = "pane-main-0001";

afterEach(() => {
	menuHarness.templates.length = 0;
	menuHarness.menus.length = 0;
	vi.clearAllMocks();
});

function createHost(): { host: WorkspaceHost; send: Mock; window: object } {
	const send = vi.fn();
	const window = {
		isDestroyed: () => false,
		webContents: {
			isDestroyed: () => false,
			send,
		},
		contentView: {
			addChildView: vi.fn(),
			removeChildView: vi.fn(),
		},
	};
	return { host: new WorkspaceHost(window as never, "http://127.0.0.1:9222"), send, window };
}

function capturedTemplate(): CapturedMenuItem[] {
	const template = menuHarness.templates.at(-1);
	if (!template) throw new Error("Expected a native menu template");
	return template;
}

function capturedMenuItem(label: string): CapturedMenuItem {
	const item = capturedTemplate().find(candidate => candidate.label === label);
	if (!item) throw new Error(`Expected native menu item: ${label}`);
	return item;
}

function select(item: CapturedMenuItem): void {
	if (!item.click) throw new Error(`Expected ${item.label ?? "menu item"} to be selectable`);
	item.click();
}

describe("WorkspaceHost pane context menu", () => {
	it("opens the native pane menu and emits the selected pane actions", () => {
		const { host, send, window } = createHost();

		host.showPaneContextMenu(PANE_ID, true);

		expect(capturedTemplate().map(item => (item.type === "separator" ? "separator" : item.label))).toEqual([
			"Split Right",
			"Split Down",
			"separator",
			"Close Pane",
		]);
		expect(capturedMenuItem("Split Right").enabled).toBe(true);
		expect(capturedMenuItem("Split Down").enabled).toBe(true);
		expect(capturedMenuItem("Close Pane").enabled ?? true).toBe(true);
		expect(menuHarness.menus).toHaveLength(1);
		expect(menuHarness.menus[0]?.popup).toHaveBeenCalledOnce();
		expect(menuHarness.menus[0]?.popup).toHaveBeenCalledWith({ window });

		select(capturedMenuItem("Split Right"));
		select(capturedMenuItem("Split Down"));
		select(capturedMenuItem("Close Pane"));

		expect(send.mock.calls).toEqual([
			["branchlight:workspace", { type: "pane-context-action", paneId: PANE_ID, action: "split-columns" }],
			["branchlight:workspace", { type: "pane-context-action", paneId: PANE_ID, action: "split-rows" }],
			["branchlight:workspace", { type: "pane-context-action", paneId: PANE_ID, action: "close" }],
		]);
	});

	it("disables only split actions when the pane cannot split", () => {
		const { host, window } = createHost();

		host.showPaneContextMenu(PANE_ID, false);

		expect(capturedMenuItem("Split Right").enabled).toBe(false);
		expect(capturedMenuItem("Split Down").enabled).toBe(false);
		expect(capturedMenuItem("Close Pane").enabled ?? true).toBe(true);
		expect(menuHarness.menus).toHaveLength(1);
		expect(menuHarness.menus[0]?.popup).toHaveBeenCalledOnce();
		expect(menuHarness.menus[0]?.popup).toHaveBeenCalledWith({ window });
	});
});
