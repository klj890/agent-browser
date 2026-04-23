/**
 * RoutinesView — Stage 10.
 *
 * Lists routines, shows status (last_run/next_run), supports create/edit/
 * delete/enable/runNow. Edit opens a textarea-based YAML editor; create uses
 * a simple form.
 */
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type {
	PersonaSummary,
	RoutineInput,
	RoutineStatusView,
} from "../../types/preload";

type EditorMode =
	| { kind: "closed" }
	| { kind: "create" }
	| { kind: "edit"; original: RoutineStatusView };

function fmtTs(ts?: number): string {
	if (!ts) return "—";
	const d = new Date(ts);
	return d.toLocaleString();
}

function routineToYaml(r: RoutineInput): string {
	const lines: string[] = [];
	lines.push(`name: ${JSON.stringify(r.name)}`);
	if (r.description)
		lines.push(`description: ${JSON.stringify(r.description)}`);
	lines.push(`schedule: ${JSON.stringify(r.schedule)}`);
	if (r.persona) lines.push(`persona: ${JSON.stringify(r.persona)}`);
	lines.push("prompt: |");
	for (const row of r.prompt.split(/\r?\n/)) lines.push(`  ${row}`);
	lines.push(`enabled: ${r.enabled}`);
	return lines.join("\n");
}

/** Extremely small YAML subset reader mirroring main-side parser. */
function yamlToRoutine(raw: string): RoutineInput {
	const lines = raw.split(/\r?\n/);
	const obj: Record<string, string | boolean> = {};
	let i = 0;
	const stripQ = (s: string) => {
		const v = s.trim();
		if (
			(v.startsWith('"') && v.endsWith('"')) ||
			(v.startsWith("'") && v.endsWith("'"))
		)
			return v.slice(1, -1);
		return v;
	};
	while (i < lines.length) {
		const line = lines[i] ?? "";
		i++;
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
		if (!m) continue;
		const key = m[1] as string;
		const rest = (m[2] ?? "").trim();
		if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
			const buf: string[] = [];
			while (i < lines.length) {
				const next = lines[i] ?? "";
				if (next.match(/^\S/) && next.trim() !== "") break;
				buf.push(next.replace(/^ {1,2}/, ""));
				i++;
			}
			obj[key] = buf.join(rest.startsWith(">") ? " " : "\n").trim();
		} else if (rest === "true") obj[key] = true;
		else if (rest === "false") obj[key] = false;
		else obj[key] = stripQ(rest);
	}
	if (typeof obj.name !== "string") throw new Error("missing name");
	if (typeof obj.schedule !== "string") throw new Error("missing schedule");
	if (typeof obj.prompt !== "string") throw new Error("missing prompt");
	const r: RoutineInput = {
		name: obj.name,
		schedule: obj.schedule,
		prompt: obj.prompt,
		enabled: obj.enabled === true,
	};
	if (typeof obj.description === "string") r.description = obj.description;
	if (typeof obj.persona === "string") r.persona = obj.persona;
	return r;
}

