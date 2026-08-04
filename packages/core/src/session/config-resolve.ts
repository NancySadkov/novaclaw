// The agent-OS config-inheritance keystone (see `architecture.md`). PURE + dependency-free so
// the merge algebra is unit-tested without a DB. The effectful "walk the parent chain" step
// (fetch `[root … session]` via `parentID`) lives in the runner and just feeds the chain here.
//
// Rule: `undefined` on a field means **inherit** (from the parent, or the global default at the
// root); a set value **overrides**. Two fields are special:
//   - permissionMode NARROWS: the root session sets it freely (it defines the ceiling for its
//     subtree), but every deeper session can only make it MORE restrictive — never escalate past
//     its parent. This one invariant is what makes spawn and privilege self-revocation safe.
//   - permissionRules ACCUMULATE down the chain (the evaluator is deny-wins, so more rules can
//     only add restrictions).

import { Effect } from "effect"

export type PermissionMode = "plan" | "ask" | "surgical" | "bypass" | "yolo"

// Ranked by escalating autonomous capability (plan = none … yolo = everything, incl. outside the
// project). Lower rank = more restrictive. (1K may refine the exact set; the narrowing invariant
// is what matters here.)
const MODE_RANK: Record<PermissionMode, number> = { plan: 0, ask: 1, surgical: 2, bypass: 3, yolo: 4 }

/** The more restrictive (lower-rank) of two modes — a child can never gain capability. */
export const moreRestrictive = (a: PermissionMode, b: PermissionMode): PermissionMode =>
  MODE_RANK[a] <= MODE_RANK[b] ? a : b

/**
 * "Ask before every change" — ONE consent overlay, consumed from the two places that must never
 * drift: `MODE_RULES.ask` below (the legacy `ask` MODE) and the Tuning switch's feature rule in
 * `permission.ts` (`resolved.askBeforeChanges`).
 *
 * ⚠️ These were two byte-identical array literals with nothing linking them — exactly the defect
 * class standing decision 2 names: a claim about code in ANOTHER file ("these two lists are the
 * same") that compiles green the moment it stops being true. The switch is what the mode BECAME
 * (the same story as `surgical` → "Edits instead of overwriting"), so a row added to one and not
 * the other forks the two surfaces into a fresh false promise. One constant makes the drift
 * unrepresentable; `permission-modes.test.ts` pins the identity, and `test/permission.test.ts`
 * drives the live evaluator FROM this list, so a row added here must be honoured end to end.
 *
 * ⚠️ `bash` is a row here, and the i18n copy it implements ("…and before it runs a shell command")
 * is a promise about EXECUTION, not about the tool that happens to be named `bash`. A tool that
 * starts a host process under some OTHER action name is not covered by this list and never can be —
 * the fix is for that tool to assert `bash` on the command it is about to run. `quality_provision`
 * shipped without doing so and executed model-supplied commands straight past this overlay; it now
 * asserts per command (`tool/quality-provision.ts`).
 */
export const ASK_BEFORE_CHANGES_RULES: readonly PermissionRule[] = [
  { action: "edit", resource: "*", effect: "ask" },
  { action: "write", resource: "*", effect: "ask" },
  { action: "create", resource: "*", effect: "ask" },
  { action: "trash", resource: "*", effect: "ask" },
  { action: "bash", resource: "*", effect: "ask" },
]

/**
 * 1K: the rule overlay each permission MODE contributes at evaluation time. Appended AFTER the
 * agent's configured rules (last-match-wins), so the user's explicit mode outranks agent defaults —
 * but scoped to the mutation/exec cluster only, so agent-level gating of non-file actions
 * (question, plan_exit, …) is never overridden. `ask` sends the mutation/exec cluster through
 * consent — the Settings copy promises "'Ask' checks with you first", and with the default
 * agent's allow-all baseline an identity overlay silently made Ask ≡ Bypass (issues.md P1);
 * saved allow-always decisions land AFTER the overlay, so granted trust still quiets the asks.
 * External-directory WRITES stay ask in every mode except yolo — bypass is "anything
 * INSIDE the project". External reads are mode-independent and allowed by the evaluator. Mode
 * denies are HARD: they participate in the early deny check, so a
 * saved allow-always can never override plan/surgical.
 *
 * ⚠️ WHAT A MODE OVERLAY IS, AND WHAT NOW BACKS IT — read this before trusting a deny below. Every
 * rule here names its action LITERALLY, and that has not changed: an agent-defined ad-hoc tool
 * (`tool/define-tool.ts`) asserts under its OWN tool name, chosen at runtime by the model, so no
 * overlay written ahead of time can possibly mention it. The list is still an enumeration.
 *
 * ✅ What changed (v0.2.0 B4c, landed): the FALL-THROUGH. The agent baseline used to open with a
 * catch-all `{ action: "*", resource: "*", effect: "allow" }`, so an action absent from a mode's
 * list was ALLOWED in that mode — the list was an enumeration with nothing behind it. That line is
 * gone; `plugin/agent.ts` now opens with `PermissionV2.AMBIENT_SAFE_BASELINE`, an explicit
 * allowlist, and anything it does not name reaches `evaluate`'s `ask` default. So an action nobody
 * ruled on is now a consent card rather than a silent grant, and reading the denies below as
 * "these named actions are refused, and the unnamed ones are asked about" is finally accurate.
 * The inversion is pinned by `test/permission-baseline.test.ts` (no built-in agent may carry a
 * catch-all allow) and by the now-inverted "ad-hoc-tool hole" test in `permission-modes.test.ts`.
 */
