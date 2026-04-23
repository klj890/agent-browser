import { useCallback, useEffect, useState } from "react";
import type { PersonaSummary } from "../../types/preload";

interface DraftState {
	slug: string;
	name: string;
	description: string;
	domains: string;
	body: string;
	editing: string | null; // slug being edited, or null for new
}

const EMPTY: DraftState = {
	slug: "",
	name: "",
	description: "",
	domains: "",
	body: "# Persona\n\nDescribe the expert role here.",
	editing: null,
};

export function PersonasView() {
	const [personas, setPersonas] = useState<PersonaSummary[]>([]);
	const [draft, setDraft] = useState<DraftState>(EMPTY);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		const bridge = window.agentBrowser;
		if (!bridge?.persona) return;
		try {
			const list = await bridge.persona.list();
			setPersonas(list);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const onSwitch = async (slug: string) => {
		const bridge = window.agentBrowser;
		if (!bridge?.persona) return;
		try {
			await bridge.persona.switch(slug);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const startNew = () => setDraft({ ...EMPTY, editing: "__new__" });
	const startEdit = (p: PersonaSummary) => {
		setDraft({
			slug: p.slug,
			name: p.name,
			description: p.description,
			domains: p.domains.join(", "),
			body: "# " + p.name + "\n\n" + p.description,
			editing: p.slug,
		});
	};

	const cancelEdit = () => setDraft(EMPTY);

	const save = () => {
		const payload = {
			slug: draft.slug,
			name: draft.name,
			description: draft.description,
			domains: draft.domains
				.split(",")
				.map((d) => d.trim())
				.filter(Boolean),
			body: draft.body,
		};
		// TODO: wire to persona.create / persona.update once main IPC lands.
		console.log("[personas] save draft", draft.editing, payload);
		setDraft(EMPTY);
	};

	const del = (slug: string) => {
		// TODO: wire to persona.delete once main IPC lands.
		console.log("[personas] delete", slug);
	};

	const isEditing = draft.editing !== null;

	return (
		<section className="settings-view">
			<div className="settings-view-header">
				<h2>Personas</h2>
				<button type="button" onClick={startNew} disabled={isEditing}>
					+ New persona
				</button>
			</div>
			{error && (
				<p role="alert" className="settings-error">
					{error}
				</p>
			)}
			<table className="settings-table">
				<thead>
					<tr>
						<th>Slug</th>
						<th>Name</th>
						<th>Description</th>
						<th>Domains</th>
						<th>Active</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{personas.map((p) => (
						<tr key={p.slug}>
							<td>
								<code>{p.slug}</code>
							</td>
							<td>{p.name}</td>
							<td>{p.description}</td>
							<td>{p.domains.join(", ") || "—"}</td>
							<td>{p.active ? "✓" : ""}</td>
							<td className="settings-actions">
								<button
									type="button"
									onClick={() => onSwitch(p.slug)}
									disabled={p.active}
								>
									Use
								</button>
								<button type="button" onClick={() => startEdit(p)}>
									Edit
								</button>
								<button type="button" onClick={() => del(p.slug)}>
									Delete
								</button>
							</td>
						</tr>
					))}
					{personas.length === 0 && (
						<tr>
							<td colSpan={6} className="settings-empty">
								No personas loaded.
							</td>
						</tr>
					)}
				</tbody>
			</table>

			{isEditing && (
				<div className="settings-editor">
					<h3>
						{draft.editing === "__new__"
							? "New persona"
							: `Editing ${draft.editing}`}
					</h3>
					<label className="settings-field">
						<span>Slug</span>
						<input
							value={draft.slug}
							onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
							disabled={draft.editing !== "__new__"}
							placeholder="e.g. researcher"
						/>
					</label>
					<label className="settings-field">
						<span>Name</span>
						<input
							value={draft.name}
							onChange={(e) => setDraft({ ...draft, name: e.target.value })}
						/>
					</label>
					<label className="settings-field">
						<span>Description</span>
						<input
							value={draft.description}
							onChange={(e) =>
								setDraft({ ...draft, description: e.target.value })
							}
						/>
					</label>
					<label className="settings-field">
						<span>Domains (comma separated)</span>
						<input
							value={draft.domains}
							onChange={(e) => setDraft({ ...draft, domains: e.target.value })}
							placeholder="github.com, stackoverflow.com"
						/>
					</label>
					<label className="settings-field">
						<span>Markdown body</span>
						<textarea
							rows={12}
							value={draft.body}
							onChange={(e) => setDraft({ ...draft, body: e.target.value })}
						/>
					</label>
					<div className="settings-actions">
						<button type="button" onClick={save}>
							Save
						</button>
						<button type="button" onClick={cancelEdit}>
							Cancel
						</button>
					</div>
				</div>
			)}
		</section>
	);
}
