import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Default vitest discovers every `*.test.ts`. We keep scripts/__tests__
		// out of the main `pnpm test` run so it stays tightly scoped to the
		// app + package tests (254 as of Stage 6). Run those verify-helper
		// tests via `pnpm test:scripts` instead.
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/out/**",
			".claude/**",
			"scripts/**",
			"e2e/**",
		],
	},
});
