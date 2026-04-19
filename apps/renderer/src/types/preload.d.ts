/**
 * Types for the `window.agentBrowser` bridge exposed by apps/main/src/preload.ts.
 * Keep in sync with that file.
 */
export interface TabSummary {
	id: string;
	url: string;
	title: string;
	favicon?: string;
	state: "loading" | "idle" | "suspended" | "crashed";
	active: boolean;
	pinned: boolean;
	openedByAgent: boolean;
}

/**
 * Read-only mirror of the AdminPolicy shape. Keep in sync with
 * apps/main/src/admin-policy.ts (Stage 5.2: renderer never imports from main
 * directly so we duplicate the shape here).
 */
export interface AdminPolicyView {
	version: 1;
	autonomy: "manual" | "confirm-each" | "autonomous";
	allowedTools: string[];
	allowedDomains: string[];
	allowedUrlSchemes: Array<"http" | "https" | "data" | "blob" | "file">;
	blockedDomains: string[];
	forceConfirmActions: string[];
	costGuard: {
		maxTokensPerTask: number;
		maxUsdPerTask: number;
		maxUsdPerDay: number;
		maxStepsPerTask: number;
	};
	redaction: {
		enableDefaultRules: boolean;
		customPatterns: Array<{ name: string; pattern: string; flags: string }>;
	};
	egress: { blockNonAllowedInAutonomous: boolean; auditAllRequests: boolean };
	extension: { allowMv3: boolean; allowedExtensionIds: string[] };
}

export type AgentStreamChunk =
	| { type: "text"; delta: string }
	| {
			type: "tool_call";
			id: string;
			name: string;
			args: Record<string, unknown>;
	  }
	| {
			type: "tool_result";
			id: string;
			name: string;
			result?: unknown;
			denied?: boolean;
			error?: string;
	  }
	| { type: "error"; message: string; reason: string }
	| { type: "done"; reason: string };

export interface PersonaSummary {
	slug: string;
	name: string;
	description: string;
	domains: string[];
	active: boolean;
}

export interface AgentBrowserBridge {
	agent: {
		prompt: (text: string) => Promise<string>;
		cancel: (taskId: string) => Promise<unknown>;
		onStream: (cb: (chunk: AgentStreamChunk) => void) => () => void;
	};
	tab: {
		open: (url: string) => Promise<string>;
		close: (id: string) => Promise<boolean>;
		focus: (id: string) => Promise<boolean>;
		list: () => Promise<TabSummary[]>;
		navigate: (id: string, url: string) => Promise<boolean>;
		back: (id: string) => Promise<boolean>;
		forward: (id: string) => Promise<boolean>;
		reload: (id: string) => Promise<boolean>;
		undoClose: () => Promise<string | null>;
		snapshotCurrent: () => Promise<string | null>;
	};
	policy: {
		get: () => Promise<AdminPolicyView>;
	};
	persona: {
		list: () => Promise<PersonaSummary[]>;
		switch: (slug: string) => Promise<PersonaSummary>;
	};
	slash?: {
		execute: (input: string) => Promise<unknown>;
	};
	/**
	 * Auth Vault (P1 Stage 9). `get` is intentionally absent — plaintext secrets
	 * never cross the process boundary into the renderer.
	 */
	vault: {
		set: (key: string, secret: string) => Promise<boolean>;
		list: () => Promise<string[]>;
		delete: (key: string) => Promise<boolean>;
		clear: () => Promise<boolean>;
	};
}

declare global {
	interface Window {
		agentBrowser: AgentBrowserBridge;
	}
}
