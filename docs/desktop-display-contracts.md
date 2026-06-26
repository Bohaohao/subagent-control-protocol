# SCP Desktop Display Contracts

**Schema identifier:** `scp.desktop-display-contracts/v1`
**Status:** Normative specification for the desktop monitor's three display modes.
**Companion artifacts:** `desktop-display-contracts.schema.json` (the machine-readable mirror) and the desktop app's display TypeScript types (the compile-time mirror consumed by the UI). These two artifacts MUST mirror the contract sections defined in this document and MUST use the canonical IDs and enum literals defined here verbatim.

This document is a stable contract, not design notes. Where it diverges from the earlier design exploration in `subagent-monitor-desktop/docs/display-modes-design.md`, this document is authoritative. The desktop app implements against this spec; the JSON Schema and TS types are derived from it.

### Canonical vocabulary (authoritative)

The canonical **machine** vocabulary for the three modes is the set of canonical IDs `right-dock` / `workbench` / `wallboard`. These IDs are the only valid machine identifiers and MUST be used verbatim in configuration, telemetry, the JSON Schema, and the TS types.

The human display names ("Side Monitor" / "Workbench" / "Wallboard") and the "Mode 1 / Mode 2 / Mode 3" design aliases are documentation, copy, and UI-label conveniences only. They MUST NOT be used as machine identifiers, enum values, or object keys. "Mode 1", the "Side Monitor", the "side rail", and the `right-dock` machine ID all refer to the same mode; the canonical machine ID is `right-dock`. (An earlier TS draft used `mode-1-side-rail`-style IDs; those are superseded — the TS types now use `right-dock` / `workbench` / `wallboard` as the canonical IDs, with `mode-1` / `mode-2` / `mode-3` carried only as the `designAlias` label.)

---

## 1. Purpose and scope

The desktop monitor is the read-only observation layer for the Subagent Control Protocol (SCP). It renders the state Codex produces while orchestrating Claude subagents. It does not create, cancel, or mutate runs.

This document defines two separable contracts:

1. **Transport contract** — how the desktop app obtains state (discovery, HTTP, SSE, polling fallback, error handling). This contract is owned by `docs/desktop-integration-handoff.md` and summarized here only where display behavior depends on it.
2. **Display contract** — how obtained state is rendered across the three display modes: what each mode shows, what it must not invent, the states it must define, and the rules for coexistence and degradation. This is the primary subject of this document.

The display contract layers on top of the `scp.run-view/v1` view model defined by `schemas/desktop-status.schema.json` and the transport view-model types in `subagent-monitor-desktop/src/types/models.ts` (`ScpRunView`, `ScpTaskView`, `ScpActiveTask`, `ScpEventView`, `ScpTokenEvidence`, …). It does not redefine that view model; it constrains how it is presented.

### 1.1 v1 scope

In scope for `scp.desktop-display-contracts/v1`:

- Canonical IDs, names, and roles for the three display modes.
- Shared display invariants (data honesty, reduced motion, accessibility, localization, disconnected/stale behavior, token display honesty).
- Coexistence rules between modes.
- Required empty / disconnected / recovered states per mode.
- Mode descriptors, layout constraints, panel-expansion behavior, notification policy, freshness thresholds, and wallboard degradation rules — the sections the JSON Schema and TS types must mirror.
- `wallboard` v1 wallboard behavior, bounded to fields the current `scp.run-view/v1` model can honestly support.

Deferred to a future schema expansion (out of scope for v1):

- Real agent-to-agent handoff / delegation edges.
- Explicit controller-to-agent topology.
- Structured retry / attempt-level statistics.
- `productive vs churn` token distinction.
- Server-provided native token rate / throughput.
- A complete `wallboard` conductor narrative (the "wallboard v2" tier).

These deferred items MUST NOT be simulated as real features in v1. `wallboard` v1 renders only what the current view model can substantiate.

---

## 2. Transport contract (summary)

The transport contract is normatively defined in `docs/desktop-integration-handoff.md`. The display contract depends on the following transport guarantees, restated here as display-level assumptions:

