/**
 * Pure i18n core (Stage 21) — no React, no DOM. Lives separately so unit
 * tests can exercise lookup + interpolation without spinning up jsdom.
 */
import { en, type MessageKey } from "./messages/en";
import { zh } from "./messages/zh";

export type Locale = "zh" | "en";

const DICTS: Record<Locale, Partial<Record<MessageKey, string>>> = {
	en,
	zh,
};

/**
 * Replace `{name}` placeholders. Unknown variables are kept verbatim so a
 * missing context value surfaces as a visible bug rather than silently
 * collapsing into an empty string.
 *
 * The `\w+` matcher is intentionally strict: every catalog key uses flat
 * identifier-style variable names (`name`, `count`, `time`). A broader
 * `[^}]+` would accidentally swallow user-supplied content that contains a
 * runaway `{` — e.g. `t("foo", { content: "{ raw text }" })` — instead of
 * passing it through. We can lift the restriction the day we actually need
 * dotted paths (none today; YAGNI).
 */
export function format(
	template: string,
	vars?: Record<string, string | number>,
): string {
	if (!vars) return template;
	return template.replace(/\{(\w+)\}/g, (m, key) => {
		if (Object.hasOwn(vars, key)) return String(vars[key]);
		return m;
	});
}

export function translate(
	locale: Locale,
	key: MessageKey,
	vars?: Record<string, string | number>,
): string {
	const primary = DICTS[locale]?.[key];
	if (typeof primary === "string") return format(primary, vars);
	// English is the schema-of-truth; if `key` is mistyped it'll surface
	// here as an undefined access, caught by TypeScript at the call site.
	return format(en[key], vars);
}

export type { MessageKey };
