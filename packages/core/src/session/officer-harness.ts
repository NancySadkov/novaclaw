export * as OfficerHarness from "./officer-harness"

import { ConfigToolRouting } from "../config/tool-routing"

// The officer harness-detail merge (per-agent tuning, slice 1).
//
// WHY FIELD-WISE, STATED ONCE: the session chain fold (`resolveConfig`) replaces
// whole objects per layer, so a chat's `{ enabled: true }` Strict switch would wipe an
// officer's standing `attempts`/`wallMinutes` if the officer layer rode the same fold.
// The officer is therefore NOT another chain layer: it merges field-wise UNDER the
// session row and OVER the instance block — shipped defaults < instance < officer <
// session — with `undefined = inherit` at every step (the `resolveSessionConfig`
// keystone, `architecture.md`). Slice 2 threads these through `harness-config.derive`
// and the three runners; this module stays dependency-free (the `config-resolve.ts`
// doctrine) so the algebra is unit-tested without a DB.

/** Full Strict detail, as the officer schema and the session row both carry it. */
export interface StrictDetail {
  readonly enabled?: boolean
  readonly verification?: boolean
  readonly recovery?: boolean
  readonly editingAids?: boolean
  readonly budgetSteering?: boolean
  readonly attempts?: number
  readonly wallMinutes?: number
  readonly executionTokens?: number
  readonly reasoningTokens?: number
}

/** One layer wins per field: session, then officer, then instance. */
export const resolveStrict = (
  instance: StrictDetail | undefined,
  officer: StrictDetail | undefined,
  session: StrictDetail | undefined,
): StrictDetail => ({
  enabled: session?.enabled ?? officer?.enabled ?? instance?.enabled,
  verification: session?.verification ?? officer?.verification ?? instance?.verification,
  recovery: session?.recovery ?? officer?.recovery ?? instance?.recovery,
  editingAids: session?.editingAids ?? officer?.editingAids ?? instance?.editingAids,
  budgetSteering: session?.budgetSteering ?? officer?.budgetSteering ?? instance?.budgetSteering,
  attempts: session?.attempts ?? officer?.attempts ?? instance?.attempts,
  wallMinutes: session?.wallMinutes ?? officer?.wallMinutes ?? instance?.wallMinutes,
  executionTokens: session?.executionTokens ?? officer?.executionTokens ?? instance?.executionTokens,
  reasoningTokens: session?.reasoningTokens ?? officer?.reasoningTokens ?? instance?.reasoningTokens,
})

/** What the officer schema stores: the historical bare boolean or the detail struct. */
export type AffectiveValue = boolean | { readonly enabled?: boolean; readonly temperature?: number; readonly extended?: boolean }

/** The historical bare boolean means what it says — the stance, nothing else. */
export const normalizeAffective = (
  value: AffectiveValue | undefined,
): { readonly enabled?: boolean; readonly temperature?: number; readonly extended?: boolean } =>
  typeof value === "boolean" ? { enabled: value } : (value ?? {})

export interface AffectiveResolved {
  readonly enabled: boolean
  readonly temperature?: number
  readonly extended: boolean
}

/** The session STANCE wins for on/off; detail comes from the officer over the instance block. */
export const resolveAffective = (
  instance: { readonly enabled?: boolean; readonly temperature?: number; readonly extended?: boolean } | undefined,
  officer: AffectiveValue | undefined,
  sessionStance: boolean | undefined,
): AffectiveResolved => {
  const detail = normalizeAffective(officer)
  return {
    enabled: sessionStance ?? detail.enabled ?? instance?.enabled ?? false,
    temperature: detail.temperature ?? instance?.temperature,
    extended: detail.extended ?? instance?.extended ?? false,
  }
}

/** What the officer schema stores: the historical bare boolean or the detail struct. */
export type IntrospectionValue =
  | boolean
  | {
      readonly enabled?: boolean
      readonly cadence?: number
      readonly model?: string
      readonly prompt?: string
      readonly interjection?: string
      readonly generateInterjection?: boolean
    }