- **Single source of truth.** SCP is the only state source. The desktop app reads discovery (`bridge.json`), then `GET /health`, `GET /runs`, `GET /run/:runId`, `GET /events`, and `GET /events/stream`. It performs no write operations.
- **View model.** All rendering consumes `scp.run-view/v1` (single-run `mode:"run"` or overview `mode:"list"`). Raw prompts, stdout/stderr, env, and full command bodies are never surfaced; commands and verification are display-safe summaries.
- **SSE-first, polling fallback.** UI updates prefer SSE snapshots. On SSE loss the app falls back to `/health` + `/runs` polling and re-reads `bridge.json` before reconnecting, because the bridge port may change on restart.
- **One bridge connection.** Multiple desktop windows fan out internally from a single bridge connection; they do not each open their own.
- **Schema mismatch.** When a payload's `schema` field does not match the expected identifier, the app shows a version-incompatibility notice and does not render the unknown structure.
- **Error tiers.** HTTP 501 → hide the affected region; HTTP 502 → retain the last snapshot and retry; SSE drop → switch to polling and attempt reconnect.

The display contract does not re-specify endpoint shapes; it specifies how the UI behaves given those transport outcomes (see §5 disconnected/stale behavior).

---

## 3. Display contract identifier

- **Contract id:** `scp.desktop-display-contracts/v1`
- **Underlying data model:** `scp.run-view/v1` (`schemas/desktop-status.schema.json`, view-model types in `models.ts`).
- **Mirrors required.** This document is authoritative for the canonical vocabulary. `desktop-display-contracts.schema.json` (the machine-readable mirror) and the desktop app's display TS types (the compile-time mirror consumed by the UI) MUST declare this identifier, MUST use the canonical IDs (`right-dock` / `workbench` / `wallboard`) and the enum literals defined in §4 and §8 verbatim, and MUST mirror the root structure (`schemaVersion`, `schema`, `shared`, `modes`, `coexistence`, `deferredCapabilities`). The TS types are a faithful projection of the same contract, not an independent vocabulary; both mirrors MUST conform to this document. (An earlier TS draft used `mode-1-side-rail`-style IDs and a different root decomposition; the current TS has been aligned to the canonical IDs and root shape defined here.)

---

## 4. The three display modes

Each mode has one canonical machine ID. The human display name and the "Mode 1/2/3" design alias are labels only. Implementations MUST use the canonical IDs verbatim in configuration, telemetry, the schema, and the TS types.

| Canonical ID (machine) | Human display name | Design alias | Role | Default? |
| --- | --- | --- | --- | --- |
| `right-dock` | Side Monitor | Mode 1 | Ambient / peripheral monitoring dock | Optional companion |
| `workbench` | Workbench | Mode 2 | Controller-first primary workbench | **Default primary** |
| `wallboard` | Wallboard | Mode 3 | Presentation / ambient oversight board | Presentation |

The schema MUST enumerate exactly these three canonical IDs as the required `modes` keys and as each mode $def's `id` const; no others are valid in v1.

### 4.1 `right-dock` — Side Monitor (Mode 1)

A persistent, low-distraction, collapsible right-side dock. Its job is to continuously answer two questions: *Is any Claude subagent working right now?* and *Does any session/subagent need my attention?* It is a companion surface, not a second workbench.

- Docked to the right edge, full height.
- Collapsed: a `48px` status rail. Expanded: configurable width, default `360px`, min `300px`, max `400px`; width is persisted. (The authoritative expanded range is min `300px` / max `400px` / default `360px`. An earlier design draft suggested a `320–360px` range; that guidance is superseded by this contract.)
- Information architecture, top to bottom: Status Bar → Session Stack → Subagent Drilldown (overlay).
- Default expansion: only the most-recent active / running / blocked session is expanded; subagents are collapsed by default. Collapsing a session collapses its subagents. New events refresh the status dot and timestamp only; they do not force-expand.
- Auto-expand policy is a named configuration with a fixed default: `never` | `selectedSessionOnly` (default) | `anyFailedOrBlocked`.
- Peripheral alerts: taskbar/Dock badge count; system notifications limited to failed / blocked / waiting-on-user; optional subtle sound, off by default.

Additional v1 rules for `right-dock`:

- Default grouping is `runtime -> workerType`. The session stack MUST show group summary before drilling into individual tasks.
- Expansion must remain bounded at any concurrency level; the dock MUST NOT auto-expand without an explicit limit.
- `badgeCount` means **attention-needed task count**, not run count.

### 4.2 `workbench` — Workbench (Mode 2)

The primary daily workbench for actively supervising runs, chasing problems, and inspecting detail. Keywords: `controller-first`, `dense but calm`, `readable under stress`.

