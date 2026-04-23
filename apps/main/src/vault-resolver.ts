/**
 * Vault placeholder resolver (P1 Stage 9).
 *
 * Expands `{{vault:<key>}}` occurrences in strings by looking up the key
 * in an AuthVault. Unknown keys throw so callers fail loudly rather than
 * silently leaking an unresolved placeholder into a browser tool call.
 *
 * This is invoked during the `pre-tool-call` hook in agent-host; only
 * string-typed args are passed through.
 */

export interface VaultLookup {
	get(key: string): Promise<string | undefined>;
}

/** Matches `{{vault:<key>}}` where key may contain letters, digits, `_`, `-`, `.`. */
const PLACEHOLDER_RE = /\{\{vault:([\w.-]+)\}\}/g;

/**
 * Replace every `{{vault:<key>}}` in `input` with the vault's stored secret.
 * Throws on unknown keys.
 */
export async function resolveTemplate(
	input: string,
	vault: VaultLookup,
): Promise<string> {
	if (typeof input !== "string") return input;
	if (!PLACEHOLDER_RE.test(input)) return input;
	PLACEHOLDER_RE.lastIndex = 0;

	const matches = [...input.matchAll(PLACEHOLDER_RE)];
	const keys = new Set<string>(
		matches.map((m) => m[1]).filter((k): k is string => typeof k === "string"),
	);
	const values = new Map<string, string>();
	for (const key of keys) {
		const v = await vault.get(key);
		if (v === undefined) {
			throw new Error(`vault: unknown key "${key}"`);
		}
		values.set(key, v);
	}
	return input.replace(PLACEHOLDER_RE, (_full, key: string) => {
		const v = values.get(key);
		// Guarded above, but narrow for TS.
		if (v === undefined) throw new Error(`vault: unknown key "${key}"`);
		return v;
	});
}

/**
 * Walk a shallow tool-call args record and resolve placeholders inside
 * string values. Non-string values are passed through untouched.
 * Nested objects/arrays are traversed recursively.
 */
export async function resolveArgs(
	args: Record<string, unknown>,
	vault: VaultLookup,
): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args)) {
		out[k] = await resolveValue(v, vault);
	}
	return out;
}

async function resolveValue(v: unknown, vault: VaultLookup): Promise<unknown> {
	if (typeof v === "string") return resolveTemplate(v, vault);
	if (Array.isArray(v)) {
		const out: unknown[] = [];
		for (const el of v) out.push(await resolveValue(el, vault));
		return out;
	}
	if (v && typeof v === "object") {
		return resolveArgs(v as Record<string, unknown>, vault);
	}
	return v;
}
