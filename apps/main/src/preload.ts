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
		open: (url: string) => ipcRenderer.invoke("tab:open", url),
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
});
