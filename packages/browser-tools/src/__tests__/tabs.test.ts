import { beforeEach, describe, expect, it } from "vitest";
import type { NavigationPolicy } from "../goto.js";
import {
	createTabsSkills,
	type TabController,
	type TabInfo,
	type TabsCloseResult,
	type TabsOpenResult,
	type TabsSwitchResult,
	type TabsWaitLoadResult,
} from "../tabs.js";

function fakeController(opts?: {
	initialActive?: string;
	waitLoadResult?: "idle" | "timeout" | "crashed";
}): TabController & {
	tabs: Map<string, TabInfo>;
	nextId: number;
	_active: string;
} {
	const tabs = new Map<string, TabInfo>();
	const state = {
		tabs,
		nextId: 1,
		_active: opts?.initialActive ?? "",
	};
	const mkId = () => `t${state.nextId++}`;
	const ctrl: TabController = {
		list: () =>
			Array.from(tabs.values()).map((t) => ({
				...t,
				agentActive: t.id === state._active,
			})),
		open(url) {
			const id = mkId();
			tabs.set(id, {
				id,
				url,
				title: url,
				openedByAgent: true,
				agentActive: false,
			});
			return id;
		},
		close(id) {
			tabs.delete(id);
		},
		canClose(id) {
			return tabs.get(id)?.openedByAgent === true;
		},
		exists(id) {
			return tabs.has(id);
		},
		setAgentActive(id) {
			if (tabs.has(id)) state._active = id;
		},
		getAgentActiveId() {
			return state._active;
		},
		waitLoad: async () => opts?.waitLoadResult ?? "idle",
	};
	return Object.assign(ctrl, state);
}

function getSkill(skills: ReturnType<typeof createTabsSkills>, name: string) {
	const s = skills.find((x) => x.name === name);
	if (!s) throw new Error(`skill '${name}' not found`);
	return s;
}

describe("tabs skills", () => {
	let controller: ReturnType<typeof fakeController>;

	beforeEach(() => {
		controller = fakeController({ initialActive: "t-user" });
		// Seed a user-owned tab so we can test not_agent_owned path.
		controller.tabs.set("t-user", {
			id: "t-user",
			url: "https://example.com",
			title: "Example",
			openedByAgent: false,
			agentActive: true,
		});
	});

	it("tabs_list surfaces agentActive + openedByAgent flags", async () => {
		const skills = createTabsSkills({ controller });
		const res = (await getSkill(skills, "tabs_list").execute({})) as {
			tabs: TabInfo[];
		};
		expect(res.tabs).toHaveLength(1);
		expect(res.tabs[0]).toMatchObject({
			id: "t-user",
			agentActive: true,
			openedByAgent: false,
		});
	});

	it("tabs_open rejects URL not in allowedDomains (domain_not_allowed)", async () => {
		const policy: NavigationPolicy = { allowedDomains: ["example.com"] };
		const skills = createTabsSkills({ controller, policy });
		const res = (await getSkill(skills, "tabs_open").execute({
			url: "https://evil.com/attack",
		})) as TabsOpenResult;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("domain_not_allowed");
		expect(controller.tabs.size).toBe(1); // nothing created
	});

	it("tabs_open creates tab flagged openedByAgent and switches agent focus by default", async () => {
		const skills = createTabsSkills({ controller });
		const res = (await getSkill(skills, "tabs_open").execute({
			url: "https://docs.example.com/page",
		})) as TabsOpenResult;
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.agentActive).toBe(true);
		const created = controller.tabs.get(res.tabId);
		expect(created?.openedByAgent).toBe(true);
		expect(controller.getAgentActiveId()).toBe(res.tabId);
	});

	it("tabs_open with switch:false keeps the current agent active tab", async () => {
		const skills = createTabsSkills({ controller });
		const res = (await getSkill(skills, "tabs_open").execute({
			url: "https://docs.example.com/",
			switch: false,
		})) as TabsOpenResult;
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.agentActive).toBe(false);
		expect(controller.getAgentActiveId()).toBe("t-user");
	});

	it("tabs_close refuses to close user-owned tabs (not_agent_owned)", async () => {
		const skills = createTabsSkills({ controller });
		const res = (await getSkill(skills, "tabs_close").execute({
			tabId: "t-user",
		})) as TabsCloseResult;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("not_agent_owned");
		expect(controller.tabs.has("t-user")).toBe(true);
	});

	it("tabs_close removes agent-opened tabs", async () => {
		const skills = createTabsSkills({ controller });
		const open = (await getSkill(skills, "tabs_open").execute({
			url: "https://docs.example.com/",
		})) as TabsOpenResult;
		if (!open.ok) throw new Error("open failed");
		const res = (await getSkill(skills, "tabs_close").execute({
			tabId: open.tabId,
		})) as TabsCloseResult;
		expect(res.ok).toBe(true);
		expect(controller.tabs.has(open.tabId)).toBe(false);
	});

	it("tabs_close returns not_found for unknown id", async () => {
		const skills = createTabsSkills({ controller });
		const res = (await getSkill(skills, "tabs_close").execute({
			tabId: "nope",
		})) as TabsCloseResult;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("not_found");
	});

	it("tabs_switch changes agent active tab", async () => {
		const skills = createTabsSkills({ controller });
		controller.tabs.set("t-other", {
			id: "t-other",
			url: "https://ex2.com",
			title: "",
			openedByAgent: true,
			agentActive: false,
		});
		const res = (await getSkill(skills, "tabs_switch").execute({
			tabId: "t-other",
		})) as TabsSwitchResult;
		expect(res.ok).toBe(true);
		expect(controller.getAgentActiveId()).toBe("t-other");
	});

	it("tabs_switch returns not_found for unknown id and does not mutate active", async () => {
		const skills = createTabsSkills({ controller });
		const res = (await getSkill(skills, "tabs_switch").execute({
			tabId: "ghost",
		})) as TabsSwitchResult;
		expect(res.ok).toBe(false);
		expect(controller.getAgentActiveId()).toBe("t-user");
	});

	it("tabs_wait_load propagates timeout", async () => {
		const c = fakeController({
			initialActive: "a",
			waitLoadResult: "timeout",
		});
		c.tabs.set("a", {
			id: "a",
			url: "x",
			title: "",
			openedByAgent: true,
			agentActive: true,
		});
		const skills = createTabsSkills({ controller: c });
		const res = (await getSkill(skills, "tabs_wait_load").execute({
			tabId: "a",
		})) as TabsWaitLoadResult;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("timeout");
	});

	it("tabs_wait_load defaults tabId to the Agent active tab", async () => {
		const skills = createTabsSkills({ controller });
		const res = (await getSkill(skills, "tabs_wait_load").execute(
			{},
		)) as TabsWaitLoadResult;
		expect(res.ok).toBe(true);
	});

	it("tabs_wait_load distinguishes not_found from timeout when tab vanishes", async () => {
		const c = fakeController({
			initialActive: "a",
			waitLoadResult: "not_found",
		});
		c.tabs.set("a", {
			id: "a",
			url: "x",
			title: "",
			openedByAgent: true,
			agentActive: true,
		});
		const skills = createTabsSkills({ controller: c });
		const res = (await getSkill(skills, "tabs_wait_load").execute({
			tabId: "a",
		})) as TabsWaitLoadResult;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("not_found");
	});
});
