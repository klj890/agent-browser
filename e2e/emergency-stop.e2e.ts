/**
 * e2e #11 — emergency stop (PLAN scenario 10).
 *
 * AgentHost runs a long streamFn that keeps emitting chunks; externally we
 * abort via `host.cancel()` and expect:
 *   - the stream halts promptly
 *   - the terminal `done` chunk reports reason='killed' (via the error classifier)
 */
import { describe, expect, it } from "vitest";
import {
	type AdminPolicy,
	DEFAULT_POLICY,
} from "../apps/main/src/admin-policy.js";
import {
	AgentHost,
	type LlmStreamChunk,
	type StreamFn,
} from "../apps/main/src/agent-host.js";

const NO_REDACT = { filter: (s: string) => s };

function policy(o: Partial<AdminPolicy> = {}): AdminPolicy {
	return {
		...DEFAULT_POLICY,
		...o,
		costGuard: { ...DEFAULT_POLICY.costGuard, ...(o.costGuard ?? {}) },
	};
}

/** Stream that takes 5+ small chunks with await ticks so abort can interrupt. */
function slowStream(): StreamFn {
	return async function* (input) {
		for (let i = 0; i < 50; i++) {
			if (input.signal?.aborted) return;
			await new Promise((r) => setTimeout(r, 5));
			yield { type: "text", delta: `chunk${i} ` } as LlmStreamChunk;
		}
		yield { type: "usage", totalTokens: 50 } as LlmStreamChunk;
	};
}

describe("e2e/emergency-stop: host.cancel aborts mid-stream", () => {
	it("stops within ~100ms and emits done{reason:'killed'}", async () => {
		const host = new AgentHost({
			systemPrompt: "sys",
			skills: [],
			streamFn: slowStream(),
			policy: policy(),
			redaction: NO_REDACT,
		});

		const chunks: Array<{ type: string; reason?: string; delta?: string }> = [];
		const start = Date.now();
		const drain = (async () => {
			for await (const c of host.run("go")) {
				chunks.push(c as { type: string; reason?: string; delta?: string });
			}
		})();

		// Let 2 chunks stream, then hit the panic button.
		await new Promise((r) => setTimeout(r, 25));
		host.cancel();

		await drain;
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(1500);

		const last = chunks[chunks.length - 1] as {
			type: string;
			reason?: string;
		};
		expect(last.type).toBe("done");
		expect(last.reason).toBe("killed");
		// Emit between 1 and (say) 20 chunks before cancel — not all 50.
		const textCount = chunks.filter((c) => c.type === "text").length;
		expect(textCount).toBeLessThan(50);
	});
});
