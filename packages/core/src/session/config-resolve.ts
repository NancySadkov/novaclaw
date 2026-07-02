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
 * (question, plan_exit, …) is never overridden. `ask` is the identity. External-directory classes
 * (1I) stay ask in every mode except yolo — bypass is "anything INSIDE the project".
 * Mode denies are HARD: they participate in the early deny check, so a saved allow-always can
 * never override plan/surgical.
 */
export const MODE_RULES: Record<PermissionMode, readonly PermissionRule[]> = {
  plan: [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "write", resource: "*", effect: "deny" },
    { action: "create", resource: "*", effect: "deny" },
    { action: "trash", resource: "*", effect: "deny" },
    { action: "external_directory_write", resource: "*", effect: "deny" },
  ],
  ask: [],
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

export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/** The Vision's typed threads: how a session decides whether to keep running (K1). */
export type SessionType = "interactive" | "sub-agent" | "auto-prompting" | "goal-oriented"

export interface PermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

/** A session's on-record config OVERRIDES. Every field optional — `undefined` = inherit. */
export interface SessionConfig {
  readonly device?: string
  readonly model?: ModelRef
  readonly agent?: string
  readonly systemPromptOverride?: string
  readonly type?: SessionType
  readonly priority?: number
  readonly permissionMode?: PermissionMode
  readonly permissionRules?: readonly PermissionRule[]
  readonly introspection?: boolean
  readonly affective?: boolean
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
  permissionMode: "ask",
  permissionRules: [],
  introspection: false,
  affective: false,
}

/** The fully-resolved config a session actually runs with. */
export interface EffectiveConfig {
  readonly device?: string
  readonly model?: ModelRef
  readonly agent?: string
  readonly systemPromptOverride?: string
  readonly type: SessionType
  readonly priority: number
  readonly permissionMode: PermissionMode
  readonly permissionRules: readonly PermissionRule[]
  readonly introspection: boolean
  readonly affective: boolean
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
  let introspection = defaults.introspection
  let affective = defaults.affective
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
    if (layer.introspection !== undefined) introspection = layer.introspection
    if (layer.affective !== undefined) affective = layer.affective
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
    permissionMode,
    permissionRules,
    introspection,
    affective,
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
  readonly permissionMode?: PermissionMode
  // permissionRules / introspection / affective / tools get mapped here as the
  // session schema grows to carry them (see architecture.md Phase 1 step 4).
}

/** Project a session record onto its config OVERRIDES (only fields it actually carries today). */
export const sessionToConfig = (session: SessionLike): SessionConfig => ({
  model: session.model,
  agent: session.agent,
  systemPromptOverride: session.systemPromptOverride,
  type: session.type,
  priority: session.priority,
  permissionMode: session.permissionMode,
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
