/**
 * RedactionPipeline (Stage 6.1–6.2)
 *
 * Filters outbound LLM payloads and embedding inputs through a pipeline of
 * detectors (cookies, JWTs, API keys, national IDs, credit cards, etc.).
 *
 * Implementation notes (per PLAN.md 附录 F):
 *   - Normalization (NFKC + zero-width strip + homoglyph fold) is applied to
 *     produce a *detection* string. Detection runs on the normalized string to
 *     defeat Unicode homoglyph attacks (I3); however the final redacted output
 *     is spliced from the ORIGINAL string so non-sensitive characters are
 *     preserved byte-for-byte. This is achieved via an offset map that
 *     remembers the originating index range for every normalized character.
 *   - R7 (email) is OFF by default and must be explicitly enabled via policy.
 *   - R6 (credit card) runs a Luhn post-check to suppress false positives from
 *     order numbers / timestamps.
 *
 * TODO(Stage 3): replace the local `SensitiveWordFilter` interface below with
 * an import from `@cogni-refract/core` once the upstream contract is finalised.
 *
 * TODO(Stage 5): once `apps/main/src/admin-policy.ts` lands, replace the local
 * `RedactionPolicy` shape below with `AdminPolicy['redaction']` from that
 * module. Kept as a structural placeholder to avoid coupling.
 */

// ---------------------------------------------------------------------------
// Local placeholder types (see TODOs above)
// ---------------------------------------------------------------------------

/**
 * Local stand-in for CogniRefract's `SensitiveWordFilter` contract.
 * Stage 3 will swap this for `import type { SensitiveWordFilter } from '@cogni-refract/core'`.
 */
export interface SensitiveWordFilter {
	filter(input: string): string;
}

/** Structural subset of `AdminPolicy['redaction']` (Stage 5 will formalise). */
export interface RedactionPolicy {
	enableDefaultRules?: boolean;
	enableEmailRule?: boolean;
	customPatterns?: Array<{ name: string; pattern: string; flags?: string }>;
}

// ---------------------------------------------------------------------------
// Detector shape
// ---------------------------------------------------------------------------

export interface Detector {
	name: string;
	regex: RegExp;
	replace: string | ((match: string) => string);
	/** Optional validator; if present and returns false, the match is skipped. */
	postCheck?: (match: string) => boolean;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// Cyrillic & Greek letters that visually collide with ASCII.
const HOMOGLYPH_MAP: Record<string, string> = {
	// Cyrillic lowercase
	а: "a",
	е: "e",
	о: "o",
	р: "p",
	с: "c",
	х: "x",
	у: "y",
	і: "i",
	ј: "j",
	ѕ: "s",
	// Cyrillic uppercase
	А: "A",
	В: "B",
	Е: "E",
	К: "K",
	М: "M",
	Н: "H",
	О: "O",
	Р: "P",
	С: "C",
	Т: "T",
	Х: "X",
	У: "Y",
	// Greek uppercase
	Α: "A",
	Β: "B",
	Ε: "E",
	Ζ: "Z",
	Η: "H",
	Ι: "I",
	Κ: "K",
	Μ: "M",
	Ν: "N",
	Ο: "O",
	Ρ: "P",
	Τ: "T",
	Υ: "Y",
	Χ: "X",
};

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u2060]/g;

/**
 * Public normalize — NFKC + zero-width strip + homoglyph fold.
 * Exposed for tests; Pipeline itself uses {@link normalizeWithMap}.
 */
export function normalize(input: string): string {
	let s = input.normalize("NFKC");
	s = s.replace(ZERO_WIDTH_RE, "");
	let out = "";
	for (const ch of s) {
		out += HOMOGLYPH_MAP[ch] ?? ch;
	}
	return out;
}

/**
 * Normalize and build an index map so matches found in the normalized string
 * can be projected back onto the original.
 *
 * `map[i]` is the start index in ORIGINAL corresponding to normalized index `i`.
 * `map[normalized.length]` is the end sentinel (= original.length) so a match
 * spanning `[start, end)` in normalized projects to `[map[start], map[end])`
 * in the original.
 */
