import { useEffect, useState } from "react";
import type { ReadingArticleView } from "../types/preload";

interface Props {
	tabId: string;
	onClose: () => void;
}

type LoadState =
	| { status: "loading" }
	| { status: "ok"; article: ReadingArticleView }
	| { status: "empty" }
	| { status: "error"; message: string };

export function ReadingMode({ tabId, onClose }: Props) {
	const [state, setState] = useState<LoadState>({ status: "loading" });

	useEffect(() => {
		let cancelled = false;
		const bridge = window.agentBrowser?.reading;
		if (!bridge) {
			setState({ status: "error", message: "Reading mode IPC unavailable." });
			return;
		}
		void bridge
			.extract(tabId)
			.then((article) => {
				if (cancelled) return;
				if (!article || !article.contentHtml) {
					setState({ status: "empty" });
					return;
				}
				setState({ status: "ok", article });
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setState({
					status: "error",
					message: err instanceof Error ? err.message : String(err),
				});
			});
		return () => {
			cancelled = true;
		};
	}, [tabId]);

	return (
		<div
			className="reading-overlay"
			role="dialog"
			aria-modal="true"
			aria-label="Reading mode"
		>
			<div className="reading-frame">
				<header className="reading-toolbar">
					<span>Reading mode</span>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close reading mode"
					>
						×
					</button>
				</header>
				<article className="reading-body">
					{state.status === "loading" && (
						<p className="reading-status">Extracting article…</p>
					)}
					{state.status === "empty" && (
						<p className="reading-status">
							No readable article found on this page.
						</p>
					)}
					{state.status === "error" && (
						<p className="reading-status reading-error">
							Failed: {state.message}
						</p>
					)}
					{state.status === "ok" && (
						<>
							{state.article.title && <h1>{state.article.title}</h1>}
							{(state.article.byline || state.article.siteName) && (
								<p className="reading-meta">
									{state.article.byline}
									{state.article.byline && state.article.siteName ? " · " : ""}
									{state.article.siteName}
								</p>
							)}
							<div
								lang={state.article.lang ?? undefined}
								dir={state.article.dir ?? undefined}
								className="reading-content"
								// Readability strips script/iframe by design; content is still
								// rendered inside a sandboxed section separate from app chrome.
								// biome-ignore lint/security/noDangerouslySetInnerHtml: content is Readability-sanitized article HTML rendered inside an isolated reading frame.
								dangerouslySetInnerHTML={{
									__html: state.article.contentHtml ?? "",
								}}
							/>
						</>
					)}
				</article>
			</div>
		</div>
	);
}