- Layout: Title/Connection bar (~32px) → Health Ribbon (~24px) → three columns (left Run List `240px`, center Run Detail + Task Table + Task Inspection `1fr`, right Recent Events + Metrics Rail `260px`) → Footer (~20px).
- Health Ribbon is always present (not gated on a selected run): `ACTIVE`, `STALE`, `BLOCKED`, `FAILED`, `DONE_TOTAL`; each is a filter into the left list.
- Center column is three segments, not one card: Run Header → Task Table → Selected Task Inspection.
- Default window `1100–1280 × 720`. Below ~980px width the right column collapses to a tab; below ~820px it degrades to a single column.
- Interaction: the selected run/task is sticky and is never auto-reclaimed by new events; `Follow live` is explicitly visible; manual scroll-back surfaces a `Jump to latest` affordance; connection errors degrade a region, never the whole page. Full keyboard path: ↑/↓ to move runs, Enter to open detail, Tab between columns, shortcuts for common recovery actions.

Additional v1 rules for `workbench`:

- The Task Table MUST be virtualized.
- Default filters MUST include `runtime`, `workerType`, `status`, and `observability`.
- Selection and `Follow live` behavior MUST NOT depend on transport order or event arrival order.

### 4.3 `wallboard` — Wallboard (Mode 3)

A presentation-grade, ambient oversight board for large screens, demos, and sideline monitoring. Its job is to make "Codex is orchestrating a fleet of Claude subagents" legible at a glance, with real dynamics — not fine-grained operation.

- v1 is bounded to what `scp.run-view/v1` honestly supports (see §1.1, §8.6). The full conductor/handoff narrative is deferred to v2 pending main-plugin schema expansion.
- Mixed rendering: motion/atmosphere on canvas; hero metrics, session clusters, alerts, events, and token/cost numbers in DOM. Canvas regions MUST provide a DOM/aria text mirror (see §6.3).
- Density handling is concurrency-agnostic: clustering, label suppression, and degradation MUST be driven by data density and viewport/performance budget, not by a hard-coded “20 agents” assumption.
- Stage layout uses **two independent axes**. The percentages below do NOT sum to a single 100% budget; reading all six as one list yields ~126% only because a vertical band list and a horizontal split list are shown together. Concretely:
  - **Vertical axis** — full-width height bands stacked top→bottom: Command Bar (~7%), Hero Metrics Band (~15%), the middle Body band (~74%, the remainder), bottom Status Ribbon / Event Ticker (~4%).
  - **Horizontal axis** — width split *within the middle Body band only*: left Session Clusters (~22%), center Agent Swarm / Conductor Core (~48%), right Alerts + Events (~30%). These three sum to ~100% of the body width.
- Hero metrics are limited to three (machine tokens in parentheses): `agentsInFlight` (Agents in flight), `tasksCompletedThisSession` (Tasks completed this session), `measuredTokensProcessed` (Measured tokens processed).
- Each hero metric MUST declare its provenance / `derivedFrom` field(s); the UI must not synthesize its own source.

---

## 5. Shared invariants

These invariants apply to all three modes. They are normative.

### 5.1 Data honesty

- A `Session` maps to one scheduling run (`ScpRunView`). A `Subagent` maps to one Claude subtask (`ScpTaskView` / `ScpActiveTask`). These view-model types are defined in `subagent-monitor-desktop/src/types/models.ts`.
- The UI MUST render values that the view model actually provides. A missing/unknown value is rendered as `null`-equivalent (e.g. "—" or a localized "unknown"), never as a fabricated zero, empty-progress, or "looks busy" signal.
- High-priority state MUST NOT be expressed by color alone. It requires at least one additional channel among: position, border, text label, icon.
- The current view model reliably supports: run/task counts; per-task status, kind, duration, `filesChanged`, `risks`, `verification`; `recentEvents`; accumulated token evidence; `stalenessMs`, `staleThresholdMs`, `lastHeartbeatAt`, `lastUsefulEventAt`; task/active-task `runtime`, `dispatcher`, `workerType`, `workerAlias`, `fallbackApplied`, and `observability`.
- `recentEvents` is a bounded overview window; `/events` is bounded incremental retrieval; `/events/stream` is snapshot SSE. No mode may treat any of the three as a raw, unbounded event pipe.
- Default high-density grouping is `runtime -> workerType`. A mode may let the user pivot away from that grouping, but it must not force the user to infer topology from an ungrouped flat stream.

### 5.1.1 Observability truth boundary

- `observability = live` means the UI may track freshness from real heartbeats/events and may render “currently live” affordances.
- `observability = summary-only` means only summary/terminal visibility is guaranteed. `summary-only` is not a failure state, and the UI MUST NOT fake live heartbeat pulses, streaming tickers, or “online” node choreography for it.
- `observability = null` means unknown. Unknown must render conservatively, not optimistically.

