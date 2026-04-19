/**
 * Minimal markdown → HTML subset used by Sidebar message rendering.
 *
 * Intentional scope:
 *   - **bold**, *italic*, backtick-code (`x`) inline.
 *   - Fenced code block: ```lang\n...\n```
 *   - Line breaks preserved as <br/> in non-code content.
 *   - Leading #/## headings → <h3>/<h4>.
 *
 * Anything else (lists, tables, links) renders as plain text. This keeps the
 * implementation small and dependency-free; swap for markdown-it later if
 * Sidebar becomes a primary surface.
 */

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function renderInline(text: string): string {
	let out = escapeHtml(text);
	// Inline code first to protect its contents.
	out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
		return `<code>${code}</code>`;
	});
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
	return out;
}

export function renderMarkdown(src: string): string {
	const parts: string[] = [];
	const lines = src.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const fenceMatch = /^```(\w*)\s*$/.exec(line);
		if (fenceMatch) {
			i++;
			const codeLines: string[] = [];
			while (i < lines.length) {
				const next = lines[i] ?? "";
				if (/^```\s*$/.test(next)) {
					i++;
					break;
				}
				codeLines.push(next);
				i++;
			}
			parts.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
			continue;
		}
		if (line.startsWith("## ")) {
			parts.push(`<h4>${renderInline(line.slice(3))}</h4>`);
			i++;
			continue;
		}
		if (line.startsWith("# ")) {
			parts.push(`<h3>${renderInline(line.slice(2))}</h3>`);
			i++;
			continue;
		}
		// Group consecutive non-empty text lines into a paragraph.
		if (line.trim() === "") {
			i++;
			continue;
		}
		const paraLines: string[] = [line];
		i++;
		while (i < lines.length) {
			const next = lines[i] ?? "";
			if (next.trim() === "") break;
			if (
				next.startsWith("```") ||
				next.startsWith("# ") ||
				next.startsWith("## ")
			)
				break;
			paraLines.push(next);
			i++;
		}
		parts.push(`<p>${paraLines.map(renderInline).join("<br/>")}</p>`);
	}
	return parts.join("\n");
}
