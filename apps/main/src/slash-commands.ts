/**
 * Slash commands — Stage 7.4.
 *
 * Local-jsx commands (borrow claude-code-haha's taxonomy): the sidebar parses
 * leading `/` input locally and executes without round-tripping the LLM.
 *
 *   /stop           — abort the current task
 *   /screenshot     — capture the active tab as a screenshot
 *   /export-trace   — dump audit-log events for the current task as jsonl
 *   /clear-vault    — (placeholder) vault is P1-9, not implemented yet
 *   /dom-tree       — return the full accessibility snapshot as text
 *
 * The context bag is intentionally loose: every field is optional so the
 * sidebar can inject only what a given session has, and tests can inject
 * tight mocks per command.
 */
import type { TaskStateStore } from "./task-state.js";

export type SlashResult =
	| { kind: "text"; content: string }
	| { kind: "screenshot"; content: string }
	| { kind: "trace"; content: string };

export interface SlashCommandCtx {
	taskStore?: TaskStateStore;
	currentTaskId?: string;
	/** Auth Vault (P1 Stage 9). If present, /clear-vault calls vault.clear(). */
	vault?: { clear: () => Promise<void> };
	/** Minimal shape — a concrete shape lives in agent-host (Stage 3). */
	tools?: {
		screenshot?: (input: {
			ref?: string;
			full_page?: boolean;
		}) => Promise<unknown>;
		snapshot?: (input: {
			interactive_only?: boolean;
			include_text?: boolean;
		}) => Promise<unknown>;
	};
	/** Audit log lookup (Stage 6.4). May be undefined this early. */
	auditLog?: {
		listByTask: (
			taskId: string,
		) => Promise<ReadonlyArray<Record<string, unknown>>>;
	};
}

export interface SlashCommand {
	name: string;
	description: string;
	execute(ctx: SlashCommandCtx, rawArgs: string): Promise<SlashResult>;
}

export interface ParsedSlash {
	cmd: string;
	args: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class SlashCommandRegistry {
	private readonly commands = new Map<string, SlashCommand>();

	register(cmd: SlashCommand): void {
		this.commands.set(cmd.name, cmd);
	}

	list(): SlashCommand[] {
		return [...this.commands.values()];
	}

	/**
	 * Parse a raw input line into `{ cmd, args }` if it starts with `/` AND the
	 * name is registered. Returns null otherwise so unknown slashes fall
	 * through to the normal prompt path.
	 */
	parse(input: string): ParsedSlash | null {
		if (!input.startsWith("/")) return null;
		const rest = input.slice(1);
		if (rest.length === 0) return null;
		const spaceIdx = rest.indexOf(" ");
		const name = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
		const args = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);
		if (!this.commands.has(name)) return null;
		return { cmd: name, args };
	}

	async execute(ctx: SlashCommandCtx, input: string): Promise<SlashResult> {
		const parsed = this.parse(input);
		if (!parsed) {
			return { kind: "text", content: `unknown command: ${input}` };
		}
		const cmd = this.commands.get(parsed.cmd);
		if (!cmd) {
			return { kind: "text", content: `unknown command: ${parsed.cmd}` };
		}
		return cmd.execute(ctx, parsed.args);
	}
}

// ---------------------------------------------------------------------------
// Built-in commands
// ---------------------------------------------------------------------------

const stopCommand: SlashCommand = {
	name: "stop",
	description: "Abort the currently running task.",
	async execute(ctx) {
		if (!ctx.taskStore || !ctx.currentTaskId) {
			return { kind: "text", content: "no active task." };
		}
		try {
			ctx.taskStore.abort(ctx.currentTaskId);
			return { kind: "text", content: "stopped." };
		} catch (err) {
			return {
				kind: "text",
				content: `stop failed: ${(err as Error).message}`,
			};
		}
	},
};

const screenshotCommand: SlashCommand = {
	name: "screenshot",
	description: "Capture the active tab as a screenshot.",
	async execute(ctx) {
		const fn = ctx.tools?.screenshot;
		if (!fn) return { kind: "text", content: "screenshot tool not available." };
		const result = (await fn({})) as {
			base64?: string;
			data?: string;
		} & Record<string, unknown>;
		// screenshot tool (Stage 2) returns `{ base64, mime, ... }`.
		const b64 = result?.base64 ?? result?.data ?? "";
		return { kind: "screenshot", content: String(b64) };
	},
};

const exportTraceCommand: SlashCommand = {
	name: "export-trace",
	description: "Export audit-log events for the current task as jsonl.",
	async execute(ctx) {
		if (!ctx.auditLog) {
			return { kind: "text", content: "audit log not configured" };
		}
		if (!ctx.currentTaskId) {
			return { kind: "text", content: "no active task." };
		}
		const events = await ctx.auditLog.listByTask(ctx.currentTaskId);
		const jsonl = events.map((e) => JSON.stringify(e)).join("\n");
		return { kind: "trace", content: jsonl };
	},
};

const clearVaultCommand: SlashCommand = {
	name: "clear-vault",
	description: "Clear the credential vault.",
	async execute(ctx) {
		if (!ctx.vault) {
			return {
				kind: "text",
				content:
					"vault not implemented yet (P1-9); will require confirmation once landed.",
			};
		}
		try {
			await ctx.vault.clear();
			return { kind: "text", content: "vault cleared." };
		} catch (err) {
			return {
				kind: "text",
				content: `clear-vault failed: ${(err as Error).message}`,
			};
		}
	},
};

const domTreeCommand: SlashCommand = {
	name: "dom-tree",
	description: "Snapshot the full accessibility tree as text.",
	async execute(ctx) {
		const fn = ctx.tools?.snapshot;
		if (!fn) return { kind: "text", content: "snapshot tool not available." };
		const result = await fn({ interactive_only: false, include_text: true });
		// snapshot tool returns a structured object; serialize for text display.
		const text =
			typeof result === "string" ? result : JSON.stringify(result, null, 2);
		return { kind: "text", content: text };
	},
};

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
	stopCommand,
	screenshotCommand,
	exportTraceCommand,
	clearVaultCommand,
	domTreeCommand,
];

/** Convenience: build a registry prepopulated with the 5 built-ins. */
export function createDefaultSlashRegistry(): SlashCommandRegistry {
	const reg = new SlashCommandRegistry();
	for (const c of BUILTIN_SLASH_COMMANDS) reg.register(c);
	return reg;
}
