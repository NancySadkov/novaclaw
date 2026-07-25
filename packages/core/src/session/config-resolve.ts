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
 * 1K: the rule overlay each permission MODE contributes at evaluation time. Appended AFTER the
 * agent's configured rules (last-match-wins), so the user's explicit mode outranks agent defaults —
 * but scoped to the mutation/exec cluster only, so agent-level gating of non-file actions
 * (question, plan_exit, …) is never overridden. `ask` sends the mutation/exec cluster through
 * consent — the Settings copy promises "'Ask' checks with you first", and with the default
 * agent's allow-all baseline an identity overlay silently made Ask ≡ Bypass (issues.md P1);
 * saved allow-always decisions land AFTER the overlay, so granted trust still quiets the asks.
 * External-directory classes (1I) stay ask in every mode except yolo — bypass is "anything
 * INSIDE the project". Mode denies are HARD: they participate in the early deny check, so a
 * saved allow-always can never override plan/surgical.
 */
export const MODE_RULES: Record<PermissionMode, readonly PermissionRule[]> = {
  plan: [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "write", resource: "*", effect: "deny" },
    { action: "create", resource: "*", effect: "deny" },
    { action: "trash", resource: "*", effect: "deny" },
    { action: "external_directory_write", resource: "*", effect: "deny" },
  ],
  ask: [
    { action: "edit", resource: "*", effect: "ask" },
    { action: "write", resource: "*", effect: "ask" },
    { action: "create", resource: "*", effect: "ask" },
    { action: "trash", resource: "*", effect: "ask" },
    { action: "bash", resource: "*", effect: "ask" },
  ],
  // Surgical: precise edits + new files stay possible; regenerating a whole existing file is not.
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
    { action: "external_directory_read", resource: "*", effect: "allow" },
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
//      the external classes outright (MODE_RULES above) — the documented "everything, incl.
//      outside the project".
// So the stance is exactly "unattended root AND mode below yolo". No new mode, no new session
// column, no new client vocabulary — and it COMPOSES with the narrowing invariant instead of
// bypassing it: a spawned child can never reach `yolo` past a lower parent (`moreRestrictive`
// clamps it), so a sub-session can never escape the stance its root chose. The intended
// unattended posture is therefore `bypass` — act freely INSIDE the work folder, hard-denied
// outside it — which is exactly what the Calendar already defaults a schedule to.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attendance is a property of the chain ROOT — the question is who answers (Agent Jail P0b).
 * Children of an interactive root surface asks to a human (attention pills); under an
 * auto-prompting or goal-oriented root there is nobody to reply. Canonical home: this pure
 * config module, so the permission evaluator and `AgentJail` share ONE predicate.
 */
export const attendedRoot = (rootType: SessionType): boolean =>
  rootType === "interactive" || rootType === "sub-agent"

/**
 * The rule overlay an unattended chain contributes. BOTH external classes are named:
 *   - `external_directory_write` is the requirement — every mutating tool (write/edit/create/
 *     apply-patch/trash/bash-workdir) asserts it BEFORE its own action whenever the resolved path
 *     leaves the Location (`LocationMutation.externalDirectoryPermission`), so denying it here
 *     denies out-of-folder create/modify at the one seam they all pass through;
 *   - `external_directory_read` is included because unattended it was never a CAPABILITY either —
 *     an unanswered ask yields no bytes, just a hang. Denying loses nothing and returns an error
 *     the model can act on. (It also matches what the Linux jail already enforces mechanically:
 *     a confined command's FS view is the worktree, so it cannot read outside it regardless.)
 * Nothing INSIDE the folder appears here — no `read`/`edit`/`write`/`create`/`trash`/`bash` rule —
 * which is the whole point of the stance: work freely where you live.
 */
export const UNATTENDED_CONFINED_RULES: readonly PermissionRule[] = [
  { action: "external_directory_write", resource: "*", effect: "deny" },
]

/**
 * The read half of the confinement, added ONLY under the `paranoid` setting.
 *
 * Owner call (2026-07-25): reading outside the project folder is ordinary work — a toolchain, an SDK, a
 * system header — and denying it by default breaks real tasks (`C:\soft\w64devkit` to build an app). The
 * fear these rules exist to answer is a destructive WRITE (`rm -rf /`), not an exfiltrated `/etc/passwd`.
 * So writing outside stays confined unconditionally, while reading outside is confined only for a user who
 * has deliberately asked for that posture.
 */
export const PARANOID_READ_RULES: readonly PermissionRule[] = [
  { action: "external_directory_read", resource: "*", effect: "deny" },
]

/**
 * The stance's rules for a chain, or none when it does not apply. `rootType` is the CHAIN ROOT's
 * type (`rootSessionType`), never the target session's — a child cannot declare itself attended
 * out of its root's stance. `mode` is the RESOLVED mode (already clamped by narrowing).
 */
export const unattendedStanceRules = (
  rootType: SessionType,
  mode: PermissionMode,
  paranoid = false,
): readonly PermissionRule[] =>
  attendedRoot(rootType) || mode === "yolo"
    ? []
    : paranoid
      ? [...UNATTENDED_CONFINED_RULES, ...PARANOID_READ_RULES]
      : UNATTENDED_CONFINED_RULES

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
  readonly strict?: StrictOverride
  readonly tools?: readonly string[]
}

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
    return resolveConfig(defaults, chain)
  })

/**
 * The chain ROOT's thread type — attendance is a property of who answers at the root
 * (Agent Jail P0b, notes/agent-jail-plan.md §2.1). Same root-ward walk + cycle guard as
 * `resolveSessionConfig`, but returns the ROOT layer's type, not the target's resolution.
 * A missing/broken/cyclic chain resolves to the default "interactive": fail-OPEN for
 * attendance is deliberate at P0 — the permission mode still gates every command, and a
 * store anomaly must not brick attended interactive turns; P3's entry ritual makes
 * unattendance an explicit per-session fact instead of an inference.
 */
export const rootSessionType = <E, R>(
  sessionID: string,
  getSession: (id: string) => Effect.Effect<SessionLike | undefined, E, R>,
): Effect.Effect<SessionType, E, R> =>
  Effect.gen(function* () {
    const seen = new Set<string>()
    let id: string | undefined = sessionID
    let root: SessionLike | undefined
    while (id !== undefined && !seen.has(id)) {
      seen.add(id)
      const session: SessionLike | undefined = yield* getSession(id)
      if (!session) break
      root = session
      if (session.parentID !== undefined && seen.has(session.parentID)) return EFFECTIVE_CONFIG_DEFAULTS.type
      id = session.parentID
    }
    // `root` holds the last reachable ancestor; a chain broken mid-walk (missing parent row)
    // still reports the highest KNOWN layer's type rather than guessing.
    return root?.type ?? EFFECTIVE_CONFIG_DEFAULTS.type
  })
