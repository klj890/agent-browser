import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agentBrowser", {
	agent: {
		prompt: (text: string) => ipcRenderer.invoke("agent:prompt", text),
		cancel: (taskId: string) => ipcRenderer.invoke("agent:cancel", taskId),
		onStream: (cb: (chunk: unknown) => void) => {
			const listener = (_: unknown, chunk: unknown) => cb(chunk);
			ipcRenderer.on("agent:stream", listener);
			return () => ipcRenderer.off("agent:stream", listener);
		},
	},
	tab: {
		open: (
			url: string,
			opts?: { incognito?: boolean; profileId?: string; background?: boolean },
		) => ipcRenderer.invoke("tab:open", url, opts),
		close: (id: string) => ipcRenderer.invoke("tab:close", id),
		focus: (id: string) => ipcRenderer.invoke("tab:focus", id),
		list: () => ipcRenderer.invoke("tab:list"),
		navigate: (id: string, url: string) =>
			ipcRenderer.invoke("tab:navigate", id, url),
		back: (id: string) => ipcRenderer.invoke("tab:back", id),
		forward: (id: string) => ipcRenderer.invoke("tab:forward", id),
		reload: (id: string) => ipcRenderer.invoke("tab:reload", id),
		undoClose: () => ipcRenderer.invoke("tab:undoClose"),
		snapshotCurrent: () => ipcRenderer.invoke("tab:snapshotCurrent"),
	},
	profiles: {
		list: () => ipcRenderer.invoke("profiles:list"),
		create: (name: string) => ipcRenderer.invoke("profiles:create", name),
		rename: (id: string, name: string) =>
			ipcRenderer.invoke("profiles:rename", id, name),
		remove: (id: string) => ipcRenderer.invoke("profiles:remove", id),
	},
	reading: {
		extract: (tabId: string) => ipcRenderer.invoke("reading:extract", tabId),
	},
	extensions: {
		list: () => ipcRenderer.invoke("extensions:list"),
		install: (folder?: string) =>
			ipcRenderer.invoke("extensions:install", folder),
		remove: (id: string) => ipcRenderer.invoke("extensions:remove", id),
		setEnabled: (id: string, enabled: boolean) =>
			ipcRenderer.invoke("extensions:setEnabled", id, enabled),
	},
	mcp: {
		status: () => ipcRenderer.invoke("mcp:status"),
		enable: (port?: number) => ipcRenderer.invoke("mcp:enable", port),
		disable: () => ipcRenderer.invoke("mcp:disable"),
		regenerateToken: () => ipcRenderer.invoke("mcp:regenerateToken"),
	},
	sync: {
		status: () => ipcRenderer.invoke("sync:status"),
		configure: (passphrase: string, serverUrl?: string) =>
			ipcRenderer.invoke("sync:configure", passphrase, serverUrl),
		unlock: (passphrase: string) =>
			ipcRenderer.invoke("sync:unlock", passphrase),
		lock: () => ipcRenderer.invoke("sync:lock"),
		disable: () => ipcRenderer.invoke("sync:disable"),
		pushNow: () => ipcRenderer.invoke("sync:pushNow"),
		pullNow: () => ipcRenderer.invoke("sync:pullNow"),
	},
	policy: {
		get: () => ipcRenderer.invoke("policy:get"),
	},
	persona: {
		list: () => ipcRenderer.invoke("persona:list"),
		switch: (slug: string) => ipcRenderer.invoke("persona:switch", slug),
	},
	slash: {
		execute: (input: string) => ipcRenderer.invoke("slash:execute", input),
	},
	vault: {
		set: (key: string, secret: string) =>
			ipcRenderer.invoke("vault:set", key, secret),
		list: () => ipcRenderer.invoke("vault:list"),
		delete: (key: string) => ipcRenderer.invoke("vault:delete", key),
		clear: () => ipcRenderer.invoke("vault:clear"),
	},
	trace: {
		listTasks: (limit?: number) => ipcRenderer.invoke("trace:listTasks", limit),
		getTaskEvents: (taskId: string) =>
			ipcRenderer.invoke("trace:getTaskEvents", taskId),
		clear: () => ipcRenderer.invoke("trace:clear"),
	},
	routines: {
		list: () => ipcRenderer.invoke("routines:list"),
		create: (routine: unknown) =>
			ipcRenderer.invoke("routines:create", routine),
		update: (name: string, routine: unknown) =>
			ipcRenderer.invoke("routines:update", name, routine),
		delete: (name: string) => ipcRenderer.invoke("routines:delete", name),
		enable: (name: string, enabled: boolean) =>
			ipcRenderer.invoke("routines:enable", name, enabled),
		runNow: (name: string) => ipcRenderer.invoke("routines:runNow", name),
	},
	history: {
		list: (limit?: number, offset?: number) =>
			ipcRenderer.invoke("history:list", limit, offset),
		search: (q: string, limit?: number) =>
			ipcRenderer.invoke("history:search", q, limit),
		fullTextSearch: (q: string, limit?: number) =>
			ipcRenderer.invoke("history:fullTextSearch", q, limit),
		semanticSearch: (q: string, limit?: number) =>
			ipcRenderer.invoke("history:semanticSearch", q, limit),
		clear: () => ipcRenderer.invoke("history:clear"),
	},
	bookmarks: {
		add: (input: { url: string; title?: string; folder?: string }) =>
			ipcRenderer.invoke("bookmarks:add", input),
		remove: (id: number) => ipcRenderer.invoke("bookmarks:remove", id),
		list: (folder?: string) => ipcRenderer.invoke("bookmarks:list", folder),
		reorder: (folder: string, ids: number[]) =>
			ipcRenderer.invoke("bookmarks:reorder", folder, ids),
	},
	downloads: {
		list: () => ipcRenderer.invoke("downloads:list"),
		cancel: (id: string) => ipcRenderer.invoke("downloads:cancel", id),
		openFolder: (id: string) => ipcRenderer.invoke("downloads:open-folder", id),
		onProgress: (cb: (rec: unknown) => void) => {
			const listener = (_: unknown, rec: unknown) => cb(rec);
			ipcRenderer.on("downloads:progress", listener);
			return () => ipcRenderer.off("downloads:progress", listener);
		},
	},
});
