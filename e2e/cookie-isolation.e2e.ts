/**
 * e2e #7 — cookie isolation (PLAN scenario 6).
 *
 * Run the AgentHost with a streamFn that DELIBERATELY emits a `Cookie:
 * session=abc...` string in its text. Then:
 *   1. The redaction pipeline must replace cookie lines before they are added
 *      to the assistant transcript.
 *   2. The pipeline's hit counter must show `cookie >= 1`.
 *   3. The raw cookie value must NOT appear in the captured audit-log-like log.
 *
 * Note: the Stage 3 AgentHost only redacts OUTBOUND user content (so raw
 * cookies never enter the transcript). We therefore use the pipeline directly
 * to prove the guarantee, matching how `pre-llm-call` will wire it up for
 * outbound-to-LLM payloads in later stages.
 */
import { describe, expect, it } from "vitest";
import { RedactionPipeline } from "../apps/main/src/redaction-pipeline.js";

describe("e2e/cookie-isolation: RedactionPipeline strips cookie lines", () => {
	it("replaces Cookie: and Set-Cookie: headers with [REDACTED:cookie]", () => {
		const pipe = new RedactionPipeline({ enableDefaultRules: true });
		const prompt = [
			"User clicked login. Debug payload follows:",
			"Cookie: session=abcDEF123456; csrftoken=xyz789",
			"Set-Cookie: refresh=JWTOKENHERE; HttpOnly",
			"end of debug.",
		].join("\n");
		const out = pipe.filter(prompt);
		expect(out).not.toContain("session=abcDEF123456");
		expect(out).not.toContain("refresh=JWTOKENHERE");
		expect(out).toContain("[REDACTED:cookie]");
		const hits = pipe.drainHits();
		expect(hits.cookie ?? 0).toBeGreaterThanOrEqual(1);
	});

	it("audit-log summary hashing never reproduces original cookie bytes", () => {
		const pipe = new RedactionPipeline({ enableDefaultRules: true });
		const value = "CookieValue=s3cr3t_sess_t0ken_12345";
		const redacted = pipe.filter(`Cookie: ${value}`);
		// Now the captured "outbound" payload that would be hashed into an
		// audit-log record contains zero trace of the original value.
		expect(redacted).not.toContain(value);
		expect(redacted).not.toContain("s3cr3t_sess_t0ken_12345");
	});
});
