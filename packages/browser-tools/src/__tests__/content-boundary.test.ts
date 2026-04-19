import { describe, expect, it } from "vitest";
import { wrapUntrusted } from "../content-boundary.js";

describe("wrapUntrusted", () => {
	it("generates unique boundary tokens across many calls", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const { boundary } = wrapUntrusted("body");
			expect(seen.has(boundary)).toBe(false);
			seen.add(boundary);
		}
		expect(seen.size).toBe(100);
	});

	it("wraps body with meta header", () => {
		const { text } = wrapUntrusted("hello", {
			url: "https://e.com",
			title: "T",
		});
		expect(text).toContain('<untrusted_page_content boundary="');
		expect(text).toContain("url: https://e.com");
		expect(text).toContain("title: T");
		expect(text).toContain("hello");
		expect(text).toContain("</untrusted_page_content>");
	});
});
