/**
 * Minimal `{{var}}` template renderer used by agent-host for system prompt.
 *
 * Intentional limitations (per Stage 3 scope):
 *   - Only `{{name}}` placeholders, no conditionals / loops / filters.
 *   - Missing variables are left as-is (`{{missing}}` stays literal). This is
 *     safer than throwing — a misrendered prompt is still shippable.
 *   - Whitespace inside the braces is tolerated: `{{ persona_name }}` works.
 */
import { readFile } from "node:fs/promises";

export type TemplateVars = Record<string, string | number | boolean>;

/**
 * Render a literal template string. Exposed separately so tests can pump
 * strings in without touching the filesystem.
 */
export function renderTemplateString(tpl: string, vars: TemplateVars): string {
	return tpl.replace(
		/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g,
		(match, key: string) => {
			if (!(key in vars)) return match;
			const v = vars[key];
			return v === undefined || v === null ? match : String(v);
		},
	);
}

export async function renderTemplate(
	path: string,
	vars: TemplateVars,
): Promise<string> {
	const tpl = await readFile(path, "utf8");
	return renderTemplateString(tpl, vars);
}