/** The historical bare boolean means what it says — the stance, nothing else. */
export const normalizeIntrospection = (
  value: IntrospectionValue | undefined,
): {
  readonly enabled?: boolean
  readonly cadence?: number
  readonly model?: string
  readonly prompt?: string
  readonly interjection?: string
  readonly generateInterjection?: boolean
} => (typeof value === "boolean" ? { enabled: value } : (value ?? {}))

export interface IntrospectionResolved {
  readonly enabled: boolean
  readonly cadence?: number
  readonly model?: string
  readonly prompt?: string
  readonly interjection?: string
  readonly generateInterjection?: boolean
}

/**
 * The session STANCE wins for on/off; every detail field resolves officer over instance,
 * and the runner applies shipped defaults for whatever is still absent (cadence, prompt
 * text) — absent stays absent here so "nobody set this" survives to the surface that
 * reports it.
 */
export const resolveIntrospection = (
  instance:
    | {
        readonly enabled?: boolean
        readonly cadence?: number
        readonly model?: string
        readonly prompt?: string
        readonly interjection?: string
        readonly generateInterjection?: boolean
      }
    | undefined,
  officer: IntrospectionValue | undefined,
  sessionStance: boolean | undefined,
): IntrospectionResolved => {
  const detail = normalizeIntrospection(officer)
  return {
    enabled: sessionStance ?? detail.enabled ?? instance?.enabled ?? false,
    cadence: detail.cadence ?? instance?.cadence,
    model: detail.model ?? instance?.model,
    prompt: detail.prompt ?? instance?.prompt,
    interjection: detail.interjection ?? instance?.interjection,
    generateInterjection: detail.generateInterjection ?? instance?.generateInterjection,
  }
}

/**
 * Apply the officer's tool horizon AFTER the instance routing predicate.
 *
 * Narrowing only (the structural metaphor: authority narrows downward, never widens):
 * an officer `false` denies the tool for its own sessions; an officer `true` restores a
 * tool the ROUTING table withdrew, never one the permission ruleset withdrew.
 *
 * ⚠️ The second half is a PRECONDITION on the caller, not a check here: apply this to
 * registrations that already survived the permission filter (exactly where
 * `ConfigToolRouting.offered` is applied in `runner/llm.ts`), so a `true` cannot widen
 * past it. `ESSENTIAL_TOOLS` (`configure`) is enforced here as well as in routing, so
 * an officer cannot strand its own repair tool — the new layer closes the class the
 * routing floor was written for rather than reopening it one scope down.
 */
export const applyOfficerHorizon = (
  routingOffered: (name: string) => boolean,
  officerTools: Record<string, boolean> | undefined,
): ((name: string) => boolean) => {
  if (officerTools === undefined) return routingOffered
  return (name: string): boolean => {
    if (ConfigToolRouting.ESSENTIAL_TOOLS.has(name)) return true
    const officer = officerTools[name]
    if (officer === false) return false
    if (officer === true) return true
    return routingOffered(name)
  }
}

/** The recipe fields the merge reads. Deliberately structural, not imported: this module
 *  stays dependency-free, and the config `Recipe` shape is a subset of this. */
export interface RecipeSummary {
  readonly name: string
  readonly description: string
  readonly manual?: string
  readonly enabled?: boolean
}

/**
 * Merge the instance recipe library with the officer's private recipes, by name with
 * the officer winning — the same by-name layering `AdhocGuidance.configured` applies
 * to global-over-project scopes. `globalTools === false` drops the instance layer
 * without touching the officer's own (mirrors `globalNudges`). An officer entry with
 * `enabled: false` HIDES the recipe; the consumer filters it, exactly as the global
 * tab's toggle does today — hiding is not deleting.
 */
export const resolveRecipes = (
  global: ReadonlyArray<RecipeSummary>,
  officer: { readonly adhocTools?: ReadonlyArray<RecipeSummary>; readonly globalTools?: boolean } | undefined,
): RecipeSummary[] => {
  const merged = new Map<string, RecipeSummary>()
  if (officer?.globalTools !== false) for (const recipe of global) merged.set(recipe.name, recipe)
  for (const recipe of officer?.adhocTools ?? []) merged.set(recipe.name, recipe)
  return [...merged.values()]
}
