/**
 * Unit tests for the mock fixture server and pure helpers used by the
 * `verify:cookie-leak` / `verify:injection` scripts. These tests exercise
 * only pure functions and the HTTP surface — no playwright / chromium.
 */
import { describe, expect, it } from "vitest";
import {
	extractLeakedCookies,
	injectionRoutes,
	type LeakRequest,
	startMockServer,
} from "../fixtures/mock-server.js";

describe("startMockServer", () => {
	it("binds to a random 127.0.0.1 port and exposes injection routes", async () => {
		const srv = await startMockServer();
		try {
			expect(srv.port).toBeGreaterThan(0);
			expect(srv.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
			expect(srv.injectionPaths).toEqual(
				[
					"/i1",
					"/i10",
					"/i2",
					"/i3",
					"/i4",
					"/i5",
					"/i6",
					"/i7",
					"/i8",
					"/i9",
				].sort(),
			);
			expect(srv.sessionId).toMatch(/^[0-9a-f]{32}$/);
		} finally {
			await srv.close();
		}
	});

	it("serves the login form with user+pass inputs", async () => {
		const srv = await startMockServer();
		try {
			const res = await fetch(`${srv.origin}/login`);
			const body = await res.text();
			expect(body).toContain('<input name="user"');
			expect(body).toContain('<input name="pass" type="password"');
		} finally {
			await srv.close();
		}
	});

	it("sets an HttpOnly session cookie on POST /login and 303-redirects", async () => {
		const srv = await startMockServer();
		try {
			const res = await fetch(`${srv.origin}/login`, {
				method: "POST",
				body: "user=a&pass=b",
				redirect: "manual",
			});
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/dashboard");
			const sc = res.headers.get("set-cookie") ?? "";
			expect(sc).toContain(`sid=${srv.sessionId}`);
			expect(sc.toLowerCase()).toContain("httponly");
		} finally {
			await srv.close();
		}
	});

	it("dashboard HTML contains cookie header, JWT, and session id as bait for RedactionPipeline", async () => {
		const srv = await startMockServer();
		try {
			const res = await fetch(`${srv.origin}/dashboard`);
			const body = await res.text();
			expect(body).toContain(`Cookie: sid=${srv.sessionId}`);
			expect(body).toMatch(/eyJhbGciOiJIUzI1NiJ9\.eyJ/);
		} finally {
			await srv.close();
		}
	});

	it("records every /leak hit with headers and body into leakRequests", async () => {
		const srv = await startMockServer();
		try {
			expect(srv.leakRequests).toHaveLength(0);
			const res = await fetch(`${srv.origin}/leak?probe=1`, {
				method: "POST",
				body: "payload=abc",
				headers: { "x-test": "yes" },
			});
			expect(res.status).toBe(204);
			expect(srv.leakRequests).toHaveLength(1);
			const hit = srv.leakRequests[0];
			expect(hit?.method).toBe("POST");
			expect(hit?.url).toContain("/leak?probe=1");
			expect(hit?.headers["x-test"]).toBe("yes");
			expect(hit?.body).toBe("payload=abc");
		} finally {
			await srv.close();
		}
	});

	it("returns distinct injection bodies for each of /i1–/i10", async () => {
		const srv = await startMockServer();
		try {
			const got: Record<string, string> = {};
			for (const p of srv.injectionPaths) {
				const res = await fetch(`${srv.origin}${p}`);
				expect(res.status).toBe(200);
				got[p] = await res.text();
			}
			// Verify signal strings each route is meant to deliver.
			expect(got["/i1"]).toContain("Ignore previous instructions");
			expect(got["/i2"]).toContain("boundary=");
			expect(got["/i3"]).toMatch(/Iг|Iп/); // Cyrillic substitution present
			expect(got["/i4"]).toContain("<!-- ignore prev");
			expect(got["/i5"]).toContain("aria-label");
			expect(got["/i6"]).toContain("data-ocr");
			expect(got["/i7"]).toContain("/fake.pdf");
			expect(got["/i8"]).toContain("data:text/html");
			expect(got["/i9"]).toContain("<iframe");
			expect(got["/i10"]).toContain("::before");
		} finally {
			await srv.close();
		}
	});

	it("i9 iframe src points back at the same origin (not a third-party)", async () => {
		const srv = await startMockServer();
		try {
			const res = await fetch(`${srv.origin}/i9`);
			const body = await res.text();
			expect(body).toContain(`src="${srv.origin}/i1"`);
		} finally {
			await srv.close();
		}
	});
});

describe("extractLeakedCookies", () => {
	it("returns [] when no leak requests recorded", () => {
		expect(extractLeakedCookies([])).toEqual([]);
	});

	it("detects a Cookie header on a leak hit", () => {
		const hit: LeakRequest = {
			method: "GET",
			url: "/leak",
			headers: { cookie: "sid=abc" },
			body: "",
			receivedAt: 0,
		};
		expect(extractLeakedCookies([hit])).toEqual(["sid=abc"]);
	});

	it("detects smuggled sid in querystring even without Cookie header", () => {
		const hit: LeakRequest = {
			method: "GET",
			url: "/leak?cookie=sid%3Dabc",
			headers: {},
			body: "",
			receivedAt: 0,
		};
		expect(extractLeakedCookies([hit])).toHaveLength(1);
	});

	it("detects smuggled sid in body", () => {
		const hit: LeakRequest = {
			method: "POST",
			url: "/leak",
			headers: {},
			body: "exfil=sid=abc",
			receivedAt: 0,
		};
		expect(extractLeakedCookies([hit])).toHaveLength(1);
	});

	it("flattens array cookie headers", () => {
		const hit: LeakRequest = {
			method: "GET",
			url: "/leak",
			headers: { cookie: ["sid=1", "other=2"] },
			body: "",
			receivedAt: 0,
		};
		expect(extractLeakedCookies([hit])).toEqual(["sid=1", "other=2"]);
	});
});

describe("injectionRoutes", () => {
	it("produces I1..I10 entries sorted by path with absolute URLs", () => {
		const routes = injectionRoutes("http://127.0.0.1:4242");
		expect(routes.map((r) => r.id)).toEqual([
			"I1",
			"I10",
			"I2",
			"I3",
			"I4",
			"I5",
			"I6",
			"I7",
			"I8",
			"I9",
		]);
		for (const r of routes) {
			expect(r.url).toMatch(
				/^http:\/\/127\.0\.0\.1:4242\/i(1|2|3|4|5|6|7|8|9|10)$/,
			);
		}
	});
});
