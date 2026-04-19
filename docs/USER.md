# Agent Browser — User Guide

Welcome. Agent Browser is a privacy-first web browser with a built-in AI
assistant that can read, summarize, and interact with web pages on your
behalf — without ever sending your cookies, passwords, or session tokens to
the language model.

This guide walks through installation, first-launch, core features, privacy
guarantees, keyboard shortcuts, and the slash commands you can type in the
sidebar.

---

## 1. Installation

Download the installer for your platform from the
[Releases page](https://github.com/klj890/agent-browser/releases).

| Platform | File | Notes |
|---|---|---|
| **macOS**   | `Agent Browser-{ver}-arm64.dmg` / `-x64.dmg` | Drag to `/Applications`. Dev builds are self-signed: the first launch requires `Right-click → Open` to bypass Gatekeeper. |
| **Windows** | `Agent Browser Setup {ver}.exe` (NSIS) or portable `.exe` | NSIS installs per-user; portable runs without installation. SmartScreen may warn on first launch — "More info → Run anyway" while dev builds are unsigned. |
| **Linux**   | `Agent Browser-{ver}.AppImage` or `.deb`     | Mark the AppImage executable (`chmod +x`) before running. `.deb` installs via `sudo dpkg -i`. |

All builds include the full Chromium engine — no external browser is required.

## 2. First launch

1. Agent Browser opens a welcome tab and populates a default persona,
   **Browse Helper**. No account setup is required to use the browser.
2. If you want persona sync across devices, register an account in
   `Settings → Account` (the account is hosted by your org's
   `agent-browser-server`; self-hosted or SaaS depending on deployment).
3. Open the sidebar (right-hand panel) and type a prompt. The assistant will
   ask the admin policy's current autonomy level before taking any write
   action.

## 3. Core features

### 3.1 Tabs

Classic tab strip at the top. Create, close, reorder by drag, middle-click
to close. Closed tabs go into an in-memory stack of the last 10; restore one
with `Cmd/Ctrl+Shift+T`.

### 3.2 Sidebar assistant

The AI assistant lives in the right sidebar. It can:
- Summarize the current page (`"what is this page about?"`)
- Fill forms when you ask (`"fill the email with alice@example.com"`)
- Navigate by name (`"open my GitHub notifications"`)
- Extract structured data (`"list the prices in the table"`)

Each reply **cites** the page URL and, when possible, the element ref the
claim came from. Uncited claims are the assistant's inference.

### 3.3 Persistent conversation

Each tab owns its own conversation history. Switch tabs and the sidebar
thread follows. Closing a tab clears its thread.

### 3.4 Persona switching

A **persona** is a Markdown file with a YAML front matter block that steers
the assistant's behaviour. Built-in personas live in
`apps/main/personas/`; user personas live in the config directory and sync
to the server if logged in.

Each persona declares a `domains: []` list. When you navigate to a matching
domain, Agent Browser auto-switches the sidebar to that persona. You can
also pick one manually from the sidebar header.

Example persona (`shopping-expert.md`):

```markdown
---
name: "Shopping Expert"
description: Compares product prices and reviews
domains: [amazon.com, "*.amazon.com", taobao.com]
allowedTools: [snapshot, read, goto]
---
Personalized guidance the Agent follows on shopping sites...
```

## 4. Privacy promise

This is a privacy-first browser. In plain language:

1. **Cookies, session tokens, and passwords never enter the AI model.**
   Four defence layers enforce this:
   - Source isolation — cookies live only in local SQLite, not in any LLM prompt
   - Perceptual filtering — the page snapshot drops password/hidden field values
   - Outbound redaction — every outbound message is scanned for cookies, JWTs,
     API keys, national IDs, credit cards
   - Audit log — every LLM call records which redaction rules fired
2. **All browsing data is local.** No telemetry. No cloud sync of history.
   Personas are the only thing that sync, and only if you log in.
3. **Agent actions obey admin policy.** Your admin (or you, on a personal
   device) chooses one of three autonomy levels. See `docs/ADMIN.md`.

## 5. Keyboard shortcuts

| Action | Shortcut |
|---|---|
| New tab                      | `Cmd/Ctrl+T` |
| Close tab                    | `Cmd/Ctrl+W` |
| Reopen last closed tab       | `Cmd/Ctrl+Shift+T` |
| Switch to next/prev tab      | `Cmd/Ctrl+Alt+Right/Left` |
| Focus address bar            | `Cmd/Ctrl+L` |
| Reload                       | `Cmd/Ctrl+R` |
| Toggle sidebar               | `Cmd/Ctrl+/` |
| **Emergency stop (abort agent)** | `Cmd/Ctrl+Shift+.` |
| Screenshot current tab       | `Cmd/Ctrl+Shift+S` |

`Cmd/Ctrl+Shift+.` is the panic button. Press it any time the agent is
"thinking" or about to do something you didn't want. It aborts within
~200 ms, marks the task as `killed` in the audit log, and leaves the page
as-is.

## 6. Slash commands

Type one of these at the start of a sidebar input. Slash commands run
**locally** — they do not consume LLM tokens.

| Command | Purpose |
|---|---|
| `/stop`         | Abort the currently running task (same as the keyboard shortcut). |
| `/screenshot`   | Capture the active tab as a PNG and attach it to the conversation. |
| `/export-trace` | Export the current task's audit-log events as JSONL. Useful when filing a bug or auditing behaviour. |
| `/dom-tree`     | Print the full accessibility tree (role + name, no content). Diagnostic. |
| `/clear-vault`  | (P1-9) Wipe stored credentials. Currently emits a placeholder notice until the Auth Vault lands. |

## 7. Where is my data stored?

| Data | Location |
|---|---|
| History, bookmarks, downloads    | `{userData}/agent-browser/local.sqlite` |
| Audit log                         | `{userData}/agent-browser/audit/YYYY-MM-DD.jsonl` |
| Admin policy (encrypted)          | OS keychain (`service: agent-browser`, `account: admin-policy`) |
| Personas (local cache + user)     | `{userData}/agent-browser/personas/` |
| Cookies / session (Chromium)      | `{userData}/Partitions/persist:default/` |

`{userData}` is:
- macOS: `~/Library/Application Support/Agent Browser/`
- Windows: `%APPDATA%\Agent Browser\`
- Linux: `~/.config/Agent Browser/`

To fully reset the browser, quit it and delete that directory.

## 8. Getting help

- Found a bug? `/export-trace`, save the JSONL, and file an issue with the
  paste attached — but **review it first**, it may contain URLs you consider
  private.
- Security disclosure? See `SECURITY.md` in the repo.
