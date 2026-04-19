/**
 * TraceView — Stage 14 trace viewer.
 *
 * Left column: recent tasks (from audit-log). Right column: event timeline for
 * the selected task with per-type rendering (llm-call, tool-call, redaction
 * hits, etc.). Allows exporting the current task as JSON and clearing the
 * on-disk audit log (with confirmation).
 *
 * Patterned after claude-code-haha's trace panel; kept minimal to avoid UI
 * library deps.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
	TaskTraceSummary,
	TraceEvent,
	UnknownTraceEvent,
} from "../../types/preload";

type AnyEvent = TraceEvent | UnknownTraceEvent;

function isKnown(e: AnyEvent): e is TraceEvent {
	return [
		"task.start",
		"task.end",
		"task.state-change",
		"llm.call.pre",
		"llm.call.post",
		"tool.call",
		"tool.confirm",
		"injection.flag",
		"policy.change",
	].includes(e.event);
}

function fmtTs(ts: number): string {
	if (!ts) return "";
	const d = new Date(ts);
	return d.toLocaleString();
}

function fmtDuration(a: number, b?: number): string {
	if (!b) return "…";
	const ms = b - a;
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

interface EventRowProps {
	evt: AnyEvent;
}

function FallbackRow({ evt }: { evt: AnyEvent }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="trace-evt trace-evt-fallback">
			<button
				type="button"
				className="trace-evt-toggle"
				onClick={() => setOpen(!open)}
			>
				{open ? "▾" : "▸"}
			</button>
			<span className="trace-evt-time">{fmtTs(evt.ts)}</span>
			<span className="trace-evt-badge">{evt.event}</span>
			{open && (
				<pre className="trace-evt-json">{JSON.stringify(evt, null, 2)}</pre>
			)}
		</div>
	);
}

function EventRow({ evt }: EventRowProps) {
	const [open, setOpen] = useState(false);
	const time = fmtTs(evt.ts);

	if (!isKnown(evt)) return <FallbackRow evt={evt} />;

	// Known, strongly-typed variants.
	switch (evt.event) {
		case "task.start":
			return (
				<div className="trace-evt trace-evt-task">
					<span className="trace-evt-time">{time}</span>
					<span className="trace-evt-badge">task.start</span>
					<span className="trace-evt-text">
						persona={evt.persona} tab={evt.tab_url}
					</span>
				</div>
			);
		case "task.end":
			return (
				<div className="trace-evt trace-evt-task">
					<span className="trace-evt-time">{time}</span>
					<span className="trace-evt-badge">task.end</span>
					<span className="trace-evt-text">
						status={evt.status} steps={evt.steps} usd=$
						{evt.total_usd.toFixed(4)} tokens={evt.total_tokens}
					</span>
				</div>
			);
		case "task.state-change":
			return (
				<div className="trace-evt trace-evt-state">
					<span className="trace-evt-time">{time}</span>
					<span className="trace-evt-badge">state</span>
					<span className="trace-evt-text">
						{evt.from} → {evt.to}
						{evt.reason ? ` (${evt.reason})` : ""}
					</span>
				</div>
			);
		case "llm.call.pre":
			return (
				<div className="trace-evt trace-evt-llm">
					<span className="trace-evt-time">{time}</span>
					<span className="trace-evt-badge trace-badge-llm">llm.pre</span>
					<span className="trace-evt-text">
						{evt.provider}/{evt.model} ~{evt.input_tokens_est} in-tok
					</span>
				</div>
			);
		case "llm.call.post":
			return (
				<div className="trace-evt trace-evt-llm">
					<button
						type="button"
						className="trace-evt-toggle"
						onClick={() => setOpen(!open)}
					>
						{open ? "▾" : "▸"}
					</button>
					<span className="trace-evt-time">{time}</span>
					<span className="trace-evt-badge trace-badge-llm">llm.post</span>
					<span className="trace-evt-text">
						{evt.model} in={evt.input_tokens} out={evt.output_tokens} $
						{evt.usd_cost.toFixed(4)} {evt.duration_ms}ms
					</span>
					{open && (
						<pre className="trace-evt-json">{JSON.stringify(evt, null, 2)}</pre>
					)}
				</div>
			);
		case "tool.call":
			return (
				<div className="trace-evt trace-evt-tool">
					<button
						type="button"
						className="trace-evt-toggle"
						onClick={() => setOpen(!open)}
					>
						{open ? "▾" : "▸"}
					</button>
					<span className="trace-evt-time">{time}</span>
					<span className="trace-evt-badge trace-badge-tool">tool</span>
					<span className="trace-evt-text">
						{evt.tool} · {evt.byte_size}B
						{evt.high_risk_flags.length
							? ` · risk:${evt.high_risk_flags.join(",")}`
							: ""}
					</span>
					{open && (
						<pre className="trace-evt-json">{JSON.stringify(evt, null, 2)}</pre>
					)}
				</div>
			);
		case "tool.confirm":
			return (
				<div className="trace-evt trace-evt-tool">
					<span className="trace-evt-time">{time}</span>
					<span className="trace-evt-badge trace-badge-tool">confirm</span>
					<span className="trace-evt-text">
						{evt.tool} → {evt.decision} ({evt.latency_ms}ms)
					</span>
				</div>
			);
		case "injection.flag":
			return (
				<div className="trace-evt trace-evt-red">
					<span className="trace-evt-time">{time}</span>
					<span className="trace-evt-badge trace-badge-red">redaction</span>
					<span className="trace-evt-text">
						{evt.pattern} @ {evt.source_url}
					</span>
				</div>
			);
		default:
			return <FallbackRow evt={evt as AnyEvent} />;
	}
}

export function TraceView() {
	const [tasks, setTasks] = useState<TaskTraceSummary[]>([]);
	const [selected, setSelected] = useState<string | undefined>();
	const [events, setEvents] = useState<AnyEvent[]>([]);
	const [err, setErr] = useState<string | undefined>();

	const refresh = useCallback(async () => {
		const bridge = window.agentBrowser;
		if (!bridge?.trace) {
			setErr("trace bridge unavailable");
			return;
		}
		try {
			const list = await bridge.trace.listTasks(100);
			setTasks(list);
			if (!selected && list.length > 0) setSelected(list[0]?.task_id);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		}
	}, [selected]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (!selected) {
			setEvents([]);
			return;
		}
		const bridge = window.agentBrowser;
		if (!bridge?.trace) return;
		bridge.trace
			.getTaskEvents(selected)
			.then((evts) => setEvents(evts))
			.catch((e) => setErr(e instanceof Error ? e.message : String(e)));
	}, [selected]);

	const startEvent = useMemo(
		() => events.find((e) => e.event === "task.start"),
		[events],
	);

	const onExport = () => {
		if (!selected) return;
		const blob = new Blob([JSON.stringify(events, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `trace-${selected}.json`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	const onClear = async () => {
		if (
			!window.confirm(
				"Clear all audit log files on disk? This cannot be undone.",
			)
		) {
			return;
		}
		const bridge = window.agentBrowser;
		if (!bridge?.trace) return;
		await bridge.trace.clear();
		setTasks([]);
		setEvents([]);
		setSelected(undefined);
	};

	return (
		<section className="trace-view">
			<header className="trace-header">
				<h2>Trace</h2>
				<div className="trace-actions">
					<button type="button" onClick={() => void refresh()}>
						Refresh
					</button>
					<button type="button" onClick={onExport} disabled={!selected}>
						Export JSON
					</button>
					<button type="button" onClick={() => void onClear()}>
						Clear
					</button>
				</div>
			</header>
			{err && <p role="alert">Error: {err}</p>}
			<div className="trace-split">
				<aside className="trace-tasks">
					{tasks.length === 0 && <p className="trace-empty">No tasks yet.</p>}
					{tasks.map((t) => {
						const prompt = "";
						return (
							<button
								type="button"
								key={t.task_id}
								className={`trace-task ${selected === t.task_id ? "active" : ""}`}
								onClick={() => setSelected(t.task_id)}
							>
								<div className="trace-task-top">
									<span className="trace-task-persona">{t.persona || "?"}</span>
									<span
										className={`trace-task-status trace-status-${t.status}`}
									>
										{t.status}
									</span>
								</div>
								<div className="trace-task-id" title={t.task_id}>
									{t.task_id.slice(0, 12)}
									{prompt ? ` · ${prompt}` : ""}
								</div>
								<div className="trace-task-meta">
									{fmtTs(t.started_at)} ·{" "}
									{fmtDuration(t.started_at, t.ended_at)}
								</div>
							</button>
						);
					})}
				</aside>
				<div className="trace-events">
					{!selected && <p className="trace-empty">Select a task.</p>}
					{selected && events.length === 0 && (
						<p className="trace-empty">No events for this task.</p>
					)}
					{startEvent && (
						<div className="trace-task-header">
							<strong>task:</strong> {selected}
						</div>
					)}
					{events.map((e, i) => (
						<EventRow key={`${e.ts}-${i}`} evt={e} />
					))}
				</div>
			</div>
		</section>
	);
}
