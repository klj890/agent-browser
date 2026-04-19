/**
 * e2e #12 — data export + clear (PLAN scenario 11).
 *
 * Export/clear bundles history + audit + personas into a zip + wipes the
 * SQLite tables. That flow ships with the settings UI (P1). This test is a
 * placeholder so the acceptance index stays stable; flip the skip once
 * `apps/main/src/data-export.ts` lands.
 */
import { describe, it } from "vitest";

describe("e2e/data-export-clear: export & clear — DEFERRED (P1 settings)", () => {
	it.skip("exports history/audit/personas as zip and clears SQLite", () => {
		// TODO(P1): wire once apps/main/src/data-export.ts exists.
	});
});