### 5.2 Token display honesty

- Precise token values are shown only when `tokenEvidence.measured === true`.
- When `measured` is false or evidence is absent, the UI MUST say so explicitly ("未测量" / "not measured", or "仅有运行级聚合" / "run-level aggregate only") and MUST NOT display a fabricated real-time token rate, throughput, or "effective output rate".
- `wallboard` hero token display uses accumulated, measured totals only. No synthetic token stream or rate is permitted in v1.

### 5.3 Reduced motion

- `reduced motion` is a hard requirement for all three modes, including the wallboard.
- When reduced motion is active: no particles, drift, or orbital animation; node state is conveyed via brightness, border, and text only; hero metrics and event lists still update (the event ticker may become a static updating list). `right-dock` and `workbench` lose no information under reduced motion.

### 5.4 Accessibility

- `right-dock` and `workbench` MUST have a complete keyboard-reachable path.
- `wallboard` MAY use canvas, but core information MUST also exist as a DOM/aria text mirror. Core information must never live only inside the canvas. The mirror MUST include at minimum: current active agent count, current list of abnormal agents, the most recent 5 high-priority events, and the current wallboard status.
- Color is never the sole signal (see §5.1).

### 5.5 Localization

- All user-facing strings have complete `zh` and `en` forms. No mixed-language UI and no format drift.
- Time formatting (relative and absolute), number formatting, and locale switching all go through one shared formatting layer used by all three modes.
- Waiting-class states MUST name the next action, e.g. `Waiting on you — approve shell access` / `等待你的决定 — 需要批准 shell 权限`.

### 5.6 Disconnected-state behavior

- On disconnect the UI MUST NOT blank the page and MUST NOT silently present stale data as live.
- The app MUST show an explicit disconnected banner stating the source time of the last known state, e.g. `Connection lost — showing last known state from HH:MM`.
- Per-mode degradation:
  - `right-dock`: the dock does not clear; it grays out and shows the frozen-time notice.
  - `workbench`: left column retains prior content; center column is frozen and marked read-only; right column stops auto-scroll.
  - `wallboard`: the board retains the last known state with a visible disconnected marker; ambient motion is reduced or paused.

### 5.7 Stale-data behavior

- Staleness is derived from `stalenessMs` against the run's stale threshold. A stale run is marked `STALE` and surfaced in the Health Ribbon / status dot, not hidden.
- Stale data is shown with its age; it is never relabeled as fresh. The freshness indicator and stale threshold source MUST be shared across all modes (single source; see §8.5).
- Missing heartbeat data only contributes to stale classification for `observability = live`. A `summary-only` task may be quiet, old, or terminal, but it is not stale merely because no heartbeat exists.

---

## 6. Required states

Each mode MUST implement these five states explicitly, not ad hoc at implementation time. The canonical state keys (machine tokens) are `firstRunNoRunsYet`, `noActiveRunsAllQuiet`, `bridgeDisconnected`, `showingLastKnownState`, `reconnectedReplayingMissedEvents`. Canonical copy tone:

| State key | English | Chinese |
| --- | --- | --- |
| `firstRunNoRunsYet` | `No active sessions` | `当前没有活动会话` |
| `noActiveRunsAllQuiet` | `All quiet` | `当前已空闲` |
| `bridgeDisconnected` | `Connection lost — showing last known state from HH:MM` | (localized equivalent) |
| `showingLastKnownState` | (stale banner, see §5.6) | (localized equivalent) |
| `reconnectedReplayingMissedEvents` | `Back to normal — updates resumed` | (localized equivalent) |

### 6.1 Empty states

- `right-dock`: `No active sessions` with the last bridge sync time; optionally a collapsed `Recent completed` section.
- `workbench`: first-run explains that there are no active sessions and whether the system is connected, with optional `Recent sessions`; `All quiet` provides a recent-completed overview and retains filter/history entry points so the screen never "looks broken."
- `wallboard`: an empty/idle board still shows the connection state and a legible idle marker; it does not animate activity that does not exist.

### 6.2 Disconnected states

See §5.6. All three modes show the explicit disconnected banner with last-known-state time and retain prior content with grayed/frozen treatment.

### 6.3 Recovered states

- On reconnect, the UI shows `Back to normal — updates resumed` and replays/reconciles missed events against the last cursor.
- Recovered state is distinguished from steady "running" so the user can tell a catch-up just happened (e.g. `Catching up / 正在追上最新状态`).

