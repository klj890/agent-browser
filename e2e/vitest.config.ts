import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/**
 * e2e vitest config (Stage 8.2).
 *
 * Separate from the repo-wide `pnpm test` vitest run so e2e can:
 *   - run longer timeouts
 *   - only pick up files under e2e/
 *   - keep the flat `vitest run` fast for inner-loop
 */
export default defineConfig({
	test: {
		include: [path.join(here, "**/*.e2e.ts")],
		testTimeout: 30_000,
		hookTimeout: 30_000,
		pool: "threads",
	},
	resolve: {
		alias: {
			"@agent-browser/browser-tools": path.join(
				root,
				"packages/browser-tools/src/index.ts",
			),
		},
	},
});