export const MODE_RULES: Record<PermissionMode, readonly PermissionRule[]> = {
  plan: [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "write", resource: "*", effect: "deny" },
    { action: "create", resource: "*", effect: "deny" },
    { action: "trash", resource: "*", effect: "deny" },
    { action: "external_directory_write", resource: "*", effect: "deny" },
    // "Read only" has to MEAN read only. `bash` and `js` are arbitrary EXECUTION, not reads — a
    // shell command is `rm -rf` away from destroying the project the user asked us only to look
    // at, and `js` evaluates code the same way. Without these two rules the agent baseline's
    // catch-all `* → allow` (plugin/agent.ts) wins for both, so Analyze advertised "Read only"
    // while permitting the single most destructive thing in the tool set.
    //
    // Why a BLANKET deny and not a read-only command allowlist: for `bash` the `resource` is the
    // raw command STRING, and matching it is prompt-reduction, never containment (the boundary
    // note above `evaluate` in permission.ts, and `util/wildcard.ts`). An allowlist would restore
    // exactly the false promise this rule exists to end. A user who needs to run something
    // switches to Build — that is what the mode picker is for.
    { action: "bash", resource: "*", effect: "deny" },
    { action: "js", resource: "*", effect: "deny" },
    // The same false promise from two more directions. Neither action is spelled `write` or
    // `bash`, so both fell through to the agent baseline's catch-all `* → allow` exactly as
    // execution did — a mode advertised as "Read only" that mutated the host under a different
    // noun.
    //
    //   `provision` (the `quality_provision` tool) is an EXECUTION channel wearing a config
    //   name: it runs every candidate quality command — including ones the MODEL supplies via
    //   its `commands` input — through the agent shell with a 90 s timeout, and it asserts under
    //   `provision`, never under `bash`. Denying `bash` above while leaving this open hands the
    //   shell straight back through a second door. It then PERSISTS the resolved commands into
    //   the instance settings store, which is a durable host mutation in its own right.
    //
    //   `revert` restores working-tree files from a git snapshot. It never calls itself a write,
    //   but replacing a file with an older copy of itself is a destructive write by any other
    //   name — and with the mutation cluster already denied it was the ONE working-tree change
    //   an Analyze session could still reach.
    //
    // Neither can legitimately touch Analyze's report carve-out (permission.ts, REPORT_RESOURCE),
    // so neither needs an exemption there: `revert`'s resources are project-relative paths from a
    // snapshot diff, and `provision`'s are `key: command` strings that are not paths at all. The
    // carve-out is action-scoped to create/write/edit/external_directory_write regardless.
    { action: "provision", resource: "*", effect: "deny" },
    { action: "revert", resource: "*", effect: "deny" },
  ],
  // NOT a copy of the switch's rules — the SAME array (see ASK_BEFORE_CHANGES_RULES above). The
  // mode and the Tuning switch are one promise wearing two surfaces; they cannot be allowed to
  // disagree, and the only way to guarantee that is to have one list.
  ask: ASK_BEFORE_CHANGES_RULES,
  // Surgical: precise edits + new files stay possible; regenerating a whole existing file is not.
  // ⚠️ It deliberately does NOT deny `bash`/`js`, unlike `plan` above. Surgical is a rule about the
  // SHAPE of a write, not a posture — it never promised read-only, and it is no longer offered in
  // the mode picker at all: it became the Tuning switch "Edits instead of overwriting", whose
  // feature rule (permission.ts, `resolved.surgicalEdits`) is this exact single deny. Adding an
  // execution deny here would fork the two surfaces — picking the legacy mode would kill bash while
  // ticking the switch would not — which is a fresh false promise, not a fix for one. Pinned by
  // `permission-modes.test.ts`.
  surgical: [{ action: "write", resource: "*", effect: "deny" }],
  bypass: [
    { action: "edit", resource: "*", effect: "allow" },
    { action: "write", resource: "*", effect: "allow" },
    { action: "create", resource: "*", effect: "allow" },
    { action: "trash", resource: "*", effect: "allow" },
    { action: "bash", resource: "*", effect: "allow" },
  ],
  yolo: [
    { action: "edit", resource: "*", effect: "allow" },
    { action: "write", resource: "*", effect: "allow" },
    { action: "create", resource: "*", effect: "allow" },
    { action: "trash", resource: "*", effect: "allow" },
    { action: "bash", resource: "*", effect: "allow" },
    { action: "external_directory_write", resource: "*", effect: "allow" },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// The UNATTENDED CONFINEMENT stance (deny-fast).
//
// An ask is a QUESTION, and a question nobody is present to answer is a HANG, not a gate: a
// queued recipe cook was measured sitting on three pending `bash` asks with the run looking
// alive and doing nothing — indistinguishable from progress. So for an unattended chain the
// honest answer to "may I touch something outside my folder?" is NO, delivered IMMEDIATELY as a
// legible tool error the model can route around (see `PermissionV2.denialMessage`) — never a
// pending card, and never a silent no-op.
//
// WHERE THE SWITCH LIVES: nowhere new. Both halves already exist and already compose.
//   1. Attendance is a property of the chain ROOT (`attendedRoot`, the Agent Jail doctrine) —
//      switchable per chat by the composer's Mode control, per schedule by the Calendar, and per
//      spawn by `SessionSpawner`.
//   2. The escape hatch is already a permission MODE: `yolo` is the ONE mode whose overlay ALLOWS
//      external WRITES outright (MODE_RULES above) — the documented "everything, incl. outside
//      the project". Reads are available in every mode and are not part of this stance.
// So the stance is exactly "unattended root AND mode below yolo". No new mode, no new session
// column, no new client vocabulary — and it COMPOSES with the narrowing invariant instead of
// bypassing it: a spawned child can never reach `yolo` past a lower parent (`moreRestrictive`
// clamps it), so a sub-session can never escape the stance its root chose. The intended
// unattended posture is therefore `bypass` — act freely INSIDE the work folder, hard-denied
// outside it — which is exactly what the Calendar already defaults a schedule to.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The chain ROOT's attendance answer — THREE-valued, for exactly the reason `HostExec.Hostility`
 * is (`host-exec.ts`, 2026-07-28):
 *
 *  · a `SessionType` — the walk reached a session that declares no parent, and THAT root's type
 *                      is this (a root row carrying no `type` still counts as read: `undefined`
 *                      means inherit, and at the root that is the global default);
 *  · `"unknown"`     — a chain that EXISTS could not be followed to its root: a `parentID` points
 *                      at a row that is gone, or the parent links form a cycle. We asked and the
 *                      answer faulted.
 *
 * ⚠️ Why the type had to grow, measured before the change (2026-07-28, this file's own walk):
 * every chain fault answered `"interactive"` or the deepest KNOWN layer's type, and **those are the
 * permissive answers** — `attendedRoot` is true for `interactive`/`sub-agent`, so
 * `unattendedStanceRules` returns `[]` and `AgentJail.decideBash` returns `"raw"`. Observed:
 * a `sub-agent` row whose parent had vanished → `"sub-agent"`, stance `[]`; a CYCLE of two
 * `auto-prompting` rows → `"interactive"`, stance `[]` — a chain every row of which says "nobody
 * is watching" bought the operator's full host authority. That is a containment decision made on
 * missing data, which is what ruling 2 forbids ("a fault is never described falsely"). A
 * four-member enum has nowhere to put *we could not find out*, so no amount of care at the call
 * sites could have fixed it; the file's own tests asserted the hole as intended behaviour ("both
 * fail OPEN to interactive").
 *
 * ⚠️ What is deliberately NOT `"unknown"`: a `sessionID` that names no row AT ALL. That is the
 * `undefined`-shaped fact, not the `"unknown"`-shaped one, and `HostExec.decide` already rules on
 * exactly this distinction in this codebase — *"a caller that never asked the trust question passes
 * `undefined`, while one that asked and could not be answered passes `\"unknown\"`. The first has
 * declared nothing; the second has declared a fault. Only the second is a containment question left
 * open."* There is no chain to be wrong about when there is no session, and the seam that can
 * observe the discrepancy already refuses on it: `PermissionV2` fails `Session.NotFoundError` for a
 * missing target row before any allow is reached (measured, and pinned in `test/permission.test.ts`).
 * See the walk below for the residual this leaves at `tool/bash.ts` and how it closes.
 *
 * ⚠️ Why `SessionType | "unknown"` rather than a wrapper object. The one property that must be
 * MECHANICAL is that this answer cannot be assigned into a `SessionType` slot — which this union
 * enforces — while every existing value keeps meaning exactly what it meant at ~20 call sites and
 * on the wire (`session.type` is a stored column). Renaming a correct vocabulary buys nothing.
 */
export type RootType = SessionType | "unknown"

/**
 * What an unreadable chain is TREATED as by a consumer that can only speak `SessionType`.
 * `goal-oriented` is the unattended end of the enum, so such a consumer contains rather than
 * permits. It is a constant so the negative control in `config-resolve.test.ts` can flip it and
 * watch the decision invert.
 */
const UNREADABLE_CHAIN_ROOT_TYPE: SessionType = "goal-oriented"

/**
 * THE ONE collapse point — the single place `"unknown"` turns into anything else, so *"an
 * attendance question we could not answer is not a licence to run raw"* is one decision rather
 * than a habit repeated at each call site. Same role `HostExec.takesUnattendedArm` plays for the
 * hostility tri-state, and deliberately the same shape (ruling 6).
 *
 * `attendedRoot` below is defined THROUGH it rather than beside it, so there is no second place to
 * keep in sync.
 */
export const narrowRootType = (rootType: RootType): SessionType =>
  rootType === "unknown" ? UNREADABLE_CHAIN_ROOT_TYPE : rootType

/**
 * Attendance is a property of the chain ROOT — the question is who answers (Agent Jail P0b).
 * Children of an interactive root surface asks to a human (attention pills); under an
 * auto-prompting or goal-oriented root there is nobody to reply. Canonical home: this pure
 * config module, so the permission evaluator and `AgentJail` share ONE predicate.
 *
 * Takes `RootType`, not `SessionType`: an unreadable chain is NOT attended, because "somebody is
 * present to answer" is a claim, and we just failed to establish it. Widening the parameter is
 * source-compatible for every existing caller (a `SessionType` is a `RootType`).
 */
export const attendedRoot = (rootType: RootType): boolean => {
  const known = narrowRootType(rootType)
  return known === "interactive" || known === "sub-agent"
}

/**
 * The rule overlay an unattended chain contributes. `external_directory_write` is the requirement:
 * every mutating tool (write/edit/create/apply-patch/trash/bash-workdir) asserts it BEFORE its own
 * action whenever the resolved path leaves the Location (`LocationMutation.externalDirectoryPermission`),
 * so denying it here denies out-of-folder create/modify at the one seam they all pass through.
 * External reads are deliberately absent: they are host-wide in every permission mode.
 * Nothing INSIDE the folder appears here — no `read`/`edit`/`write`/`create`/`trash`/`bash` rule —
 * which is the whole point of the stance: work freely where you live.
 *
 * ⚠️ AND `bash` IS STILL NOT IN THIS LIST, which matters more since 2026-07-30 than it did before.
 * These rules bound the tools whose resource is a PATH; `bash`'s resource is the command STRING, and
 * `permission.ts` says in its own words that matching one is not containment. So an unattended
 * command that now runs raw (the owner's reversal — see `AgentJail.decideBash`) can write outside
 * the folder without any rule here seeing it. That gap is not new and it is not closed by adding a
 * row here; it is what the project-scope system-prompt section
 * (`session/runner/system-compose.ts`) and, in v0.3.0, a real Windows/macOS backend are for. Naming
 * it is ruling 2 applied to our own documentation: the stance denies out-of-folder writes through
 * every seam that can see a path, and no others.
 */
export const UNATTENDED_CONFINED_RULES: readonly PermissionRule[] = [
  { action: "external_directory_write", resource: "*", effect: "deny" },
]

/**
 * The stance's rules for a chain, or none when it does not apply. `rootType` is the CHAIN ROOT's
 * answer (`rootAttendance`), never the target session's own type — a child cannot declare itself
 * attended out of its root's stance. `mode` is the RESOLVED mode (already clamped by narrowing).
 *
 * `RootType`, so `"unknown"` reaches the stance intact and gets the confined arm via `attendedRoot`
 * — the ONE collapse point above.
 */
export const unattendedStanceRules = (rootType: RootType, mode: PermissionMode): readonly PermissionRule[] =>
  attendedRoot(rootType) || mode === "yolo" ? [] : UNATTENDED_CONFINED_RULES

export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/** The Vision's typed threads: how a session decides whether to keep running (K1). */
export type SessionType = "interactive" | "sub-agent" | "auto-prompting" | "goal-oriented"

/** B10: who answers on our side — Nova (AI, default) or a human operator who took control. */
export type Responder = "nova" | "operator"

export interface PermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

/** The per-session Strict-harness override (the composer's Strict switch — jh.md). Overrides the
 *  global `config.strict` for this session's turns; `undefined` = inherit (parent, then global). */
export interface StrictOverride {
  readonly enabled?: boolean
  readonly attempts?: number
  readonly wallMinutes?: number
}

/** A session's on-record config OVERRIDES. Every field optional — `undefined` = inherit. */
export interface SessionConfig {
  readonly device?: string
  readonly model?: ModelRef
  readonly agent?: string
  readonly systemPromptOverride?: string
  readonly type?: SessionType
  readonly priority?: number
  readonly responder?: Responder
  readonly permissionMode?: PermissionMode
  readonly permissionRules?: readonly PermissionRule[]
  readonly introspection?: boolean
  readonly quality?: boolean
  readonly affective?: boolean
  /** Tri-state: enforce the model's reasoning budget in this chat. Absent = inherit, then the model's own. */
  readonly thinkingBudget?: boolean
  /** Tri-state: deny full-file overwrites (edit in place instead). Absent = inherit, then OFF. */
  readonly surgicalEdits?: boolean
  /** Tri-state: turn changes into consent prompts. Absent = inherit, then OFF. */
  readonly askBeforeChanges?: boolean
  /** Tri-state: SAFE MODE — see `SAFE_MODE` below. Absent = inherit, then OFF. */
  readonly safeMode?: boolean
  /** Tri-state: enforce typed context shares in this chat. Absent = inherit, then the instance Tune. */
  readonly contextBudget?: boolean
  readonly strict?: StrictOverride
  readonly tools?: readonly string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// SAFE MODE — the Tuning switch that restores unattended confinement (owner 2026-07-30).
//
// The directive, verbatim: *"unattended bash should be allowed by default, unless the user have
// enabled safe mode in tuning."* So the switch is the opt-in half of a deliberate trade, and its
// meaning is exactly the arm the directive loosened and no more:
//
//   ON  → an UNATTENDED chain's host execution must be sandbox-confined, and on a host with no
//         sandbox backend it is REFUSED rather than run raw (`AgentJail.decideBash`).
//   OFF → the default: it runs. Confined where a backend exists, raw where none does.
//
// ⚠️ THREE things it deliberately is NOT, each of which someone will be tempted to add:
//  · it is not a second attendance flag — an ATTENDED chain is unaffected in both positions. The
//    "confine bash in EVERY non-YOLO mode, attended included" item (todo/jail.md) needs the MODE as
//    an input to `decideBash`, which is a reshape, not this switch;
//  · it does not gate reads — host-readable files are available in every permission mode. Safe
//    mode is per-session and gates host EXECUTION;
//  · it can never LOOSEN anything. Every arm it reaches is a refusal, which is why it composes with
//    the narrowing keystone without needing a clamp of its own (unlike `permissionMode`).
//
// It follows the `surgicalEdits`/`askBeforeChanges` shape exactly — a tri-state `SessionConfig`
// field, `undefined` = inherit, the nearest explicit stance on the chain wins — because those two
// ARE the precedent: both are former postures demoted to switches, and a fourth mechanism for a
// fourth switch is how the mode picker got forked into two disagreeing surfaces before.
//
// ✅ USER-SETTABLE since 2026-07-31, and `SESSION_CONFIG_FIELDS` below says so mechanically rather
// than in prose: it is classified `"resolved"`, which is only legitimate while `sessionToConfig`
// genuinely maps it. The whole chain landed together, in this order: `session/sql.ts` (the
// `safe_mode` column) → `20260730221834_add_session_safe_mode` + `database/schema.gen.ts` +
// `schema.json` → `session/info.ts` + `session/projector.ts` (row ⇄ Info, and the `switchFeature`
// arm) → `session.ts` (`CreateInput`, the `switchFeature` union, the fork's inherited set) →
// `@novaclaw/schema`'s `Session.Info` + `SessionFeature.Name` → the composer's Tuning control + i18n.
// `session-fork-config.test.ts` enforces the equivalence (`"resolved"` ⇔ `sessionToConfig` maps it)
// and `session-safe-mode.test.ts` pins the rest, so a half-landed chain fails rather than compiling.
//
// ⚠️ WHY IT CLOSED A RULING-2 VIOLATION, not merely a gap. `agent-jail.ts`'s `denyMessage` told the
// user to *"Turn Safe mode off in this chat's Tuning controls"* while `safeMode` had ZERO matches in
// `packages/app` — the product named a control that did not exist, which is *a fault described
// falsely*. That is why the surface half of this chain is not optional polish: the deny text is only
// true because the switch is on the panel.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The base effective config before any session override. `model`/`agent`/`device` are left
 * undefined so the runner's existing catalog/agent fallbacks still apply; permission mode + the
 * mode toggles carry safe defaults. Used as the root of the resolution chain.
 */
export const EFFECTIVE_CONFIG_DEFAULTS: EffectiveConfig = {
  type: "interactive",
  priority: 0,
  responder: "nova",
  // Write access to the session's OWN folder by default (owner 2026-07-25). Writing outside it is
  // guarded independently of the mode, so the trust is scoped to the folder, not global.
  permissionMode: "bypass",
  permissionRules: [],
}

/** The fully-resolved config a session actually runs with. */
export interface EffectiveConfig {
  readonly device?: string
  readonly model?: ModelRef
  readonly agent?: string
  readonly systemPromptOverride?: string
  readonly type: SessionType
  readonly priority: number
  readonly responder: Responder
  readonly permissionMode: PermissionMode
  readonly permissionRules: readonly PermissionRule[]
  /** Harness-feature stances (tri-state): the nearest explicit true/false on the chain wins;
   *  `undefined` = no per-session stance — the runner falls back to the global config block. */
  readonly introspection?: boolean
  readonly quality?: boolean
  readonly affective?: boolean
  /** Tri-state: enforce the model's reasoning budget in this chat. Absent = inherit, then the model's own. */
  readonly thinkingBudget?: boolean
  /** Tri-state: deny full-file overwrites (edit in place instead). Absent = inherit, then OFF. */
  readonly surgicalEdits?: boolean
  /** Tri-state: turn changes into consent prompts. Absent = inherit, then OFF. */
  readonly askBeforeChanges?: boolean
  /** Tri-state: SAFE MODE — restore unattended host-execution confinement (see §SAFE MODE above).
   *  Absent = inherit, then OFF (the default posture: unattended commands run). */
  readonly safeMode?: boolean
  /** Tri-state: enforce typed context shares in this chat. Absent = inherit, then the instance Tune. */
  readonly contextBudget?: boolean
  /** The nearest per-session Strict override on the chain; `undefined` = none (use global config). */
  readonly strict?: StrictOverride
  readonly tools?: readonly string[]
}

/**
 * Resolve the effective config for a session from the global `defaults` and the `chain` of
 * `SessionConfig` overrides ordered **root-first** (`[rootSession, …, targetSession]`).
 */
export function resolveConfig(defaults: EffectiveConfig, chain: readonly SessionConfig[]): EffectiveConfig {
  let device = defaults.device
  let model = defaults.model
  let agent = defaults.agent
  let systemPromptOverride = defaults.systemPromptOverride
  let type = defaults.type
  let priority = defaults.priority
  let responder = defaults.responder
  let introspection = defaults.introspection
  let quality = defaults.quality
  let affective = defaults.affective
  let thinkingBudget = defaults.thinkingBudget
  let surgicalEdits = defaults.surgicalEdits
  let askBeforeChanges = defaults.askBeforeChanges
  let safeMode = defaults.safeMode
  let contextBudget = defaults.contextBudget
  let strict = defaults.strict
  let tools = defaults.tools
  let permissionMode = defaults.permissionMode
  let permissionRules: readonly PermissionRule[] = defaults.permissionRules

  chain.forEach((layer, index) => {
    if (layer.device !== undefined) device = layer.device
    if (layer.model !== undefined) model = layer.model
    if (layer.agent !== undefined) agent = layer.agent
    if (layer.systemPromptOverride !== undefined) systemPromptOverride = layer.systemPromptOverride
    if (layer.type !== undefined) type = layer.type
    if (layer.priority !== undefined) priority = layer.priority
    if (layer.responder !== undefined) responder = layer.responder
    if (layer.introspection !== undefined) introspection = layer.introspection
    if (layer.quality !== undefined) quality = layer.quality
    if (layer.affective !== undefined) affective = layer.affective
    if (layer.thinkingBudget !== undefined) thinkingBudget = layer.thinkingBudget
    if (layer.surgicalEdits !== undefined) surgicalEdits = layer.surgicalEdits
    if (layer.askBeforeChanges !== undefined) askBeforeChanges = layer.askBeforeChanges
    if (layer.safeMode !== undefined) safeMode = layer.safeMode
    if (layer.contextBudget !== undefined) contextBudget = layer.contextBudget
    if (layer.strict !== undefined) strict = layer.strict
    if (layer.tools !== undefined) tools = layer.tools
    if (layer.permissionRules !== undefined) permissionRules = [...permissionRules, ...layer.permissionRules]
    if (layer.permissionMode !== undefined) {
      // Root sets freely; deeper sessions can only narrow (never escalate past the parent).
      permissionMode = index === 0 ? layer.permissionMode : moreRestrictive(permissionMode, layer.permissionMode)
    }
  })

  return {
    device,
    model,
    agent,
    systemPromptOverride,
    type,
    priority,
    responder,
    permissionMode,
    permissionRules,
    introspection,
    quality,
    affective,
    thinkingBudget,
    surgicalEdits,
    askBeforeChanges,
    safeMode,
    contextBudget,
    strict,
    tools,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The effectful walk (1b). Additive — not yet called by the runner. Fetches the
// `[root … session]` chain via `parentID` and feeds it to the pure `resolveConfig`.
// ─────────────────────────────────────────────────────────────────────────────

/** The minimal read-model the walk needs. The runner's `SessionV2.Info` is structurally a superset. */
export interface SessionLike {
  readonly id: string
  readonly parentID?: string
  readonly model?: ModelRef
  readonly agent?: string
  readonly systemPromptOverride?: string
  readonly type?: SessionType
  readonly priority?: number
  readonly responder?: Responder
  readonly permissionMode?: PermissionMode
  readonly strict?: StrictOverride
  readonly introspection?: boolean
  readonly quality?: boolean
  readonly affective?: boolean
  /** Tri-state: enforce the model's reasoning budget in this chat. Absent = inherit, then the model's own. */
  readonly thinkingBudget?: boolean
  /** Tri-state: deny full-file overwrites (edit in place instead). Absent = inherit, then OFF. */
  readonly surgicalEdits?: boolean
  /** Tri-state: turn changes into consent prompts. Absent = inherit, then OFF. */
  readonly askBeforeChanges?: boolean
  /** Tri-state: SAFE MODE — restore unattended host-execution confinement (§SAFE MODE above).
   *  Absent = inherit, then OFF. A child cannot declare itself out of an ancestor's ON: absent
   *  means inherit, and the only way to diverge is an explicit `false` the user had to set. */
  readonly safeMode?: boolean
  readonly contextBudget?: boolean
  // permissionRules / tools get mapped here as the session schema grows to carry them
  // (see architecture.md Phase 1 step 4).
}

/** Project a session record onto its config OVERRIDES (only fields it actually carries today). */
export const sessionToConfig = (session: SessionLike): SessionConfig => ({
  model: session.model,
  agent: session.agent,
  systemPromptOverride: session.systemPromptOverride,
  type: session.type,
  priority: session.priority,
  responder: session.responder,
  permissionMode: session.permissionMode,
  strict: session.strict,
  introspection: session.introspection,
  quality: session.quality,
  affective: session.affective,
  thinkingBudget: session.thinkingBudget,
  surgicalEdits: session.surgicalEdits,
  askBeforeChanges: session.askBeforeChanges,
  safeMode: session.safeMode,
  contextBudget: session.contextBudget,
})

/**
 * The `[root … session]` chain of config OVERRIDES for a session, walking `parentID` root-ward.
 * `getSession` fetches a session by id (or `undefined`). Guards against a cyclic `parentID` chain
 * so a corrupt tree can never loop forever.
 *
 * Extracted so `resolveSessionConfig` (what a TURN runs with) and `forkSessionConfig` (what a FORK
 * is seeded from) share ONE walk. They must agree by construction: ruling 8's guarantee is that a
 * fork resolves to what its source resolved to, and two walks that could drift would make that a
 * claim about code in another file — the defect class ruling 1 names.
 */
export const sessionConfigChain = <E, R>(
  sessionID: string,
  getSession: (id: string) => Effect.Effect<SessionLike | undefined, E, R>,
): Effect.Effect<SessionConfig[], E, R> =>
  Effect.gen(function* () {
    const chain: SessionConfig[] = []
    const seen = new Set<string>()
    let id: string | undefined = sessionID
    while (id !== undefined && !seen.has(id)) {
      seen.add(id)
      const session: SessionLike | undefined = yield* getSession(id)
      if (!session) break
      chain.unshift(sessionToConfig(session)) // prepend so the root ends up first
      id = session.parentID
    }
    return chain
  })

/**
 * Resolve a session's effective config by walking `parentID` root-ward and merging. `getSession`
 * fetches a session by id (or `undefined`). Guards against a cyclic `parentID` chain so a corrupt
 * tree can never loop forever.
 */
export const resolveSessionConfig = <E, R>(
  defaults: EffectiveConfig,
  sessionID: string,
  getSession: (id: string) => Effect.Effect<SessionLike | undefined, E, R>,
): Effect.Effect<EffectiveConfig, E, R> =>
  sessionConfigChain(sessionID, getSession).pipe(Effect.map((chain) => resolveConfig(defaults, chain)))

// ─────────────────────────────────────────────────────────────────────────────
// FORK — ruling 8: "`fork` copies the source's chain-RESOLVED config, never its raw row", and
// "a fork returning LESS restricted than its source is a defect, not a preference".
//
// ⚠️ WHY THE RAW ROW IS WRONG, and why the bug hid for so long. `spawn` gives the child a
// `parentID`, so everything the child does not declare is inherited by the walk above — every
// inheritance test in the tree goes through spawn, and they all pass. `fork` deliberately creates
// a ROOT (`parentID` undefined: a fork is an independent chat, not a sub-agent), so there is no
// parent left to inherit from and whatever the source's raw row does not itself carry is simply
// GONE. Measured 2026-07-29 against the then-current tree: a fork dropped `systemPromptOverride`,
// `type`, `priority`, `responder`, `thinkingBudget`, `surgicalEdits` and `askBeforeChanges`
// outright, and dropped EVERY field a child had inherited rather than declared. `type` and
// `askBeforeChanges` are restrictions, so forking a constrained session returned a less
// constrained one with no user action that reads as "loosen this".
//
// ── THE DESIGN ANSWER (materialise vs keep inheriting), stated here because the next reader
//    will face the same fork ────────────────────────────────────────────────────────────────
// A fork MATERIALISES the chain-resolved value of every field the source's chain actually
// DECLARES, and leaves every other field absent.
//
//  1. A fork is a root, so "keep inheriting" cannot mean "from my parent" — it can only mean
//     "from the global defaults". Ruling 8's "never its raw row" is exactly about the difference
//     between the row and the chain: for a forked CHILD, everything the parent contributed is
//     lost unless it is written down.
//  2. Materialising only the DECLARED set is what keeps the ECS lens' sparse-override discipline
//     (AGENTS.md: "only divergent values create rows"). A field nobody on the chain ever chose
//     stays absent on the fork's row, so the fork keeps tracking the global default exactly as
//     its source did — a future change to `EFFECTIVE_CONFIG_DEFAULTS` still reaches it. What we
//     refuse is the strong reading of "copy the resolved config", which would stamp every default
//     into the row and produce a session that inherits nothing ever again.
//  3. The narrowing keystone then holds BY CONSTRUCTION rather than by care: the fork is a root,
//     so `resolveConfig` takes its `permissionMode` at index 0 verbatim — and that value is the
//     source's ALREADY-NARROWED mode. So `resolve(fork) === resolve(source)`, field for field:
//     the fork is never less restricted, and never more.
//
// ⚠️ THE ONE BEHAVIOUR THIS CHANGES BEYOND CONFIG, named rather than discovered later. `type` has
// two consumers that read it differently: attendance walks to the chain ROOT (`rootAttendance`),
// while the self-drive reads the session's OWN row (`runner/drive.ts`). Materialising `type` is
// REQUIRED by the first — a fork is its own root, so a fork of an `auto-prompting`/`goal-oriented`
// chain that did not carry the type would come back ATTENDED, i.e. out of the unattended
// confinement stance, which is exactly the loosening ruling 8 forbids. The second then follows:
// forking a CHILD that inherited `goal-oriented` yields a root that self-drives, where the child
// itself did not. That is the right answer, not a side effect — the child did not self-drive
// because its supervisor drove it, and the fork has no supervisor; the alternative is a
// goal-oriented chat that stalls. (Forking a ROOT is unchanged either way.) `drive.ts`'s "forks
// don't silently self-drive" still holds as written: it is about an ANCESTOR's type leaking
// through the walk, and the fork's type is now its own declared value.
// ─────────────────────────────────────────────────────────────────────────────

/** How `fork` carries one `SessionConfig` field. */
export type SessionConfigForkCarry =
  /** The session row carries it (via `sessionToConfig`), so the fork gets the chain-resolved value. */
  | "resolved"
  /**
   * A `SessionConfig` field NO session row can express yet, so there is nothing on the chain to
   * copy: `device` and `tools` have no column at all, and `permissionRules` has a column
   * (`session.permission`) that `sessionToConfig` does not map — architecture.md Phase 1 step 4
   * is blocked on the V1/V2 ruleset reconciliation. The fork copies that column verbatim
   * meanwhile (see `session.ts`), which can only preserve restrictions, never widen them.
   */
  | "absent-from-row"

/**
 * Ruling 8's *"declare every `SessionConfig` field once in a `SESSION_CONFIG_FIELDS` descriptor"*,
 * in its FORK-sized first cut. The full descriptor (schema field ↔ column ↔ merge strategy, driving
 * `fromRow`/`sessionRow`/`sessionToConfig`/the resolve fold/`CreateInput`) is Wave 3's **B2**; this
 * declares the one axis `fork` needs and gives B2 a home to widen rather than a list to discover.
 *
 * ⚠️ It is a RATCHET, not documentation, and it bites from two directions:
 *  · the type annotation makes a new `SessionConfig` field a COMPILE error until it is classified;
 *  · `session-fork-config.test.ts` asserts `"resolved" ⇔ sessionToConfig maps it`, so classifying a
 *    row-carried field as `absent-from-row` to dodge the work fails a test, and it then asserts the
 *    fork actually round-trips every `"resolved"` field through a real DB.
 * Neither check repeats the field list — both read it from here.
 */
export const SESSION_CONFIG_FIELDS: Readonly<Record<keyof SessionConfig, SessionConfigForkCarry>> = {
  device: "absent-from-row",
  model: "resolved",
  agent: "resolved",
  systemPromptOverride: "resolved",
  type: "resolved",
  priority: "resolved",
  responder: "resolved",
  permissionMode: "resolved",
  permissionRules: "absent-from-row",
  introspection: "resolved",
  quality: "resolved",
  affective: "resolved",
  thinkingBudget: "resolved",
  surgicalEdits: "resolved",
  askBeforeChanges: "resolved",
  // Flipped from `absent-from-row` when the `safe_mode` column landed (2026-07-31, see §SAFE MODE).
  // It is a RESTRICTION, so this is precisely the case ruling 8 exists for: a fork of a safe-mode
  // session resolves to safe mode, because `"resolved"` puts it in `SESSION_CONFIG_FORK_FIELDS`.
  safeMode: "resolved",
  contextBudget: "resolved",
  strict: "resolved",
  tools: "absent-from-row",
}

/** Every `SessionConfig` key, read off the descriptor (never re-typed). */
export const SESSION_CONFIG_FIELD_KEYS: readonly (keyof SessionConfig)[] = Object.keys(
  SESSION_CONFIG_FIELDS,
) as (keyof SessionConfig)[]

/** The keys a fork must carry — the descriptor's `"resolved"` half. */
export const SESSION_CONFIG_FORK_FIELDS: readonly (keyof SessionConfig)[] = SESSION_CONFIG_FIELD_KEYS.filter(
  (key) => SESSION_CONFIG_FIELDS[key] === "resolved",
)

/**
 * The overrides a FORK's own row must carry, given its source's `[root … source]` chain: the
 * chain-RESOLVED value of every field some layer declared, and nothing else (see the block above).
 *
 * Resolution runs through the SAME `resolveConfig` a turn uses — including `permissionMode`
 * narrowing and `permissionRules` accumulation — so the fork cannot resolve to anything its source
 * did not.
 */
export const forkOverrides = (chain: readonly SessionConfig[]): SessionConfig => {
  const resolved = resolveConfig(EFFECTIVE_CONFIG_DEFAULTS, chain)
  const overrides: Record<string, unknown> = {}
  for (const key of SESSION_CONFIG_FORK_FIELDS) {
    // Sparse-override discipline: a field NO layer declared stays absent, so the fork keeps
    // inheriting the global default exactly as its source did.
    if (!chain.some((layer) => layer[key] !== undefined)) continue
    overrides[key] = resolved[key]
  }
  return overrides as SessionConfig
}

/** `sessionConfigChain` + `forkOverrides` — what `SessionV2.fork` seeds the new root session from. */
export const forkSessionConfig = <E, R>(
  sessionID: string,
  getSession: (id: string) => Effect.Effect<SessionLike | undefined, E, R>,
): Effect.Effect<SessionConfig, E, R> => sessionConfigChain(sessionID, getSession).pipe(Effect.map(forkOverrides))

/**
 * The chain ROOT's attendance answer — attendance is a property of who answers at the root
 * (Agent Jail P0b, notes/agent-jail-plan.md §2.1). Same root-ward walk + cycle guard as
 * `resolveSessionConfig`, but it reports the ROOT layer, not the target's resolution.
 *
 * ⚠️ A BROKEN chain is `"unknown"`, not a type (see `RootType`). The paragraph that used to stand
 * here — *"A missing/broken/cyclic chain resolves to the default 'interactive': fail-OPEN for
 * attendance is deliberate at P0"* — WAS the defect, written down as intent, and each of its two
 * justifications fails on inspection:
 *
 *  · *"the permission mode still gates every command"* — the default mode is `bypass`
 *    (`EFFECTIVE_CONFIG_DEFAULTS`), whose overlay ALLOWS edit/write/create/trash/bash on `*`. In
 *    an unattended chain the stance is the only thing left standing, and fail-open deletes it.
 *  · *"a store anomaly must not brick attended interactive turns"* — the fault that reaches here
 *    is not a store anomaly. A DB failure DIES (`SessionStore.get` is `orDie`, store.ts:36), so it
 *    never takes this path at all; what does is a session tree that genuinely has no root — a
 *    `parent_id` left dangling (the column carries NO foreign key, session/sql.ts:22, so the DB
 *    permits it), or a cycle. Answering "a human is watching" for those is a guess in the one
 *    direction that cannot be recovered from.
 *
 * The opposite over-correction is refused twice, because ruling 2 forbids a false fault in BOTH
 * directions:
 *  · a chain read END TO END still reports what it found, including a root row with no `type` of
 *    its own — that is inherit, not a fault;
 *  · a `sessionID` naming NO row is not a chain fault at all, and still answers the default. See
 *    `RootType` for the principle (nothing declared vs. a declared fault) and the residual below.
 */
export const rootAttendance = <E, R>(
  sessionID: string,
  getSession: (id: string) => Effect.Effect<SessionLike | undefined, E, R>,
): Effect.Effect<RootType, E, R> =>
  Effect.gen(function* () {
    const seen = new Set<string>()
    let id: string | undefined = sessionID
    let root: SessionLike | undefined
    while (id !== undefined && !seen.has(id)) {
      seen.add(id)
      const session: SessionLike | undefined = yield* getSession(id)
      if (!session) {
        // ⚠️ ONE missing row, TWO different faults — and they are not the same question.
        //
        // `root === undefined` means the very FIRST lookup missed: the caller named a session that
        // does not exist, so there is no chain here to be wrong about. That is the `undefined`-
        // shaped fact `HostExec.decide` already rules on ("the first has declared nothing"), and it
        // keeps the previous answer. RESIDUAL, stated rather than hidden: `tool/bash.ts` does not
        // check that its session exists, so a bash call for a vanished session still runs raw
        // there. It is near-unreachable in production (the tool runs inside that session's drain,
        // and `removeSessionRecord` INTERRUPTS before deleting, session.ts:436) and it is closed by
        // `bash.ts` refusing an unknown session the way `PermissionV2` already does — not by this
        // walk inventing an attendance. Measured 2026-07-28: answering `"unknown"` here instead
        // fails 9 of 12 `test/tool-bash.test.ts` tests, every one of which calls the bash tool with
        // no session row at all, i.e. the shape only a fixture produces.
        //
        // Deeper in, a `parentID` DANGLES: we read a session, it named a parent, and the parent is
        // gone. The root — the only layer that decides attendance — is precisely what we failed to
        // read, so the highest KNOWN layer's type is evidence about a child, not about the root. A
        // `sub-agent` child of a vanished `goal-oriented` root used to answer "attended" here.
        if (root === undefined) return EFFECTIVE_CONFIG_DEFAULTS.type
        return "unknown" as const
      }
      root = session
      // A cycle: this tree has no root to report. Reporting the default here was the worst of the
      // three — a ring of `auto-prompting` rows answered `"interactive"`.
      if (session.parentID !== undefined && seen.has(session.parentID)) return "unknown" as const
      id = session.parentID
    }
    // Only reachable via a session that declared no parent at all: a real, fully-read root.
    return root?.type ?? EFFECTIVE_CONFIG_DEFAULTS.type
  })

/**
 * The narrow adapter over the SAME walk, for the consumers that can only speak `SessionType`:
 * `HostExec`'s `rootType` field and `AgentJail.decideBash` (`tool/bash.ts`, and the Strict runner
 * via `session/runner/llm.ts`). It routes through `narrowRootType`, so an unreadable chain reaches
 * them as the UNATTENDED answer instead of the attended one — every one of those call sites goes
 * fail-closed with no edit to it.
 *
 * ⚠️ TWO residuals, named so this is not mistaken for finished:
 *  1. Those consumers refuse an unreadable chain with `AgentJail.denyMessage`'s wording, which says
 *     the chain is unattended rather than that we could not read it — ruling 2's other half, the
 *     same gap `HostExec.denyMessage` already closed for the hostility tri-state by carrying a
 *     THIRD reason. Finishing it is three annotations wide (`HostExec.EnvRequest.rootType`,
 *     `HostExec.SessionHost.rootType`, `HostExec.denyMessage`/`decide` → `RootType`) plus the deny
 *     text, after which this adapter is deleted.
 *  2. A `sessionID` naming no row at all still yields the attended default here (see the walk), so
 *     `tool/bash.ts` — which, unlike `PermissionV2`, never checks that its session exists — would
 *     run raw for one. The cure belongs in that tool, not in this walk.
 * The permission evaluator, which does own its seam, consumes `rootAttendance` directly and names
 * the real fault (`PermissionV2.DenialReason` → `chain-unreadable`).
 */
export const rootSessionType = <E, R>(
  sessionID: string,
  getSession: (id: string) => Effect.Effect<SessionLike | undefined, E, R>,
): Effect.Effect<SessionType, E, R> => rootAttendance(sessionID, getSession).pipe(Effect.map(narrowRootType))

// ─────────────────────────────────────────────────────────────────────────────
// AUTO MODE — the agent sets its own level and OWNS it (todo/permissions.md).
//
// The owner's ask: a session where the MODEL raises and lowers its own permission level explicitly,
// in writing, *acknowledging that it now owns it* — the self-authored-commitment lever. AGENTS.md
// pitfall #1 states the law it must obey: **informational levers engage, mechanical ones convert.**
// The written justification is the informational half and it is the point; everything in this block
// is the mechanical half, and without it Auto mode is `yolo` with extra prose.
//
// ── AUTO IS NOT A SIXTH RUNG ───────────────────────────────────────────────────────────────────
// `MODE_RANK` is untouched and `MODE_RULES` gains no member. Auto is a POLICY that lets a session
// move inside a `[floor, ceiling]`, and the ladder above stays king: a self-grant is applied with
// `moreRestrictive` and can therefore only ever NARROW what the chain already resolved to. That one
// line is the whole safety argument, and it is why it is stated as an invariant rather than as a
// check somebody could forget to run:
//
//   ⭐ **A self-grant is structurally incapable of granting a capability the user did not.**
//
// So the question *"where is the ceiling stored, and why can a session not move it?"* has a short
// answer: the ceiling is not stored anywhere new. It is the session's own chain-RESOLVED
// `permissionMode` — the column only the user's surfaces write (`SessionV2.switchMode` from the
// composer, session create, spawn, fork) — narrowed further by attendance and by any ancestor's own
// self-revocation. No tool writes that column, and even if one did, `autoResolvedMode` below would
// still refuse to widen past it.
//
// ── THE BAND ──────────────────────────────────────────────────────────────────────────────────
//   floor   = `AUTO_FLOOR` (`plan`) — rank 0, i.e. the bottom of the ladder itself.
//   ceiling = min(chain-resolved mode · the attendance cap · every ancestor's self-grant)
//
// ⚠️ THE ATTENDANCE CAP APPLIES TO GRANTS ONLY, and that asymmetry is deliberate rather than an
// oversight. An UNATTENDED root the user deliberately set to `yolo` keeps `yolo` while it holds no
// grant — that is the documented escape from the deny-fast stance (§UNATTENDED CONFINEMENT above),
// and capping it here would silently rewrite a posture the user chose. What the cap forbids is the
// SESSION handing itself `yolo`: the moment a chain self-manages, `AUTO_UNATTENDED_CEILING` binds,
// so an unattended agent that lowers itself can never climb back past `bypass`. Which is exactly
// *"Unattended: `bypass` at most, never `yolo`"* — a self-raising unattended agent would otherwise
// route straight around the stance, which exists because nobody is there to say no.
//
// ⚠️ AND IT IS KEYED ON THE RESOLVED ROOT TYPE, never on the session's own claim. `RootType`'s
// `"unknown"` arm reaches `attendedRoot` intact and takes the restrictive branch, so a chain we
// could not read is capped like an unattended one. Same collapse point, no second predicate.
// ─────────────────────────────────────────────────────────────────────────────

/** The ladder position of a mode. Exported so a caller can tell a RAISE from a LOWER without
 *  re-typing the order — `MODE_RANK` itself stays private so there is one table. */
export const modeRank = (mode: PermissionMode): number => MODE_RANK[mode]

/**
 * The lowest rung a session may put itself at. `plan` is rank 0, so this is the floor of the ladder
 * rather than a policy choice — it is a named constant so a test can bind to it and so a future
 * user-set floor has one place to land.
 */
export const AUTO_FLOOR: PermissionMode = "plan"

/**
 * The most an UNATTENDED chain may ever grant ITSELF (see the ⚠️ above). A constant so
 * `auto-mode-algebra.test.ts` can flip it and watch the refusal invert.
 */
export const AUTO_UNATTENDED_CEILING: PermissionMode = "bypass"

/**
 * The most a session may grant itself: its chain-resolved mode, narrowed by the attendance cap and
 * by any ancestor's self-grant.
 *
 * `ancestorGrant` is what makes *Privilege self-revocation* (todo.md → Vision) reach CHILDREN rather
 * than only the session that performed it. Without it the revocation is escapable by spawning: a
 * child resolves its mode from the parent's stored ROW, which a self-grant deliberately never
 * touches, so a parent that dropped itself to `plan` would hand a fresh `bypass` to the next
 * sub-agent it created.
 */
export const autoCeiling = (input: {
  readonly resolvedMode: PermissionMode
  readonly rootType: RootType
  readonly ancestorGrant?: PermissionMode
}): PermissionMode => {
  const capped = attendedRoot(input.rootType)
    ? input.resolvedMode
    : moreRestrictive(input.resolvedMode, AUTO_UNATTENDED_CEILING)
  return input.ancestorGrant === undefined ? capped : moreRestrictive(capped, input.ancestorGrant)
}

/**
 * The mode a session actually RUNS at once auto-mode grants are taken into account. `grant` is the
 * `moreRestrictive` fold of every self-grant on `[root … session]` (see `chainAutoGrant`), or
 * `undefined` when nobody on the chain has self-managed.
 *
 * ⚠️ **No grant means NO CHANGE — not "clamped to the ceiling".** A chain that never called the tool
 * must behave exactly as it did before this feature existed, including the unattended-`yolo` escape
 * hatch. The attendance cap enters only through `autoCeiling`, i.e. only once a grant exists.
 *
 * ⚠️ **The fold is `moreRestrictive` against BOTH the resolved mode and the ceiling, which makes a
 * forged grant harmless.** There is exactly one writer of the grant map (`tool/permission.ts`, via
 * `PermissionV2.setAutoGrant`), but the guarantee does not rest on that: the worst a grant of `yolo`
 * can do to an `ask` session is leave it at `ask`.
 */
export const autoResolvedMode = (input: {
  readonly resolvedMode: PermissionMode
  readonly rootType: RootType
  readonly grant?: PermissionMode
}): PermissionMode =>
  input.grant === undefined
    ? input.resolvedMode
    : moreRestrictive(input.grant, autoCeiling({ resolvedMode: input.resolvedMode, rootType: input.rootType }))

/**
 * The `moreRestrictive` fold of every auto-mode self-grant on `[root … session]`, walking `parentID`
 * root-ward with the same cycle guard as `resolveSessionConfig`. `undefined` when no layer has one.
 *
 * `grantOf` is a plain lookup rather than an Effect so this stays cheap enough to run on the
 * permission evaluator's hot path — and the evaluator skips the walk entirely while no grant exists
 * anywhere, so a default install pays nothing for this feature.
 *
 * ⚠️ It reads `grantOf(id)` BEFORE confirming the row is still there. That is deliberate: a grant is
 * a restriction, so honouring a stale one over a vanished row can only refuse more, never less.
 */
export const chainAutoGrant = <E, R>(
  sessionID: string,
  getSession: (id: string) => Effect.Effect<SessionLike | undefined, E, R>,
  grantOf: (id: string) => PermissionMode | undefined,
): Effect.Effect<PermissionMode | undefined, E, R> =>
  Effect.gen(function* () {
    const seen = new Set<string>()
    let id: string | undefined = sessionID
    let grant: PermissionMode | undefined
    while (id !== undefined && !seen.has(id)) {
      seen.add(id)
      const own = grantOf(id)
      if (own !== undefined) grant = grant === undefined ? own : moreRestrictive(grant, own)
      const session: SessionLike | undefined = yield* getSession(id)
      if (!session) break
      id = session.parentID
    }
    return grant
  })
