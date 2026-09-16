import type { ComposerFeatureOrigin } from "@/components/composer"
import type { SessionFeatureName } from "@/utils/fs-api"

/**
 * Turn `GET /api/session/:id/config` into what the Tuning panel needs: per switch, WHERE its value
 * came from.
 *
 * ⚠️ Extracted from the controller rather than left inline, because it is the only part of this
 * feature that can be got wrong quietly. The panel renders whatever it is handed; a mapping that
 * reads `source` when it should read `origin` produces a confident, wrong sentence about where a
 * setting came from — delivered by the one surface a person consults when they are already confused.
 */

/**
 * The switches the Tuning panel shows, as the wire spells them.
 *
 * ⚠️ A local list rather than a reach into the kernel's enum: this package cannot import
 * `@novaclaw/schema`, and the response's `fields` is an OPEN map keyed by config-field name. A name
 * that stops existing simply yields no origin — the panel falls back to its previous wording rather
 * than rendering something wrong.
 */
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
    else if (field.source?.kind === "instance") out[name] = { kind: "instance" }
  }
  return out
}

/**
 * The kernel's own RESOLVED value for each switch.
 *
 * ⚠️ **The panel used to show a different answer from the one the turn runs with.** The browser
 * re-derives a baseline per switch from the instance config (`featureState`), which is a second copy
 * of a rule the kernel owns, and the two disagreed as soon as a layer the browser could not see moved
 * a value. Measured live 2026-08-13 against a session in a folder setting
 * `safeMode: true, memory: false`: the toggles read Off and On, the exact inverse of what the runner
 * resolved, with the provenance line underneath naming the very file that had set them. A control
 * that contradicts the sentence beneath it is worse than one that says nothing.
 *
 * So the resolved value WINS over the derived baseline. It does not win over this chat's own stance:
 * a user who just flipped a switch sees their flip immediately, while this response is still in
 * flight — the caller layers it as `own ?? resolved ?? baseline`.
 *
 * ⚠️ Only booleans. A tri-state nobody set resolves to `undefined`, which must stay a miss so the
 * baseline still answers — coercing it would turn "no stance" into "off" for every switch.
 */
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

/**
 * What ONE switch reads, in the order the kernel resolves it: this chat, then the layer beneath the
 * entity, then the instance.
 *
 * ⚠️ A function rather than three `??` written out at the call site, because the panel's whole job
 * is to agree with the runner and the ORDER is the agreement. `kernel` is the resolved answer — a
 * session's chain resolution, or a draft's folder fold — and it must lose to the user's own flip
 * (which is not on the wire yet) and beat the browser's derived instance baseline (which cannot see
 * a folder at all).
 */
export const switchStance = (input: {
  readonly own: boolean | undefined
  readonly kernel: boolean | undefined
  readonly instance: boolean
}): boolean => input.own ?? input.kernel ?? input.instance

// ─────────────────────────────────────────────────────────────────────────────────────────────