# Stage 2 implementation notes

Deviations from PLAN 附录 E / H. Keep this list short — every entry is a debt.

## snapshot.ts
- Viewport distance uses AX `bounds` property when available; we do not call
  `DOM.getBoxModel` for every node (would be O(n) CDP round-trips). Trimming
  is therefore "best-effort" on pages whose AX tree lacks bounds — OK for
  Stage 2; revisit if a budget test regresses.
- `max_depth` kicks in even when `interactive_only=false`; this matches the
  附录 E bullet 3.a. Truncation marker `(+N more elements, use scope= to narrow)`
  is emitted at most once at the tail; we do NOT emit `"...(truncated)"` inline
  per-node (simpler and the content boundary + `truncated: true` flag already
  signal it).

## act.ts
- Vault placeholder substitution is left for agent-host (Stage 5 / P1-9). `fill`
  forwards `{{vault:xxx}}` to `Input.insertText` unchanged. A unit test pins
  this behavior.
- `check` / `uncheck` are click-with-state-check sugar. We read `meta.checked`
  from the introspect callFunctionOn and only dispatch mouse events when the
  state needs to flip.
- High-risk detection (`flagHighRisk`) is exported for reuse by the Stage 5
  ConfirmationHandler. It does NOT call the handler — that's the orchestrator's
  job. We only return the flags.

## goto.ts
- Policy is optional (`ctx.policy?`). Stage 5 will wire this to AdminPolicy.
  Default when absent: http/https allowed, no domain filter. `scheme_blocked` is
  returned BEFORE any CDP call, matching 附录 E injection-resistance requirement I8.

## index.ts
- `BrowserToolsCtx` exposes a unified `UnifiedCdp` interface (send + on) rather
  than per-tool intersections. This avoids a TS2320 conflict where `SnapshotCdp`
  (send-only) and `GotoCdp` (send + on) disagree on the `cdp` field shape.
  Callers pass one CdpAdapter that satisfies both.

## TabManager integration
- `CdpAdapter` is allocated lazily on `getTabCdp(id)`. Tabs the agent never
  touches never pay attach cost. `resetLifetime` runs on `did-navigate`,
  `page-frame-navigated`, and manual `.navigate()` (defensive).
- `Tab.registry` is always allocated (even for never-agented tabs); this is
  cheap (empty Map) and simplifies downstream code.

## Tests
- `packages/browser-tools/src/__tests__/snapshot.test.ts` — 11 cases covering
  附录 E's matrix (password, hidden, cc-number, max_depth, budget, boundary,
  scope, landmarks, text filter, ref reuse).
- `apps/main/src/__tests__/tools-integration.test.ts` — 4 e2e cases driven by
  playwright-core's chromium (not Electron). Skipped if launch fails.

## Skill shape
- The local `Skill` interface exposes `{name, description, inputSchema, execute}`.
  Stage 3 should align with CogniRefract's SkillManager once the agent-host is
  wired; for Stage 2 the shape is isolated to `browser-tools/index.ts` and
  nothing downstream depends on it yet.
