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

export type PermissionMode = "plan" | "ask" | "surgical" | "bypass" | "yolo"

// Ranked by escalating autonomous capability (plan = none … yolo = everything, incl. outside the
// project). Lower rank = more restrictive. (1K may refine the exact set; the narrowing invariant
// is what matters here.)
const MODE_RANK: Record<PermissionMode, number> = { plan: 0, ask: 1, surgical: 2, bypass: 3, yolo: 4 }

/** The more restrictive (lower-rank) of two modes — a child can never gain capability. */
export const moreRestrictive = (a: PermissionMode, b: PermissionMode): PermissionMode =>
  MODE_RANK[a] <= MODE_RANK[b] ? a : b

export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

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
  readonly permissionMode?: PermissionMode
  readonly permissionRules?: readonly PermissionRule[]
  readonly introspection?: boolean
  readonly affective?: boolean
  readonly tools?: readonly string[]
}

/** The fully-resolved config a session actually runs with. */
export interface EffectiveConfig {
  readonly device?: string
  readonly model?: ModelRef
  readonly agent?: string
  readonly systemPromptOverride?: string
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
    if (layer.introspection !== undefined) introspection = layer.introspection
    if (layer.affective !== undefined) affective = layer.affective
    if (layer.tools !== undefined) tools = layer.tools
    if (layer.permissionRules !== undefined) permissionRules = [...permissionRules, ...layer.permissionRules]
    if (layer.permissionMode !== undefined) {
      // Root sets freely; deeper sessions can only narrow (never escalate past the parent).
      permissionMode = index === 0 ? layer.permissionMode : moreRestrictive(permissionMode, layer.permissionMode)
    }
  })

  return { device, model, agent, systemPromptOverride, permissionMode, permissionRules, introspection, affective, tools }
}
