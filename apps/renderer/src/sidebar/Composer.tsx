import { type FormEvent, useState } from "react";

export interface ComposerProps {
	running: boolean;
	onSubmit: (text: string) => void;
	onCancel: () => void;
	onIncludePage: () => void;
}

export function Composer({
	running,
	onSubmit,
	onCancel,
	onIncludePage,
}: ComposerProps) {
	const [text, setText] = useState("");

	const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const trimmed = text.trim();
		if (!trimmed) return;
		onSubmit(trimmed);
		setText("");
	};

	return (
		<form className="composer" onSubmit={handleSubmit}>
			<div className="composer-top-row">
				<button
					type="button"
					className="composer-page-btn"
					onClick={onIncludePage}
					disabled={running}
					title="Attach the current page's URL to your next prompt"
				>
					+ page
				</button>
				{running ? (
					<button type="button" className="composer-cancel" onClick={onCancel}>
						cancel
					</button>
				) : null}
			</div>
			<textarea
				value={text}
				onChange={(e) => setText(e.target.value)}
				placeholder={running ? "waiting for agent..." : "Ask the agent..."}
				disabled={running}
				rows={3}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						e.currentTarget.form?.requestSubmit();
					}
				}}
			/>
			<button
				type="submit"
				className="composer-submit"
				disabled={running || text.trim() === ""}
			>
				Send
			</button>
		</form>
	);
}
