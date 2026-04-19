# Agent Browser — Administrator Guide

This document covers the **AdminPolicy** — the single authoritative
configuration object that controls what the AI agent inside Agent Browser
is allowed to do. Every gate in the runtime (tool whitelist, URL allowlist,
autonomy level, cost budget, force-confirm actions, redaction rules) reads
from this policy.

Audience: the person who sets up Agent Browser for a team, or anyone using
it personally on a machine that handles sensitive data.

---

## 1. Where the policy lives

- **Storage:** the policy is serialised to JSON and written to the OS
  keychain. macOS → Keychain, Windows → Credential Manager, Linux →
  libsecret.
  - `service`: `agent-browser`
  - `account`: `admin-policy`
- **Admin password:** a separate keychain entry, scrypt-hashed
  (`account: admin-password-hash`). Required to modify the policy; not
  required to read it (so ops can audit the live policy without secrets).
- **First-time bootstrap:** on first launch the policy defaults to the
  values in `DEFAULT_POLICY` (see `apps/main/src/admin-policy.ts`) and no
  admin password is set. The first person who opens
  `Settings → Admin → Set password` becomes admin.

## 2. Schema reference

All fields below come from `AdminPolicySchema` (zod) in
`apps/main/src/admin-policy.ts`.

### 2.1 `autonomy` — the core gate

| Value          | Meaning |
|---|---|
| `manual`         | Agent may NOT call any write tool without a modal confirm. Read tools (snapshot, read, screenshot) run freely. |
| `confirm-each`   | Agent may call read tools freely. Every write tool (click, fill, goto, download, ...) shows a modal confirm. Default. |
| `autonomous`     | Agent runs end-to-end within the `allowedDomains` allowlist. **High-risk actions still confirm** (see `forceConfirmActions`). |

Rule of thumb:
- One-off tasks on sensitive sites → `manual`
- Daily use → `confirm-each`
- Background automation on a known set of domains → `autonomous` with a
  tight `allowedDomains` list

### 2.2 Tool & domain allowlists

| Field | Default | Notes |
|---|---|---|
| `allowedTools`      | `[snapshot, read, goto, act, screenshot]` | Tools not in this list are not even registered with the agent. |
| `allowedDomains`    | `[]` (= allow all for `manual`/`confirm-each`; **strict allowlist in `autonomous`**) | Glob syntax: `example.com`, `*.example.com`, `*`. |
| `allowedUrlSchemes` | `[http, https]` | `data:`, `blob:`, `file:` must be explicitly enabled. |
| `blockedDomains`    | `[]` | Hard block — overrides allow. |

In `autonomous` mode: an empty `allowedDomains` means **nothing is
allowed**. This is the intended "fail closed" default.

### 2.3 Force-confirm actions

High-risk actions always prompt, even in `autonomous`:

- `form_submit` — clicking a form's submit button
- `file_download` — any download (data exit point)
- `file_upload` — file chooser fill
- `cross_origin_navigate` — navigate that crosses the current tab's origin
- `password_field_read` / `password_field_write` — touching a password input
- `clipboard_write`
- `geolocation_read`

Edit via `forceConfirmActions: [...]`. Default list covers the most common
data-exfiltration vectors.

### 2.4 Cost guardrails

| Field | Default | Meaning |
|---|---|---|
| `maxStepsPerTask`   | 30       | Agent tool-call loop cap. |
| `maxTokensPerTask`  | 200 000  | Aggregate input + output tokens per task. |
| `maxUsdPerTask`     | 2.00     | Per-task dollar ceiling. |
| `maxUsdPerDay`      | 20.00    | Daily dollar ceiling per user. |

Breaching any limit transitions the task to `budget_exceeded` and the agent
refuses further LLM calls until a new task or a new day (for `maxUsdPerDay`).

### 2.5 Redaction

```yaml
redaction:
  enableDefaultRules: true
  customPatterns:
    - name: internal-ticket
      pattern: "TICKET-\\d{4,}"
      flags: gi
```

Default detectors: cookie / Set-Cookie, JWT, Bearer, api-key, Chinese
national ID, credit card (Luhn validated), SSH private key, AWS access
key, CN mobile phone. Email is OFF by default.

