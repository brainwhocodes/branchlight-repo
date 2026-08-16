export interface DesktopShutdownContext {
	host?: { stopAll(): Promise<void>; close(): Promise<void> };
	workspace?: { stop(): Promise<void> };
	runtimeClient?: { close(): Promise<void> };
	quit?: () => void;
}
export async function shutdownDesktopServices(context: DesktopShutdownContext): Promise<void> {
	try {
		if (context.host) await context.host.stopAll().catch(() => {});
		if (context.workspace) await context.workspace.stop().catch(() => {});
	} finally {
		try {
			if (context.runtimeClient) await context.runtimeClient.close().catch(() => {});
		} finally {
			try {
				if (context.host) await context.host.close().catch(() => {});
			} finally {
				context.quit?.();
			}
		}
	}
}
