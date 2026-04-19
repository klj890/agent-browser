/**
 * Minimal SSE (`text/event-stream`) parser.
 *
 * The WHATWG spec is larger than we need; LLM providers use a consistent
 * subset:
 *   - UTF-8 text
 *   - events separated by blank lines (`\n\n`)
 *   - lines of the form `<field>: <value>` (optional leading colon = comment)
 *   - we care about `event:` and `data:` only; multiple `data:` lines in one
 *     event are concatenated with `\n`
 *
 * OpenRouter / DeepSeek / Qwen / Gemini all send single-line JSON per event;
 * Anthropic uses named events. This parser handles both.
 *
 * Returns an async iterable yielding `{ event?: string; data: string }`. The
 * terminator `data: [DONE]` is NOT filtered here — consumers check for it.
 */

export interface SseEvent {
	event?: string;
	data: string;
}

/**
 * Parse a `ReadableStream<Uint8Array>` body into SSE events.
 *
 * Exported separately so providers can share the same line-buffering state
 * machine and so it's unit-testable without a fetch call.
 */
export async function* parseSseStream(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncIterable<SseEvent> {
	const decoder = new TextDecoder("utf-8");
	const reader = body.getReader();
	let buffer = "";
	let currentEvent: string | undefined;
	let dataLines: string[] = [];

	const abortListener = () => {
		// Best-effort cancel; errors are swallowed because the consumer will
		// observe the abort via its own signal.
		reader.cancel().catch(() => {});
	};
	if (signal) {
		if (signal.aborted) abortListener();
		else signal.addEventListener("abort", abortListener);
	}

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value !== undefined) {
				buffer += decoder.decode(value, { stream: true });
			}

			// Split on any line terminator. SSE spec allows \n, \r, \r\n.
			// We normalize to \n first.
			buffer = buffer.replace(/\r\n?/g, "\n");

			let newlineIdx = buffer.indexOf("\n");
			while (newlineIdx >= 0) {
				const line = buffer.slice(0, newlineIdx);
				buffer = buffer.slice(newlineIdx + 1);
				newlineIdx = buffer.indexOf("\n");

				if (line === "") {
					// Blank line = dispatch event.
					if (dataLines.length > 0) {
						yield {
							event: currentEvent,
							data: dataLines.join("\n"),
						};
					}
					currentEvent = undefined;
					dataLines = [];
					continue;
				}

				if (line.startsWith(":")) {
					// Comment / keep-alive — skip.
					continue;
				}

				const colonIdx = line.indexOf(":");
				const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
				let fieldValue = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
				if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);

				if (field === "event") {
					currentEvent = fieldValue;
				} else if (field === "data") {
					dataLines.push(fieldValue);
				}
				// Other fields (id, retry) ignored.
			}
		}

		// Process any line still sitting in the buffer (no trailing newline).
		if (buffer.length > 0 && !buffer.startsWith(":")) {
			const colonIdx = buffer.indexOf(":");
			const field = colonIdx === -1 ? buffer : buffer.slice(0, colonIdx);
			let fieldValue = colonIdx === -1 ? "" : buffer.slice(colonIdx + 1);
			if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
			if (field === "event") currentEvent = fieldValue;
			else if (field === "data") dataLines.push(fieldValue);
		}

		// Flush any trailing event without a closing blank line.
		if (dataLines.length > 0) {
			yield { event: currentEvent, data: dataLines.join("\n") };
		}
	} finally {
		if (signal) signal.removeEventListener("abort", abortListener);
		reader.releaseLock();
	}
}

/**
 * Convenience: turn a plain string into a ReadableStream of bytes, for tests.
 */
export function stringToByteStream(s: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(s);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			// Split into small chunks to exercise the line buffer.
			const chunkSize = 32;
			for (let i = 0; i < bytes.length; i += chunkSize) {
				controller.enqueue(bytes.slice(i, i + chunkSize));
			}
			controller.close();
		},
	});
}
