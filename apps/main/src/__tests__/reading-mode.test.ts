/**
 * ReadingMode extract unit tests (P1-13). Uses an injected `loadScript` stub
 * so tests don't need the real Readability bundle or a DOM.
 */
import { describe, expect, it, vi } from "vitest";
import {
	extractArticle,
	ReadingExtractionError,
	type WebContentsRunner,
} from "../reading-mode.js";

const fakeScript = "/* no-op */";

function makeRunner(result: unknown): WebContentsRunner {
	return {
		executeJavaScript: vi.fn(async () => result),
	};
}

describe("extractArticle", () => {
	it("returns normalized article on success", async () => {
		const runner = makeRunner({
			title: "Hello",
			byline: "Alice",
			siteName: "Site",
			excerpt: "ex",
			contentHtml: "<p>hi</p>",
			textContent: "hi",
			length: 2,
			lang: "en",
			dir: "ltr",
		});
		const out = await extractArticle(runner, { loadScript: () => fakeScript });
		expect(out?.title).toBe("Hello");
		expect(out?.contentHtml).toBe("<p>hi</p>");
		expect(out?.length).toBe(2);
	});

	it("returns null when Readability produced no article", async () => {
		const runner = makeRunner(null);
		const out = await extractArticle(runner, { loadScript: () => fakeScript });
		expect(out).toBeNull();
	});

	it("throws ReadingExtractionError when the tab reports an error", async () => {
		const runner = makeRunner({ __error: "boom" });
		await expect(
			extractArticle(runner, { loadScript: () => fakeScript }),
		).rejects.toBeInstanceOf(ReadingExtractionError);
	});

	it("coerces unexpected field types to null", async () => {
		const runner = makeRunner({
			title: 42,
			contentHtml: "<p>x</p>",
			length: "nope",
		});
		const out = await extractArticle(runner, { loadScript: () => fakeScript });
		expect(out?.title).toBeNull();
		expect(out?.contentHtml).toBe("<p>x</p>");
		expect(out?.length).toBeNull();
	});

	it("rejects with a timeout when the runner hangs", async () => {
		const runner: WebContentsRunner = {
			executeJavaScript: () => new Promise(() => {}),
		};
		await expect(
			extractArticle(runner, { loadScript: () => fakeScript, timeoutMs: 30 }),
		).rejects.toBeInstanceOf(ReadingExtractionError);
	});

	it("throws on non-object return types", async () => {
		const runner = makeRunner("some string");
		await expect(
			extractArticle(runner, { loadScript: () => fakeScript }),
		).rejects.toBeInstanceOf(ReadingExtractionError);
	});
});
