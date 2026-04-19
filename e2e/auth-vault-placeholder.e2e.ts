/**
 * e2e #9 — Auth Vault isolation (PLAN scenario 8).
 *
 * Auth Vault is P1-9. Until the vault module lands we park a placeholder
 * test so the suite's index is stable. Flip `test.skip` to `test` once
 * `apps/main/src/auth-vault.ts` exists.
 */
import { describe, it } from "vitest";

describe("e2e/auth-vault-placeholder: vault substitution — DEFERRED (P1-9)", () => {
	it.skip("keeps cleartext secrets out of LLM audit log", () => {
		// TODO(P1-9): create vault, put `github_password: 's3cr3t'`,
		// call act({action:'fill', value:'{{vault:github_password}}'}),
		// assert `Input.insertText` saw 's3cr3t' and audit log saw only
		// the placeholder string.
	});
});
