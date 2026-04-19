# Agent Browser — Security Checklist

This checklist maps every row in PLAN.md's **Threat Model** table to:

- the runtime module that enforces the mitigation
- how to verify the mitigation is working (automated script or e2e test)

Use it as a pre-release gate. All twelve items must pass before cutting a
tag.

---

## Threat-by-threat matrix

### 1. Indirect prompt injection (malicious page)

- **Mitigation:** every page-derived string is wrapped in
  `<untrusted_page_content boundary="{random}">…</untrusted_page_content>`.
  The boundary token is `nanoid(24)` per tool call, so the page cannot forge
  a matching close tag.
- **Enforcement:** `packages/browser-tools/src/content-boundary.ts` (wrapper);
  `apps/main/src/prompts/system.md` (LLM contract that the block is data).
- **Verify:**
  - `pnpm e2e` → `e2e/prompt-injection.e2e.ts` (100 tokens unique,
    injected close tag cannot escape).
  - `pnpm verify:injection` — 10 injection variants from PLAN's I1–I10 matrix.

### 2. Passwords / credentials entering the LLM context

- **Mitigation (P0):** `snapshot.redactInputs` drops password / hidden
  input *values* at the AX-tree level. `RedactionPipeline` strips any
  residual cookie/JWT/apikey strings on outbound.
- **Mitigation (P1-9):** Auth Vault (AES-256-GCM, key in OS keychain)
  gives the agent `{{vault:name}}` placeholders; only the vault resolver
  expands them at `act.execute` time. LLM never sees cleartext.
- **Enforcement:** `packages/browser-tools/src/snapshot.ts` redaction
  branch; `apps/main/src/redaction-pipeline.ts`; (P1) `auth-vault.ts`.
- **Verify:**
  - `e2e/snapshot-no-password.e2e.ts` — password value never in snapshot output.
  - `e2e/auth-vault-placeholder.e2e.ts` — TODO until P1-9 lands.
  - `pnpm verify:cookie-leak` — simulates a logged-in session, greps audit log.

### 3. Cookie / session hijacking via outbound LLM payload

- **Mitigation:** four defence layers — source isolation (cookies never in
  prompt), perceptual filter (AX-tree drop), outbound redaction
  (`RedactionPipeline`), audit-log trip-wire.
- **Enforcement:** `apps/main/src/redaction-pipeline.ts` R1 (cookie/Set-Cookie);
  `apps/main/src/audit-log.ts` hash-only excerpts.
- **Verify:**
  - `e2e/cookie-isolation.e2e.ts` — pipeline hits cookie rule ≥ 1, raw value gone.
  - `pnpm verify:cookie-leak` — full-flow audit-log grep.

### 4. Data exfiltration to an arbitrary domain

- **Mitigation:** URL allowlist checked in `checkUrlAllowed` before every
  `goto`; in `autonomous` mode, `webRequest.onBeforeRequest` hooks block
  agent-initiated requests to domains outside the allowlist.
- **Enforcement:** `packages/browser-tools/src/goto.ts` (pre-navigate);
  `apps/main/src/tab-manager.ts` (webRequest) + `admin-policy.ts`
  (`egress.blockNonAllowedInAutonomous`).
- **Verify:**
  - `e2e/admin-gate-autonomous-domain.e2e.ts` — `evil.com` refused,
    `example.com` allowed.

### 5. Agent runaway loop

- **Mitigation:** `costGuard.maxStepsPerTask` hard ceiling; emergency-stop
  keybinding (`CmdOrCtrl+Shift+.`); AgentHost checks abort signal on every
  loop iteration.
- **Enforcement:** `apps/main/src/agent-host.ts` (budget check + abort race);
  `apps/main/src/emergency-stop.ts` (global shortcut).
- **Verify:**
  - `e2e/emergency-stop.e2e.ts` — cancel mid-stream → `done{reason:'killed'}`.
  - AgentHost unit tests cover `budget_exceeded` for tokens / USD / steps.

### 6. Filesystem escape