---

## 7. Coexistence rules

The three modes are observation distances, not mutually exclusive screens.

- `right-dock` + `workbench` MAY coexist. `workbench` is the default main window; `right-dock` is an optional companion.
  - **Shared across windows:** `connectionState`, `locale`, `theme`, `reducedMotion`, `bridgeHealth`.
  - **Not shared (per-window):** `selectedRun`, `selectedTask`, `followLive`, `localExpansion`, `scrollPosition`.
- `wallboard` is an independent observation window (recommended fullscreen or second monitor).
  - It reads only global run state and the event stream.
  - It MUST NOT preempt the local selection state of `right-dock` / `workbench`.
- All coexisting windows fan out internally from the single bridge connection (see §2); they do not each connect to the bridge.
- Mode-switch entry points MUST be discoverable in the UI (not "documented but unreachable"): `workbenchDisplayMenu` (workbench top Display menu), `trayOrMenuBar` (system tray / menu bar entry), `dockSettingsMenu` (`right-dock` header or footer settings menu).

---

## 8. Contract sections mirrored by the schema / TS types

The JSON Schema is the machine-readable mirror of these sections; the desktop app's display TS types are the compile-time mirror consumed by the UI. Both MUST use the canonical IDs and the enum literals defined here verbatim, and both MUST mirror the root structure defined in §3 (`schemaVersion`, `schema`, `shared`, `modes`, `coexistence`, `deferredCapabilities`). Each subsection below is a contract section with its descriptor shape.

### 8.1 Mode descriptors

The schema MUST define one $def per canonical ID — `right-dock`, `workbench`, `wallboard` — and the `modes` object MUST require exactly these three keys; no others are valid in v1. Each mode descriptor (`ModeDescriptor` in the TS) declares:

- `id` — the canonical machine ID, a per-mode const (`right-dock` | `workbench` | `wallboard`).
- `name` — the canonical human display name, a per-mode const (`Side Monitor` | `Workbench` | `Wallboard`).
- `role` — enum `companion` | `primary` | `showcase` (`right-dock` = `companion`, `workbench` = `primary`, `wallboard` = `showcase`).
- `isDefault` — boolean const; `workbench` is `true`, the others `false`.
- `designAlias` — the "Mode 1 / Mode 2 / Mode 3" design alias (TS only; `mode-1` | `mode-2` | `mode-3`).

The `name` and `designAlias` are labels for copy, docs, and UI; only `id` is the machine identifier used as a `modes` key, `id` value, or telemetry tag. The design alias MUST NOT be used as a machine ID. The default primary mode is consistent across two places — the per-mode `isDefault` flag and the coexistence-level `defaultPrimaryMode = workbench` — and the two MUST agree. The schema and TS MUST enumerate exactly these three canonical IDs and no others.

### 8.2 Layout constraints

Per-mode geometric constraints, expressed as declarative values (not pixel-imperative prose):