function normalizeWithMap(input: string): {
	normalized: string;
	map: number[];
} {
	// Step 1: NFKC — may change code-unit length. Walk char-by-char using the
	// JS string iterator (code-point aware) so multi-unit emoji etc. are safe.
	// Then apply zero-width strip and homoglyph fold while tracking offsets.
	let normalized = "";
	const map: number[] = [];

	// We iterate code points of `input`, NFKC-normalize each cluster, then
	// within the NFKC result apply the other two transforms. For simplicity
	// (and because NFKC on a single code point is well-defined for the
	// glyphs we care about), we normalize the whole string once and rebuild
	// an offset map by re-running NFKC per original code point.
	let origIndex = 0;
	for (const ch of input) {
		const nfkc = ch.normalize("NFKC");
		for (const nch of nfkc) {
			// Drop zero-width chars.
			if (/[\u200B-\u200D\uFEFF\u2060]/.test(nch)) continue;
			const folded = HOMOGLYPH_MAP[nch] ?? nch;
			for (const fch of folded) {
				normalized += fch;
				map.push(origIndex);
			}
		}
		origIndex += ch.length;
	}
	map.push(origIndex); // end sentinel
	return { normalized, map };
}

// ---------------------------------------------------------------------------
// Luhn check (no external deps)
// ---------------------------------------------------------------------------

function luhnValid(raw: string): boolean {
	const digits = raw.replace(/[^0-9]/g, "");
	if (digits.length < 13 || digits.length > 19) return false;
	let sum = 0;
	let alt = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		const d = digits.charCodeAt(i) - 48;
		if (d < 0 || d > 9) return false;
		let v = d;
		if (alt) {
			v *= 2;
			if (v > 9) v -= 9;
		}
		sum += v;
		alt = !alt;
	}
	return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// Default detectors (R1–R10, per PLAN.md 附录 F)
// ---------------------------------------------------------------------------

const R1_COOKIE: Detector = {
	name: "cookie",
	// Start-of-line (multiline flag) OR preceded by whitespace. The header
	// keyword, optional spaces, colon, then value up to end of line.
	// Capture group 1 is the leading whitespace (if any) so we can keep it.
	regex: /(?:^|([\t ]))(?:Cookie|Set-Cookie)[\t ]*:[^\r\n]+/gim,
	replace: (m) => {
		// Preserve a leading space/tab if present; otherwise start-of-line.
		const lead = /^[\t ]/.test(m) ? m[0] : "";
		return `${lead}[REDACTED:cookie]`;
	},
};

const R2_JWT: Detector = {
	name: "jwt",
	regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
	replace: "[REDACTED:jwt]",
};

const R3_BEARER: Detector = {
	name: "bearer",
	regex: /\bBearer[\t ]+[A-Za-z0-9._~+/-]{20,}=*/g,
	replace: "Bearer [REDACTED]",
};

const R4_APIKEY: Detector = {
	name: "apikey",
	// sk/pk/rk/api[_-]?key, separator [_-], then ≥16 alphanumerics.
	regex: /\b(?:sk|pk|rk|api[_-]?key)[_-][A-Za-z0-9]{16,}\b/gi,
	replace: "[REDACTED:apikey]",
};

const R5_CHINA_ID: Detector = {
	name: "id",
	regex:
		/\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
	replace: "[REDACTED:id]",
};

const R6_CREDIT_CARD: Detector = {
	name: "card",
	// 13–19 digits, optionally separated by spaces/hyphens. Non-greedy to
	// avoid catastrophic backtracking; fixed-length alternation.
	regex: /\b(?:\d[ -]?){12,18}\d\b/g,
	replace: "[REDACTED:card]",
	postCheck: (m) => luhnValid(m),
};

