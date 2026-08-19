import type { ComposerFeatureOrigin, ComposerProjectLayer } from "@/components/composer"
import type { SessionFeatureName } from "@/utils/fs-api"

/**
 * Turn `GET /api/session/:id/config` into the two things the Tuning panel needs: per switch, WHERE
 * its value came from, and what this folder's project file contributed.
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
    { readonly value?: unknown; readonly origin?: string; readonly source?: { kind: string; file?: string } }
  >
  readonly project?: {
    readonly root: string
    readonly file: string
    readonly applied: readonly string[]
    readonly refused: readonly string[]
  }
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
    if (field.source?.kind === "project" && field.source.file !== undefined)
      out[name] = { kind: "project", file: field.source.file }
    else if (field.source?.kind === "instance") out[name] = { kind: "instance" }
  }
  return out
}

/** The folder's project file, when one governs this chat. */
export const projectLayer = (resolved: ResolvedConfigLike | undefined): ComposerProjectLayer | undefined => {
  const project = resolved?.project
  return project
    ? { root: project.root, file: project.file, applied: project.applied, refused: project.refused }
    : undefined
}

/**
 * The kernel's own RESOLVED value for each switch.
 *
 * 🔴 **The panel was showing a different answer from the one the turn runs with, and the folder
 * layer is why.** The browser re-derives a baseline per switch from the instance config
 * (`featureState`), which is a second copy of a rule the kernel owns — and it cannot see a folder's
 * `novaclaw.json` at all. Measured live 2026-08-13 against a session in a folder setting
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
// THE DRAFT HALF — the same three answers, for a chat that has no id yet
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 **A draft's switches showed the INSTANCE stance for a folder that had already decided.**
 * Measured 2026-08-19 in dev Electron: a draft in a folder whose `novaclaw.json` declares
 * `quality: true` rendered *"Quality gates … Using Settings default: Off"*, while a real session in
 * that same folder resolves `quality: {value: true, source: {kind:"project"}}`. The sentence above
 * the switches had already been fixed to name the folder's file, so one panel made two
 * contradictory statements about one folder — which is worse than the original silence.
 *
 * `GET /api/project` now carries the kernel's own fold for the folder (`tune`), so the draft path
 * below is the same shape as the session path above: read what the server resolved, and render it.
 *
 * ⚠️ **Nothing here folds anything.** The temptation is to take the file's declared tune and apply
 * it over the browser's baseline. That is the mistake this module's header exists to prevent, and
 * `narrowTune` makes it a security rule rather than a display rule: a folder may raise a
 * supervision switch and may never lower one. The client's job is to render the kernel's answer.
 *
 * ⚠️ `tune` is OPTIONAL. An instance older than that field answers without it, and the honest
 * degrade is to claim nothing — the panel falls back to its instance wording, which is where this
 * started, rather than to a confident "off".
 */
export interface DiscoveredProjectLike {
  readonly kind: string
  readonly root?: string
  readonly file?: string
  readonly tune?: {
    readonly features?: Readonly<Record<string, boolean>>
    readonly applied?: readonly string[]
    readonly refused?: readonly string[]
    readonly deferred?: readonly string[]
  }
}

/**
 * Is this the answer of a folder a project file actually governs?
 *
 * Returns the narrowed shape rather than a boolean, so the three readers below cannot reach for
 * `root`/`file` on an `invalid` or `none` answer — the arms where they do not exist.
 */
const governing = (
  found: DiscoveredProjectLike | undefined,
): (DiscoveredProjectLike & { root: string; file: string }) | undefined =>
  found?.kind === "project" && found.root !== undefined && found.file !== undefined
    ? (found as DiscoveredProjectLike & { root: string; file: string })
    : undefined

/** The values a fresh chat in this folder starts with, for the switches this panel shows. */
export const draftStances = (
  found: DiscoveredProjectLike | undefined,
): Partial<Record<SessionFeatureName, boolean>> => {
  const project = governing(found)
  const features = project?.tune?.features
  if (!features) return {}
  const out: Partial<Record<SessionFeatureName, boolean>> = {}
  for (const name of FEATURE_NAMES) {
    const value = features[name]
    if (typeof value === "boolean") out[name] = value
  }
  return out
}

/**
 * Per switch, the origin line beneath it.
 *
 * ⚠️ Only `project` is ever produced. A draft has no chain, so there is no `session` origin to
 * report; and `instance` is deliberately NOT filled in for the rest, because the panel already
 * treats an absent origin as the instance and claiming it here would be a second place the same
 * default is spelled out.
 */
export const draftOrigins = (
  found: DiscoveredProjectLike | undefined,
): Partial<Record<SessionFeatureName, ComposerFeatureOrigin>> => {
  const project = governing(found)
  const file = project?.file
  const applied = project?.tune?.applied
  if (!file || !applied) return {}
  const out: Partial<Record<SessionFeatureName, ComposerFeatureOrigin>> = {}
  for (const name of FEATURE_NAMES) if (applied.includes(name)) out[name] = { kind: "project", file }
  return out
}

/**
 * The folder's own section of the panel, for a draft.
 *
 * ⚠️ `undefined` unless the server told us what the file SETS. Rendering the block with an empty
 * `applied` prints "it sets nothing", which is the false-statement failure mode in a different
 * costume — the same reason `inForceState` keeps a `here-unknown` case.
 *
 * ⚠️ `deferred` is not folded into `refused`. They are different sentences — *"your file may not
 * ask for this"* and *"this build does not fold it yet"* — and the session path carries only
 * `refused`, so inventing a wider meaning here would make the two halves disagree.
 */
export const draftProjectLayer = (found: DiscoveredProjectLike | undefined): ComposerProjectLayer | undefined => {
  const project = governing(found)
  const tune = project?.tune
  if (!project || !tune?.applied) return undefined
  return {
    root: project.root,
    file: project.file,
    applied: tune.applied.filter((name) => (FEATURE_NAMES as readonly string[]).includes(name)),
    refused: tune.refused ?? [],
  }
}
