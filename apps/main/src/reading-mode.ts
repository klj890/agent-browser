/**
 * Reading mode extraction (P1-13).
 *
 * Strategy: inject Mozilla's Readability.js into the tab's own document via
 * `webContents.executeJavaScript` and run it against a clone of the live DOM.
 * This avoids the ~5MB jsdom dependency and keeps extraction accurate
 * (CSS / computed styles / lazy-loaded content all reflect what the user
 * actually sees).
 *
 * Security notes:
 *  - `executeJavaScript` runs in the tab's main world. We treat the returned
 *    article as untrusted — renderer MUST render `contentHtml` with
 *    `dangerouslySetInnerHTML` inside a sandbox container, not execute it.
 *  - Readability strips scripts by design; we add an additional sanity check
 *    that the returned object has no `__error` and matches the expected shape.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export interface ReadingArticle {
	title: string | null;
	byline: string | null;
	siteName: string | null;
	excerpt: string | null;
	contentHtml: string | null;
	textContent: string | null;
	length: number | null;
	lang: string | null;
	dir: string | null;
}

export interface WebContentsRunner {
	executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

let cachedScript: string | null = null;

function defaultLoadScript(): string {
	if (cachedScript) return cachedScript;
	// createRequire lets us resolve CJS package files from an ESM context.
	const req = createRequire(import.meta.url);
	const entry = req.resolve("@mozilla/readability/Readability.js");
	cachedScript = readFileSync(entry, "utf-8");
	return cachedScript;
}

/**
 * Reset the cached Readability script — test-only hook so spec files can
 * inject a stub script via `__setScriptForTests`.
 */
export function __resetReadingModeForTests(): void {
	cachedScript = null;
}

export function __setScriptForTests(src: string | null): void {
	cachedScript = src;
}

export interface ExtractOptions {
	loadScript?: () => string;
	/** Max milliseconds to wait before rejecting. Default 8s. */
	timeoutMs?: number;
}

export class ReadingExtractionError extends Error {
	constructor(
		message: string,
		override readonly cause?: unknown,
	) {
		super(message);
		this.name = "ReadingExtractionError";
	}
}

/**
 * Run Readability inside the tab and return the parsed article.
 * Returns `null` when Readability could not identify the main content
 * (e.g. a chrome page, an app-shell SPA without article semantics).
 */
export async function extractArticle(
	runner: WebContentsRunner,
	opts: ExtractOptions = {},
): Promise<ReadingArticle | null> {
	const script = (opts.loadScript ?? defaultLoadScript)();
	const timeout = opts.timeoutMs ?? 8_000;
	const payload = `
		(function() {
			try {
				${script}
				var docClone = document.cloneNode(true);
				var reader = new Readability(docClone);
				var article = reader.parse();
				if (!article) return null;
				return {
					title: article.title ?? null,
					byline: article.byline ?? null,
					siteName: article.siteName ?? null,
					excerpt: article.excerpt ?? null,
					contentHtml: article.content ?? null,
					textContent: article.textContent ?? null,
					length: article.length ?? null,
					lang: article.lang ?? null,
					dir: article.dir ?? null,
				};
			} catch (e) {
				return { __error: String((e && e.message) || e) };
			}
		})();
	`;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const raced = await Promise.race([
		runner.executeJavaScript(payload, false),
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new ReadingExtractionError(
							`reading extraction timed out after ${timeout}ms`,
						),
					),
				timeout,
			);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
	if (raced == null) return null;
	if (typeof raced !== "object") {
		throw new ReadingExtractionError(
			`unexpected readability return type: ${typeof raced}`,
		);
	}
	const obj = raced as Record<string, unknown>;
	if ("__error" in obj) {
		throw new ReadingExtractionError(
			`readability threw in tab: ${String(obj.__error)}`,
		);
	}
	return normalize(obj);
}

function normalize(raw: Record<string, unknown>): ReadingArticle {
	const pickStr = (k: string): string | null => {
		const v = raw[k];
		return typeof v === "string" ? v : null;
	};
	const pickNum = (k: string): number | null => {
		const v = raw[k];
		return typeof v === "number" && Number.isFinite(v) ? v : null;
	};
	return {
		title: pickStr("title"),
		byline: pickStr("byline"),
		siteName: pickStr("siteName"),
		excerpt: pickStr("excerpt"),
		contentHtml: pickStr("contentHtml"),
		textContent: pickStr("textContent"),
		length: pickNum("length"),
		lang: pickStr("lang"),
		dir: pickStr("dir"),
	};
}
