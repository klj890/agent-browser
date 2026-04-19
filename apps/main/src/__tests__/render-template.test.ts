import { describe, expect, it } from "vitest";
import { renderTemplateString } from "../prompts/render.js";

describe("renderTemplateString", () => {
	it("substitutes placeholders", () => {
		const out = renderTemplateString("Hello {{name}}, you are {{role}}.", {
			name: "Ada",
			role: "admin",
		});
		expect(out).toBe("Hello Ada, you are admin.");
	});

	it("leaves unknown placeholders literal", () => {
		const out = renderTemplateString("{{a}} {{b}}", { a: "1" });
		expect(out).toBe("1 {{b}}");
	});

	it("tolerates whitespace inside braces and coerces non-string vars", () => {
		const out = renderTemplateString("{{ count }} / {{ ok }}", {
			count: 42,
			ok: true,
		});
		expect(out).toBe("42 / true");
	});
});
