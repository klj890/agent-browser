/**
 * TaskStateStore — Stage 7.1.
 *
 * Authoritative, in-memory state machine for Agent tasks. The AgentHost
 * (Stage 3, PLAN 附录 L) drives transitions; Stage 6.4 audit-log and the
 * Stage 3 sidebar both subscribe via `onChange` for push updates.
 *
 * Design follows claude-code-haha's `Task.ts`:
 *   pending ─► running ─► {completed | failed | killed | budget_exceeded}
 * Once a terminal state is reached, no further transitions are allowed.
 * We explicitly forbid running → running (a task can't "re-enter" itself;
 * step counter bumps go through `update`, not `transition`).
 */
import { nanoid } from "nanoid";

export type TaskStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "killed"
	| "budget_exceeded";

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
	"completed",
	"failed",
	"killed",
	"budget_exceeded",
]);

export function isTerminalTaskStatus(s: TaskStatus): boolean {
	return TERMINAL.has(s);
}

export interface Task {
	id: string;
	prompt: string;
	persona: string;
	tabId: string;
	status: TaskStatus;
	step: number;
	totalTokens: number;
	totalUsd: number;
	createdAt: number;
	updatedAt: number;
	/** AbortSignal callers pass down to LLM streams / tool executors. */
	abortController: AbortController;
}

export type TaskPatch = Partial<
	Pick<Task, "step" | "totalTokens" | "totalUsd">
>;

export type Unsubscribe = () => void;

export class InvalidTransitionError extends Error {
	constructor(
		public readonly from: TaskStatus,
		public readonly to: TaskStatus,
		public readonly taskId: string,
	) {
		super(`invalid task transition: ${from} → ${to} (task=${taskId})`);
		this.name = "InvalidTransitionError";
	}
}

export class TaskNotFoundError extends Error {
	constructor(public readonly taskId: string) {
		super(`task not found: ${taskId}`);
		this.name = "TaskNotFoundError";
	}
}

/**
 * Validates `from → to` against the task lifecycle.
 *
 *   pending   → running                                         ✓
 *   pending   → {completed|failed|killed|budget_exceeded}       ✓ (short-circuit aborts)
 *   running   → {completed|failed|killed|budget_exceeded}       ✓
 *   running   → running                                         ✗ (bump step via `update`)
 *   running   → pending                                         ✗
 *   terminal  → *                                               ✗
 *
 * We allow pending → terminal (not just pending → running → terminal) so that
 * a user can abort a task that hasn't made it to running yet.
 */
function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
	if (TERMINAL.has(from)) return false;
	if (from === "pending") {
		return to === "running" || TERMINAL.has(to);
	}
	if (from === "running") {
		return TERMINAL.has(to);
	}
	return false;
}

export interface CreateTaskInput {
	prompt: string;
	persona: string;
	tabId: string;
}

export class TaskStateStore {
	private readonly tasks = new Map<string, Task>();
	private readonly listeners = new Set<(task: Task) => void>();

	create(initial: CreateTaskInput): Task {
		const now = Date.now();
		const task: Task = {
			id: nanoid(),
			prompt: initial.prompt,
			persona: initial.persona,
			tabId: initial.tabId,
			status: "pending",
			step: 0,
			totalTokens: 0,
			totalUsd: 0,
			createdAt: now,
			updatedAt: now,
			abortController: new AbortController(),
		};
		this.tasks.set(task.id, task);
		this.emit(task);
		return task;
	}

	get(id: string): Task {
		const t = this.tasks.get(id);
		if (!t) throw new TaskNotFoundError(id);
		return t;
	}

	transition(id: string, newStatus: TaskStatus): Task {
		const t = this.get(id);
		if (!isValidTransition(t.status, newStatus)) {
			throw new InvalidTransitionError(t.status, newStatus, id);
		}
		t.status = newStatus;
		t.updatedAt = Date.now();
		this.emit(t);
		return t;
	}

	update(id: string, patch: TaskPatch): Task {
		const t = this.get(id);
		if (patch.step !== undefined) t.step = patch.step;
		if (patch.totalTokens !== undefined) t.totalTokens = patch.totalTokens;
		if (patch.totalUsd !== undefined) t.totalUsd = patch.totalUsd;
		t.updatedAt = Date.now();
		this.emit(t);
		return t;
	}

	listActive(): Task[] {
		const out: Task[] = [];
		for (const t of this.tasks.values()) {
			if (t.status === "pending" || t.status === "running") out.push(t);
		}
		return out;
	}

	/**
	 * Abort a task: fire its AbortController and transition → killed.
	 * Idempotent-ish: if the task is already terminal, this is a no-op; if it's
	 * pending/running, both the signal and the status are updated atomically.
	 */
	abort(id: string): void {
		const t = this.get(id);
		if (TERMINAL.has(t.status)) return;
		// Fire signal first so any awaiting I/O unwinds before we flip state.
		if (!t.abortController.signal.aborted) {
			try {
				t.abortController.abort();
			} catch {
				/* AbortController.abort never throws in practice */
			}
		}
		t.status = "killed";
		t.updatedAt = Date.now();
		this.emit(t);
	}

	onChange(cb: (task: Task) => void): Unsubscribe {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	private emit(task: Task): void {
		for (const cb of this.listeners) {
			try {
				cb(task);
			} catch {
				/* listener errors must not break the store */
			}
		}
	}
}