Custom patterns are plain-text regex sources — they run against the
LLM-outbound string **after** normalization (NFKC + zero-width strip +
homoglyph fold) to defeat Unicode spoofing.

### 2.6 Egress control

```yaml
egress:
  blockNonAllowedInAutonomous: true     # intercept webRequest in autonomous
  auditAllRequests: false
```

In `autonomous`, this installs a `webRequest.onBeforeRequest` handler that
blocks network requests to domains outside `allowedDomains`. The handler
only covers requests issued by agent-driven tab actions; user-initiated
navigation is governed by the normal URL allowlist.

### 2.7 Extensions

```yaml
extension:
  allowMv3: true
  allowedExtensionIds: [ ... ]
```

Chrome MV3 extensions support is P1-15. Keep disabled (empty list) for
P0 deployments — extensions can be an injection vector.

## 3. Editing the policy

Two ways:

1. **Settings UI** (`Settings → Admin`). Enter the admin password to unlock
   the form. Changes write to the keychain and emit a `policy.change` event
   to the audit log with a diff + before/after hash.
2. **Programmatic** (useful for provisioning new machines):
   ```ts
   import { AdminPolicyStore } from "./apps/main/src/admin-policy.js";
   const store = new AdminPolicyStore();
   await store.setAdminPassword(null, "s3cret");
   await store.update("s3cret", { autonomy: "manual" });
   ```

The admin password is **not** recoverable — lose it and you must `reset()`
the keychain entries (which also clears the policy to defaults).

## 4. Audit log

Location: `{userData}/agent-browser/audit/YYYY-MM-DD.jsonl`. One line per
event; the schema is the union in `apps/main/src/audit-log.ts`:

| event | When |
|---|---|
| `task.start`          | New user prompt begins. |
| `task.end`            | Task reaches a terminal state. |
| `task.state-change`   | Status transitions (pending → running → completed etc.). |
| `llm.call.pre`        | Before every LLM request — records redaction hit counts. |
| `llm.call.post`       | After every LLM response — records tokens + USD. |
| `tool.call`           | Tool invoked by the agent. |
| `tool.confirm`        | Confirmation dialog resolved (approved / denied / timeout). |
| `injection.flag`      | Suspicious injection pattern detected on the page. |
| `policy.change`       | Admin edited the policy. |

Events contain hashes and summaries, NEVER raw prompt or tool-result
payloads. The 200-character excerpt is sliced from the already-redacted
outbound string so no secret ever reaches disk.

### 4.1 Exporting a trace

For a single task: in the sidebar, type `/export-trace`. The JSONL for
that task is put on the clipboard.

For a day: copy the file directly from the `audit/` directory.

For bulk analysis: files are plain JSONL, so any tool works:

```bash
jq 'select(.event == "tool.call")' ~/Library/Application\ Support/Agent\ Browser/audit/2026-04-18.jsonl
```

## 5. Common admin tasks

### 5.1 "Lock this machine down for a junior user"

```yaml
autonomy: manual
allowedTools: [snapshot, read]
allowedDomains: []
costGuard:
  maxUsdPerDay: 1.0
  maxStepsPerTask: 10
```

### 5.2 "Safe automation on GitHub only"

```yaml
autonomy: autonomous
allowedDomains: [github.com, "*.github.com"]
allowedTools: [snapshot, read, goto, act]
forceConfirmActions:
  [form_submit, file_download, cross_origin_navigate, password_field_write]
egress:
  blockNonAllowedInAutonomous: true
```

### 5.3 "Rotate admin password"

`AdminPolicyStore.setAdminPassword(oldPwd, newPwd)` — old is required when
a password already exists. To recover from a lost password, call
`store.reset()` and re-provision.

## 6. Validating a deployment

Run the repo's verification scripts against a built binary:

```bash
pnpm verify:cookie-leak     # asserts no cookie value ever appears in audit log
pnpm verify:injection       # runs 10 injection variants against the agent
pnpm e2e                    # full acceptance suite
```

See `docs/SECURITY-CHECKLIST.md` for the per-threat validation matrix.
