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

export interface HistoryEntryView {
	id: number;
	url: string;
	title: string;
	visited_at: number;
}

export interface BookmarkView {
	id: number;
	url: string;
	title: string;
	folder: string;
	position: number;
	created_at: number;
}

export interface TaskTraceSummary {
	task_id: string;
	started_at: number;
	ended_at?: number;
	status: "running" | "completed" | "failed" | "killed" | "budget_exceeded";
	persona: string;
}

export type TraceEvent =
	| {
			event: "llm.call.pre";
			ts: number;
			task_id: string;
			model: string;
			provider: string;
			input_tokens_est: number;
			redaction_hits: Record<string, number>;
			persona: string;
			autonomy: string;
	  }
	| {
			event: "llm.call.post";
			ts: number;
			task_id: string;
			model: string;
			input_tokens: number;
			output_tokens: number;
			usd_cost: number;
			finish_reason: string;
			duration_ms: number;
	  }
	| {
			event: "tool.call";
			ts: number;
			task_id: string;
			tool: string;
			args_hash: string;
			ref?: string;
			result_ref: string | null;
			byte_size: number;
			high_risk_flags: string[];
	  }
	| {
			event: "tool.confirm";
			ts: number;
			task_id: string;
			tool: string;
			decision: "approved" | "denied" | "timeout";
			latency_ms: number;
	  }
	| {
			event: "task.start";
			ts: number;
			task_id: string;
			user_prompt_hash: string;
			persona: string;
			tab_url: string;
	  }
	| {
			event: "task.end";
			ts: number;
			task_id: string;
			status: "completed" | "failed" | "killed" | "budget_exceeded";
			steps: number;
			total_usd: number;
			total_tokens: number;
	  }
	| {
			event: "task.state-change";
			ts: number;
			task_id: string;
			from: string;
			to: string;
			reason?: string;
	  }
	| {
			event: "injection.flag";
			ts: number;
			task_id: string;
			source_url: string;
			pattern: string;
			snippet_hash: string;
	  }
	| {
			event: "policy.change";
			ts: number;
			actor: "admin";
			diff: object;
			prev_hash: string;
			new_hash: string;
	  };

export interface UnknownTraceEvent {
	event: string;
	ts: number;
	[key: string]: unknown;
}

export interface DownloadRecordView {
	id: string;
	url: string;
	filename: string;
	path: string;
	state: "progressing" | "paused" | "completed" | "cancelled" | "interrupted";
	received: number;
	total: number;
	started_at: number;
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
		create?: (input: {
			slug: string;
			name: string;
			description: string;
			domains: string[];
			body: string;
		}) => Promise<PersonaSummary>;
		update?: (
			slug: string,
			input: {
				name?: string;
				description?: string;
				domains?: string[];
				body?: string;
			},
		) => Promise<PersonaSummary>;
		delete?: (slug: string) => Promise<boolean>;
		getSource?: (slug: string) => Promise<string>;
	};
	slash?: {
		execute: (input: string) => Promise<unknown>;
	};
	vault: {
		set: (key: string, secret: string) => Promise<boolean>;
		list: () => Promise<string[]>;
		delete: (key: string) => Promise<boolean>;
		clear: () => Promise<boolean>;
	};
	trace: {
		listTasks: (limit?: number) => Promise<TaskTraceSummary[]>;
		getTaskEvents: (taskId: string) => Promise<TraceEvent[]>;
		clear: () => Promise<boolean>;
	};
	history: {
		list: (limit?: number, offset?: number) => Promise<HistoryEntryView[]>;
		search: (q: string, limit?: number) => Promise<HistoryEntryView[]>;
		clear: () => Promise<boolean>;
	};
	bookmarks: {
		add: (input: {
			url: string;
			title?: string;
			folder?: string;
		}) => Promise<BookmarkView>;
		remove: (id: number) => Promise<boolean>;
		list: (folder?: string) => Promise<BookmarkView[]>;
		reorder: (folder: string, ids: number[]) => Promise<boolean>;
	};
	downloads: {
		list: () => Promise<DownloadRecordView[]>;
		cancel: (id: string) => Promise<boolean>;
		openFolder: (id: string) => Promise<boolean>;
		onProgress: (cb: (rec: DownloadRecordView) => void) => () => void;
	};
}

declare global {
	interface Window {
		agentBrowser: AgentBrowserBridge;
	}
}
