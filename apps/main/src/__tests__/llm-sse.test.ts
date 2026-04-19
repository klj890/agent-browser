/**
 * SSE parser unit tests (Stage 3.4).
 */

import { describe, expect, it } from "vitest";
import {
	parseSseStream,
	type SseEvent,
	stringToByteStream,
} from "../llm/sse.js";

async function collect(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): Promise<SseEvent[]> {
	const out: SseEvent[] = [];
	for await (const e of parseSseStream(stream, signal)) out.push(e);
	return out;
}

describe("parseSseStream", () => {
	it("parses a simple data event", async () => {
		const evts = await collect(stringToByteStream("data: hello\n\n"));
		expect(evts).toEqual([{ event: undefined, data: "hello" }]);
	});

	it("parses multiple data events separated by blank lines", async () => {
		const evts = await collect(
			stringToByteStream("data: one\n\ndata: two\n\ndata: three\n\n"),
		);
		expect(evts.map((e) => e.data)).toEqual(["one", "two", "three"]);
	});

	it("concatenates multi-line data fields with \\n", async () => {
		const evts = await collect(
			stringToByteStream("data: line1\ndata: line2\n\n"),
		);
		expect(evts[0]?.data).toBe("line1\nline2");
	});

	it("captures event names", async () => {
		const evts = await collect(
			stringToByteStream("event: ping\ndata: {}\n\nevent: pong\ndata: {}\n\n"),
		);
		expect(evts.map((e) => e.event)).toEqual(["ping", "pong"]);
	});

	it("ignores comments (lines starting with :)", async () => {
		const evts = await collect(
			stringToByteStream(": keepalive\n\ndata: hello\n\n: another comment\n\n"),
		);
		expect(evts.map((e) => e.data)).toEqual(["hello"]);
	});

	it("handles CRLF line endings", async () => {
		const evts = await collect(
			stringToByteStream("data: a\r\n\r\ndata: b\r\n\r\n"),
		);
		expect(evts.map((e) => e.data)).toEqual(["a", "b"]);
	});

	it("flushes trailing event without closing blank line", async () => {
		const evts = await collect(stringToByteStream("data: tail"));
		expect(evts.map((e) => e.data)).toEqual(["tail"]);
	});

	it("respects an abort signal and stops iteration", async () => {
		// Stream that never closes.
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: first\n\n"));
				// never closes; we rely on abort
			},
		});
		const ctrl = new AbortController();
		const iter = parseSseStream(stream, ctrl.signal)[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.done).toBe(false);
		expect(first.value?.data).toBe("first");
		ctrl.abort();
		const second = await iter.next();
		expect(second.done).toBe(true);
	});
});