const R7_EMAIL: Detector = {
	name: "email",
	regex: /\b[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+\b/g,
	replace: "[REDACTED:email]",
};

const R8_PHONE_CN: Detector = {
	name: "phone",
	regex: /\b1[3-9]\d{9}\b/g,
	replace: "[REDACTED:phone]",
};

const R9_SSH_PRIVKEY: Detector = {
	name: "privkey",
	regex:
		/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g,
	replace: "[REDACTED:privkey]",
};

const R10_AWS_ACCESS_KEY: Detector = {
	name: "aws",
	regex: /\bAKIA[0-9A-Z]{16}\b/g,
	replace: "[REDACTED:aws]",
};

/**
 * Default detector set (R1–R10). Note R7 (email) is included here but the
 * Pipeline drops it from the active set unless `enableEmailRule: true`.
 */
export const DEFAULT_DETECTORS: Detector[] = [
	R1_COOKIE,
	R2_JWT,
	R3_BEARER,
	R4_APIKEY,
	R5_CHINA_ID,
	R6_CREDIT_CARD,
	R7_EMAIL,
	R8_PHONE_CN,
	R9_SSH_PRIVKEY,
	R10_AWS_ACCESS_KEY,
];

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

interface FoundMatch {
	detectorName: string;
	start: number; // in ORIGINAL string
	end: number; // in ORIGINAL string (exclusive)
	replacement: string;
}

export class RedactionPipeline implements SensitiveWordFilter {
	private readonly detectors: Detector[];
	private readonly hits: Map<string, number> = new Map();

	constructor(policy: RedactionPolicy = {}) {
		const enableDefaults = policy.enableDefaultRules ?? true;
		const enableEmail = policy.enableEmailRule ?? false;
		const base = enableDefaults ? DEFAULT_DETECTORS : [];
		this.detectors = base.filter((d) => d.name !== "email" || enableEmail);
		for (const c of policy.customPatterns ?? []) {
			this.detectors.push({
				name: c.name,
				regex: new RegExp(c.pattern, withGlobalFlag(c.flags ?? "g")),
				replace: `[REDACTED:${c.name}]`,
			});
		}
	}

	filter(input: string): string {
		if (input.length === 0) return input;

		const { normalized, map } = normalizeWithMap(input);

		// 1. Collect all candidate matches across all detectors using the
		//    normalized string for detection (beats homoglyph / zero-width
		//    attacks). Project positions back onto the original via `map`.
		const found: FoundMatch[] = [];
		for (const d of this.detectors) {
			const regex = cloneRegex(d.regex);
			let m: RegExpExecArray | null;
			// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
			while ((m = regex.exec(normalized)) !== null) {
				const start = m.index;
				const end = m.index + m[0].length;
				if (end === start) {
					// Guard against zero-width matches (empty regex bugs).
					regex.lastIndex = end + 1;
					continue;
				}
				if (d.postCheck && !d.postCheck(m[0])) continue;
				const origStart = map[start];
				const origEnd = map[end];
				if (origStart === undefined || origEnd === undefined) continue;
				const replacement =
					typeof d.replace === "function" ? d.replace(m[0]) : d.replace;
				found.push({
					detectorName: d.name,
					start: origStart,
					end: origEnd,
					replacement,
				});
			}
		}

		if (found.length === 0) return input;

		// 2. Resolve overlaps: sort by start asc, then by longer span first,
		//    then iterate and drop any match whose range overlaps an
		//    already-kept match. Guarantees detector ORDER doesn't affect the
		//    final output — only positions do.
		found.sort((a, b) => {
			if (a.start !== b.start) return a.start - b.start;
			return b.end - a.end; // longer first
		});
		const kept: FoundMatch[] = [];
		let cursor = -1;
		for (const f of found) {
			if (f.start < cursor) continue; // overlaps a prior match
			kept.push(f);
			cursor = f.end;
		}

		// 3. Splice the original string.
		let out = "";
		let i = 0;
		for (const f of kept) {
			if (f.start > i) out += input.slice(i, f.start);
			out += f.replacement;
			i = f.end;
			this.hits.set(f.detectorName, (this.hits.get(f.detectorName) ?? 0) + 1);
		}
		if (i < input.length) out += input.slice(i);
		return out;
	}

	/** Return and clear the hit counter map. */
	drainHits(): Record<string, number> {
		const result: Record<string, number> = {};
		for (const [k, v] of this.hits) result[k] = v;
		this.hits.clear();
		return result;
	}
}

function cloneRegex(re: RegExp): RegExp {
	const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
	return new RegExp(re.source, flags);
}

function withGlobalFlag(flags: string): string {
	return flags.includes("g") ? flags : `${flags}g`;
}

// ---------------------------------------------------------------------------
// Policy integration helper
// ---------------------------------------------------------------------------

/**
 * Build a pipeline from an AdminPolicy-shaped object. Tolerant of missing
 * `redaction` key (returns a pipeline with defaults).
 */
export function createRedactionPipelineFromPolicy(policy: {
	redaction?: RedactionPolicy;
}): RedactionPipeline {
	return new RedactionPipeline(policy.redaction ?? {});
}
