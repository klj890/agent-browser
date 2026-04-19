import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../admin-policy.js";
import {
	AgentHost,
	type LlmStreamChunk,
	type StreamFn,
} from "../agent-host.js";
import type { SensitiveWordFilter } from "../redaction-pipeline.js";

const NO_REDACT: SensitiveWordFilter = { filter: (s) => s };

function textStream(s: string): StreamFn {
	return async function* () {
		yield { type: "text", delta: s } as LlmStreamChunk;
		yield { type: "usage", totalTokens: 1 } as LlmStreamChunk;
	};
}

describe("AgentHost.switchPersona", () => {
	it("replaces system prompt for subsequent turns", async () => {
		const host = new AgentHost({
			systemPrompt: "original",
			skills: [],
			streamFn: textStream("ok"),
			policy: DEFAULT_POLICY,
			redaction: NO_REDACT,
		});
		host.switchPersona({
			slug: "new-persona",
			name: "New",
			contentMd: "NEW SYSTEM PROMPT",
		});
		expect(host.getPersonaSlug()).toBe("new-persona");
		// consume a run to ensure no throw and messages are intact
		const iter = host.run("hi");
		for await (const _ of iter) void _;
	});

	it("is idempotent on repeated switch to same slug", () => {
		const host = new AgentHost({
			systemPrompt: "a",
			skills: [],
			streamFn: textStream(""),
			policy: DEFAULT_POLICY,
			redaction: NO_REDACT,
		});
		host.switchPersona({ slug: "x", contentMd: "one" });
		host.switchPersona({ slug: "x", contentMd: "two" }); // ignored
		expect(host.getPersonaSlug()).toBe("x");
	});
});
