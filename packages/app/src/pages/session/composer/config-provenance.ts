import type { ComposerFeatureOrigin } from "@/components/composer"
import type { SessionFeatureName } from "@/utils/fs-api"

export const FEATURE_NAMES: readonly SessionFeatureName[] = [
  "introspection",
  "quality",
  "affective",
  "thinkingBudget",
  "surgicalEdits",
  "askBeforeChanges",
  "safeMode",
  "contextBudget",
  "memory",
  "shortChat",
]

/** The half of the response this module reads. Structural, so the generated SDK type still satisfies it. */
export interface ResolvedConfigLike {
  readonly fields?: Record<
    string,
    { readonly value?: unknown; readonly origin?: string; readonly source?: { kind: string } }
  >
}

/**
 * Per switch, where its value came from.
 *
 * 🔴 `origin` is checked FIRST and the two are never both meaningful. The wire's contract is that
 * `origin` names the CHAIN layer that supplied the value, and `source` answers only when no layer
 * moved it — so a field a parent chat set carries an `origin` and no `source`. Reading `source`
 * first would report "your project set this" for a value a parent chat chose, which is the exact
 * falsehood this surface exists to prevent.
 */
export const featureOrigins = (
  resolved: ResolvedConfigLike | undefined,
): Partial<Record<SessionFeatureName, ComposerFeatureOrigin>> => {
  if (!resolved) return {}
  const out: Partial<Record<SessionFeatureName, ComposerFeatureOrigin>> = {}
  for (const name of FEATURE_NAMES) {
    const field = resolved.fields?.[name]
    if (!field) continue
    if (field.origin !== undefined) {
      out[name] = { kind: "session" }
      continue
    }
    else if (field.source?.kind === "agent") out[name] = { kind: "officer" }
    else if (field.source?.kind === "instance") out[name] = { kind: "instance" }
  }
  return out
}

export const resolvedStances = (
  resolved: ResolvedConfigLike | undefined,
): Partial<Record<SessionFeatureName, boolean>> => {
  if (!resolved) return {}
  const out: Partial<Record<SessionFeatureName, boolean>> = {}
  for (const name of FEATURE_NAMES) {
    const value = resolved.fields?.[name]?.value
    if (typeof value === "boolean") out[name] = value
  }
  return out
}

export const switchStance = (input: {
  readonly own: boolean | undefined
  readonly kernel: boolean | undefined
  readonly baseline: boolean
}): boolean => input.own ?? input.kernel ?? input.baseline

// ─────────────────────────────────────────────────────────────────────────────────────────────
