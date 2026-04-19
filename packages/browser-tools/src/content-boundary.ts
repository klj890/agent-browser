import { nanoid } from "nanoid";

export function wrapUntrusted(
	body: string,
	meta: { url?: string; title?: string } = {},
): { text: string; boundary: string } {
	const boundary = nanoid(24);
	const header = [
		meta.url ? `url: ${meta.url}` : null,
		meta.title ? `title: ${meta.title}` : null,
	]
		.filter(Boolean)
		.join("\n");
	const text = `<untrusted_page_content boundary="${boundary}">\n${header}${header ? "\n---\n" : ""}${body}\n</untrusted_page_content>`;
	return { text, boundary };
}