- `right-dock`: rail width `48px` (collapsed); expanded width default `360px`, min `300px`, max `400px`, persisted. (Authoritative range; the design draft's `320–360px` suggestion is superseded — see §4.1.)
- `workbench`: header `~32px`, health ribbon `~24px`, footer `~20px`; left `240px`, center `1fr`, right `260px`; breakpoints at ~980px (right → tab) and ~820px (single column); default window `1100–1280 × 720`.
- `wallboard`: stage proportions on two independent axes (see §4.3) — vertical height bands Command Bar ~7%, Hero ~15%, Body ~74%, bottom ribbon ~4%; horizontal body-width split left ~22%, center ~48%, right ~30% (sums to ~100% of the body, not of the viewport); degradation breakpoints at ~1280px and ~980px (see §8.6).

### 8.3 Panel-expansion behavior

Declarative expansion policy per mode:

- `right-dock`: default-expanded = most-recent active/running/blocked session; subagents collapsed by default; collapsing a session collapses its subagents; new events refresh dot + timestamp only (no force-expand); auto-expand policy enum `never` | `selectedSessionOnly` (default) | `anyFailedOrBlocked`.
- `workbench`: selected run/task is sticky (never auto-reclaimed); `Follow live` explicit; `Jump to latest` on manual scroll-back; center column segments Run Header → Task Table → Selected Task Inspection.
- `wallboard`: no user expansion model in v1 (read-only board); panel visibility follows degradation rules.
- `right-dock` group summary must appear before individual task rows, and expansion must remain bounded at any concurrency.
- `workbench` Task Table virtualization and filter state are part of the contract, not an implementation detail.
- `wallboard` visibility changes are driven by density clustering and degradation, not by a hard-coded task-count cutoff.

### 8.4 Notification policy

- `right-dock`: taskbar/Dock badge count; system notifications restricted to failed / blocked / waiting-on-user (filter tokens `failed` | `blocked` | `waitingOnUser`); optional subtle sound, default off.
- `workbench`: in-app region-level alerts; no system notifications by default; errors degrade a region, not the page.
- `wallboard`: alert rail + event ticker for high-priority items; no desktop system notifications.
- The `right-dock` badge count is the **attention-needed task count**, not the number of runs.

### 8.5 Freshness thresholds

- Staleness is computed from `stalenessMs` vs the run's stale threshold (`STALE` classification). The threshold source and the freshness indicator are shared single-source utilities across all modes.
- The `STALE` / `ACTIVE` / `BLOCKED` / `FAILED` / `DONE_TOTAL` Health Ribbon metrics MUST declare their value provenance — which view-model field each is derived from — before implementation. This provenance is recorded in the mirrors (schema `healthRibbonMetric.derivedFrom`, TS `DesktopHealthRibbon.provenance`). Metric tokens match the schema `healthRibbonMetricIdEnum` / TS `DesktopHealthRibbonMetric` exactly; note `DONE_TOTAL`, not `DONE / TOTAL` or `DONE-TOTAL`.
- `staleThresholdMs` is the producer-provided threshold source. Modes must not introduce their own hidden stale cutoff.
- `ACTIVE` / `STALE` metrics must be derived from producer fields, not inferred from animation state. `summary-only` tasks are excluded from heartbeat-only stale classification.

### 8.6 Wallboard degradation rules

`wallboard` v1 degradation, declarative:

- Below ~1280px width: center swarm shrinks; left/right columns become tabs; particle layer off.
- Below ~980px width: abandon wallboard layout; recommend switching to `workbench`.
- Performance budget (recorded as constraints): target 60fps sustained, 30fps acceptable after degradation; agent-count clustering threshold; canvas node/particle cap; long-run memory-leak monitoring.
- Reduced-motion path (§5.3): static conductor core, no particles/drift/orbit, hero metrics still update, event ticker as static list, node state via brightness/border/text only.
- Failure theater (bounded): problem nodes shift cool → warm amber with non-color signals (border change, text label, ticker entry); central core dims and draws a thin thread to the problem node. Forbidden: red-screen alarms, full-screen flashing, color-only changes, bare `Awaiting direction.` without context.
- v1 honesty boundary: the deferred visual effects `conductorSweep` (Conductor Sweep), `handoffRibbon` (Handoff Ribbon), and `tokenRiver` (Token River) are NOT rendered in v1 because the view model cannot substantiate them. They are reserved for v2, gated on the main plugin adding the corresponding schema fields (deferred capabilities such as `agentToAgentHandoffEdges`, `controllerToAgentTopology`, `serverProvidedTokenRate` / `serverProvidedThroughputRate`, etc.).
- In high-density situations, wallboard degrades by grouping and clustering first: `runtime -> workerType -> session cluster -> individual task`. It must never imply a fake topology or fake handoff edge just to stay visually full.

---

## 9. Normative references

- `docs/desktop-integration-handoff.md` — transport contract (discovery, HTTP, SSE, error tiers, TS types).
- `schemas/desktop-status.schema.json` — `scp.run-view/v1` view model and its `taskView`, `eventView`, `tokenEvidence` definitions.
- `subagent-monitor-desktop/src/types/models.ts` — transport view-model types (`ScpRunView`, `ScpTaskView`, `ScpActiveTask`, `ScpEventView`, `ScpTokenEvidence`, …) referenced by this contract; the bridge between the run-view schema and the desktop display types.
- `subagent-monitor-desktop/docs/display-modes-design.md` — design exploration (non-normative; this document supersedes it on conflict, including its `320–360px` Mode 1 width suggestion and any `mode-1`/`mode-2`/`mode-3` machine-ID usage).

## 10. Implementation order (non-normative)

For implementers: build `workbench` first (validates data mapping, list density, drilldown, empty/disconnected states), then `right-dock` (reuses formatting, status mapping, drilldown; adds window form + peripheral alerts), then `wallboard` v1 (current contract only), deferring `wallboard` v2 until the main plugin extends the schema.
