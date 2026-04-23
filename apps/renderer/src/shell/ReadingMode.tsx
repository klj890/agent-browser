import DOMPurify from "dompurify";
import { useEffect, useMemo, useState } from "react";
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

/**
 * Defense-in-depth: Readability strips scripts by design, but we treat its
 * output as untrusted and run it through DOMPurify with a tight allowlist
 * before injecting into the DOM. Anything the user could want out of a
 * reading view (paragraphs, headings, lists, images, code, quotes, links)
 * passes; active content and custom protocols are dropped.
 */
const SANITIZE_CONFIG: DOMPurify.Config = {
	ALLOWED_TAGS: [
		"a",
		"p",
		"br",
		"span",
		"div",
		"section",
		"article",
		"header",
		"footer",
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"strong",
		"em",
		"b",
		"i",
		"u",
		"small",
		"sub",
		"sup",
		"mark",
		"ul",
		"ol",
		"li",
		"dl",
		"dt",
		"dd",
		"blockquote",
		"cite",
		"q",
		"pre",
		"code",
		"kbd",
		"samp",
		"figure",
		"figcaption",
		"img",
		"picture",
		"source",
		"table",
		"thead",
		"tbody",
		"tfoot",
		"tr",
		"th",
		"td",
		"caption",
		"hr",
		"time",
		"abbr",
		"address",
	],
	ALLOWED_ATTR: [
		"href",
		"src",
		"srcset",
		"alt",
		"title",
		"lang",
		"dir",
		"cite",
		"datetime",
		"width",
		"height",
	],
	ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/(?:png|jpeg|gif|webp))/i,
	ALLOW_DATA_ATTR: false,
	FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
	FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
};

function sanitize(html: string): string {
	return DOMPurify.sanitize(html, SANITIZE_CONFIG) as unknown as string;
}

export function ReadingMode({ tabId, onClose }: Props) {
	const [state, setState] = useState<LoadState>({ status: "loading" });
	const sanitizedHtml = useMemo(() => {
		if (state.status !== "ok" || !state.article.contentHtml) return "";
		return sanitize(state.article.contentHtml);
	}, [state]);

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
								// Content has passed through Readability's transform AND
								// DOMPurify with a tight tag/attr allowlist (see
								// SANITIZE_CONFIG). Any script / event handler / unsupported
								// protocol has been stripped before reaching this sink.
								// biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify-sanitized article HTML rendered inside an isolated reading frame.
								dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
							/>
						</>
					)}
				</article>
			</div>
		</div>
	);
}