- **Mitigation:** agent tools have no filesystem API. Downloads are
  intercepted and forced into `~/Downloads/agent-browser/`. Write-tool
  whitelist excludes any filesystem verbs.
- **Enforcement:** `apps/main/src/download.ts` (Stage 1.6 — scope fixed);
  `admin-policy.allowedTools` excludes `fs_*`.
- **Verify:**
  - Manual — download a file in `confirm-each`, confirm destination.
  - No automated test in P0; add Stage 11 when extensions land.

### 7. Multi-tab session takeover

- **Mitigation:** each tab has its own `RefRegistry`, `CdpAdapter`, and
  (via Chromium partition) cookie jar. Agent cannot directly address a tab
  other than its active one; cross-tab operations require an explicit
  user confirm.
- **Enforcement:** `apps/main/src/tab-manager.ts` per-tab registry +
  partition; `createAgentHostForTab` factory scoped to one `tabId`.
- **Verify:**
  - `e2e/basic-browse.e2e.ts` covers tab isolation at the state-machine
    level. Full cross-tab ConfirmationHandler test lands when Stage P2-18
    (multi-tab agent) ships.

### 8. LLM URL hallucination

- **Mitigation:** re-use CogniRefract's Evidence Link 3-layer protection
  (server correction → global store → DOM override). Every factual claim
  is expected to cite `(src: {url}#{ref})` per the system prompt.
- **Enforcement:** `apps/main/src/prompts/system.md` citation rule;
  CogniRefract core when imported.
- **Verify:**
  - Manual review of trace exports.
  - Covered more fully when Stage P1-14 (trace viewer) lands.

### 9. Extension malicious behaviour

- **Mitigation:** MV3 extensions are P1-15; P0 ships with extensions
  disabled by default (`extension.allowMv3: true` but empty
  `allowedExtensionIds` ⇒ nothing loads).
- **Enforcement:** `admin-policy.extension.*`.
- **Verify:**
  - Confirm default policy has `allowedExtensionIds: []`.
  - No e2e; becomes actionable once MV3 plumbing lands.

### 10. Budget / cost escalation

- **Mitigation:** `costGuard.{maxTokensPerTask, maxUsdPerTask,
  maxUsdPerDay}` in AdminPolicy. `checkCostBudget` runs before every LLM
  call and before tool dispatch.
- **Enforcement:** `apps/main/src/admin-policy.ts` (`checkCostBudget`);
  `apps/main/src/agent-host.ts` (pre-call budget check).
- **Verify:**
  - AgentHost unit tests for each budget reason.
  - Integration: set `maxUsdPerTask: 0.001`, run a task, confirm
    `budget_exceeded` in audit log.

### 11. Admin-policy tamper

- **Mitigation:** policy writes require `adminPwd`; scrypt-hashed in OS
  keychain. Every change emits a `policy.change` audit event with
  before/after hashes.
- **Enforcement:** `apps/main/src/admin-policy.ts`
  (`AdminPolicyStore.update` gate).
- **Verify:**
  - `apps/main/src/__tests__/admin-policy.test.ts` — password rotation,
    corrupted JSON → defaults, scrypt timing-safe compare.

### 12. Secret leakage via audit log

- **Mitigation:** audit log stores only hashes + 200-char excerpts of the
  ALREADY-REDACTED outbound string. Raw prompts and tool results never
  reach disk in this channel.
- **Enforcement:** `apps/main/src/audit-log.ts` (`summarizeInput` /
  `summarizeOutput`); `createAgentHostForTab` hooks compute payload hashes
  but not payloads.
- **Verify:**
  - `apps/main/src/__tests__/audit-log.test.ts`.
  - `pnpm verify:cookie-leak` also checks this end-to-end.

---

## Release gate

Run before cutting a `v*` tag:

```bash
pnpm test           # 300+ unit tests
pnpm e2e            # 12-scenario acceptance suite (2 skipped for P1)
pnpm verify:all     # cookie-leak + injection scripts
pnpm check          # biome lint+format
pnpm package:dry    # electron-builder config sanity
```

All five must exit 0.
