export interface RpcCommand {
	id?: string;
	type: string;
	[key: string]: unknown;
}

export interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
	code?: string;
}

export interface RpcExtensionUIRequest {
	type: "extension_ui_request";
	id: string;
	method:
		| "select"
		| "confirm"
		| "input"
		| "editor"
		| "cancel"
		| "notify"
		| "setStatus"
		| "setWidget"
		| "setTitle"
		| "set_editor_text"
		| "open_url";
	targetId?: string;
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	sensitive?: boolean;
	prefill?: string;
	text?: string;
	url?: string;
	launchUrl?: string;
	instructions?: string;
	notifyType?: "info" | "warning" | "error";
	statusKey?: string;
	statusText?: string;
	widgetKey?: string;
	widgetLines?: string[];
	widgetPlacement?: "aboveEditor" | "belowEditor";
}

export interface RpcExtensionUIResponse {
	type: "extension_ui_response";
	id: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: true;
	timedOut?: boolean;
}