export function RoutinesView() {
	const [rows, setRows] = useState<RoutineStatusView[]>([]);
	const [personas, setPersonas] = useState<PersonaSummary[]>([]);
	const [editor, setEditor] = useState<EditorMode>({ kind: "closed" });
	const [error, setError] = useState<string | null>(null);
	const [toast, setToast] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const bridge = window.agentBrowser;
		if (!bridge?.routines) return;
		try {
			const [list, ps] = await Promise.all([
				bridge.routines.list(),
				bridge.persona?.list?.() ?? Promise.resolve([]),
			]);
			setRows(list);
			setPersonas(ps);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const showToast = (m: string) => {
		setToast(m);
		setTimeout(() => setToast(null), 2500);
	};

	const onDelete = async (name: string) => {
		if (!confirm(`Delete routine "${name}"?`)) return;
		try {
			await window.agentBrowser.routines.delete(name);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const onToggle = async (r: RoutineStatusView) => {
		try {
			await window.agentBrowser.routines.enable(r.name, !r.enabled);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const onRunNow = async (name: string) => {
		try {
			await window.agentBrowser.routines.runNow(name);
			showToast(`Triggered "${name}"`);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<section>
			<header style={{ display: "flex", alignItems: "center", gap: 12 }}>
				<h2 style={{ margin: 0 }}>Routines</h2>
				<button type="button" onClick={() => setEditor({ kind: "create" })}>
					New routine
				</button>
				<button type="button" onClick={refresh}>
					Refresh
				</button>
				{toast && <span style={{ color: "#059669" }}>{toast}</span>}
			</header>
			{error && (
				<p role="alert" style={{ color: "#dc2626" }}>
					{error}
				</p>
			)}
			<table
				style={{
					width: "100%",
					borderCollapse: "collapse",
					marginTop: 16,
					fontSize: 13,
				}}
			>
				<thead>
					<tr style={{ textAlign: "left", background: "#f3f4f6" }}>
						<th style={{ padding: 6 }}>Name</th>
						<th style={{ padding: 6 }}>Schedule</th>
						<th style={{ padding: 6 }}>Persona</th>
						<th style={{ padding: 6 }}>Enabled</th>
						<th style={{ padding: 6 }}>Last run</th>
						<th style={{ padding: 6 }}>Actions</th>
					</tr>
				</thead>
				<tbody>
					{rows.length === 0 && (
						<tr>
							<td colSpan={6} style={{ padding: 12, color: "#6b7280" }}>
								No routines defined.
							</td>
						</tr>
					)}
					{rows.map((r) => (
						<tr key={r.name} style={{ borderTop: "1px solid #e5e7eb" }}>
							<td style={{ padding: 6 }}>{r.name}</td>
							<td style={{ padding: 6, fontFamily: "monospace" }}>
								{r.schedule}
							</td>
							<td style={{ padding: 6 }}>{r.persona ?? "—"}</td>
							<td style={{ padding: 6 }}>
								{r.enabled ? (r.scheduled ? "yes" : "enabled*") : "no"}
							</td>
							<td style={{ padding: 6 }}>
								{fmtTs(r.lastRunAt)}{" "}
								{r.lastRunStatus === "error" && (
									<span style={{ color: "#dc2626" }}>(error)</span>
								)}
							</td>
							<td style={{ padding: 6, display: "flex", gap: 4 }}>
								<button type="button" onClick={() => onRunNow(r.name)}>
									Run now
								</button>
								<button type="button" onClick={() => onToggle(r)}>
									{r.enabled ? "Disable" : "Enable"}
								</button>
								<button
									type="button"
									onClick={() => setEditor({ kind: "edit", original: r })}
								>
									Edit
								</button>
								<button type="button" onClick={() => onDelete(r.name)}>
									Delete
								</button>
							</td>
						</tr>
					))}
				</tbody>
			</table>

			{editor.kind !== "closed" && (
				<RoutineEditor
					mode={editor}
					personas={personas}
					onClose={() => setEditor({ kind: "closed" })}
					onSaved={async () => {
						setEditor({ kind: "closed" });
						await refresh();
					}}
					onError={setError}
				/>
			)}
		</section>
	);
}

interface EditorProps {
	mode: Exclude<EditorMode, { kind: "closed" }>;
	personas: PersonaSummary[];
	onClose: () => void;
	onSaved: () => void | Promise<void>;
	onError: (msg: string) => void;
}

function RoutineEditor({
	mode,
	personas,
	onClose,
	onSaved,
	onError,
}: EditorProps) {
	const initial: RoutineInput =
		mode.kind === "edit"
			? {
					name: mode.original.name,
					description: mode.original.description,
					schedule: mode.original.schedule,
					persona: mode.original.persona,
					prompt: mode.original.prompt,
					enabled: mode.original.enabled,
				}
			: {
					name: "",
					schedule: "0 9 * * *",
					prompt: "",
					enabled: true,
				};

	const [form, setForm] = useState<RoutineInput>(initial);
	const [yamlMode, setYamlMode] = useState(mode.kind === "edit");
	const [yamlText, setYamlText] = useState(() => routineToYaml(initial));

	const onSubmit = async (e: FormEvent) => {
		e.preventDefault();
		try {
			const payload = yamlMode ? yamlToRoutine(yamlText) : form;
			const bridge = window.agentBrowser.routines;
			if (mode.kind === "create") {
				await bridge.create(payload);
			} else {
				await bridge.update(mode.original.name, payload);
			}
			await onSaved();
		} catch (err) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<div
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(0,0,0,0.4)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 50,
			}}
		>
			<form
				onSubmit={onSubmit}
				style={{
					background: "white",
					padding: 20,
					borderRadius: 8,
					width: 520,
					maxHeight: "80vh",
					overflow: "auto",
				}}
			>
				<h3 style={{ marginTop: 0 }}>
					{mode.kind === "create"
						? "New routine"
						: `Edit: ${mode.original.name}`}
				</h3>
				<label style={{ fontSize: 12 }}>
					<input
						type="checkbox"
						checked={yamlMode}
						onChange={(e) => {
							if (e.target.checked) setYamlText(routineToYaml(form));
							setYamlMode(e.target.checked);
						}}
					/>{" "}
					YAML editor
				</label>
				{yamlMode ? (
					<textarea
						value={yamlText}
						onChange={(e) => setYamlText(e.target.value)}
						rows={16}
						style={{
							width: "100%",
							fontFamily: "monospace",
							fontSize: 12,
							marginTop: 8,
						}}
					/>
				) : (
					<div style={{ display: "grid", gap: 8, marginTop: 8 }}>
						<label>
							Name
							<input
								required
								value={form.name}
								onChange={(e) => setForm({ ...form, name: e.target.value })}
								disabled={mode.kind === "edit"}
								style={{ width: "100%" }}
							/>
						</label>
						<label>
							Schedule (cron)
							<input
								required
								value={form.schedule}
								onChange={(e) => setForm({ ...form, schedule: e.target.value })}
								style={{ width: "100%", fontFamily: "monospace" }}
							/>
						</label>
						<label>
							Persona
							<select
								value={form.persona ?? ""}
								onChange={(e) =>
									setForm({
										...form,
										persona: e.target.value || undefined,
									})
								}
								style={{ width: "100%" }}
							>
								<option value="">(default)</option>
								{personas.map((p) => (
									<option key={p.slug} value={p.slug}>
										{p.name}
									</option>
								))}
							</select>
						</label>
						<label>
							Prompt
							<textarea
								required
								value={form.prompt}
								onChange={(e) => setForm({ ...form, prompt: e.target.value })}
								rows={6}
								style={{ width: "100%" }}
							/>
						</label>
						<label>
							<input
								type="checkbox"
								checked={form.enabled}
								onChange={(e) =>
									setForm({ ...form, enabled: e.target.checked })
								}
							/>{" "}
							Enabled
						</label>
					</div>
				)}
				<div
					style={{
						display: "flex",
						gap: 8,
						marginTop: 16,
						justifyContent: "flex-end",
					}}
				>
					<button type="button" onClick={onClose}>
						Cancel
					</button>
					<button type="submit">Save</button>
				</div>
			</form>
		</div>
	);
}
