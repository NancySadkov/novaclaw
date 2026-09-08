import type { ComposerFeature } from "./features-control"

/**
 * What "Make Default for this Folder" will actually write — decided here, not inside the dialog.
 *
 * 🔴 **The rule is surprising enough that it must be visible, and a rule the UI renders is a rule
 * the UI can get quietly wrong.** The panel shows eight switches, all of them reading On or Off, and
 * the button saves only the ones the user MOVED. Getting that backwards produces no error anywhere:
 * the file is written, the receipt is cheerful, and the folder is silently pinned against every
 * later change to the user's own Settings — which is exactly what `ProjectFile.Tune`'s "absent means
 * INHERIT, never off" discipline exists to prevent. So it lives in a function with a test rather
 * than in three `.filter(…)` chains inside a JSX body.
 */

/**
 * The switches a `novaclaw.json` can carry (`ProjectFile.TUNE_FEATURES`).
 *
 * ⚠️ Written out rather than derived from the panel's own list, which today holds the same eight
 * names by coincidence. They answer different questions — "what does this panel show" and "what may
 * a folder declare" — and the day a per-chat-only switch joins the panel, silently offering to
 * persist it would produce a file the kernel drops on read with nothing said to anyone.
 */
export const PROJECT_TUNE_FEATURES: readonly ComposerFeature[] = [
  "safeMode",
  "askBeforeChanges",
  "surgicalEdits",
  "contextBudget",
  "memory",
  "introspection",
  "quality",
  "affective",
]

/**
 * The two a folder may only ever turn ON (`ProjectFile.SUPERVISION_FEATURES`).
 *
 * The server is the enforcement — it drops a supervision `false` and reports it, so the file is
 * never wrong even if this copy drifts. This one exists so the panel can say what will happen BEFORE
 * the button is pressed rather than explaining it afterwards in a receipt.
 */
export const PROJECT_SUPERVISION_FEATURES: readonly ComposerFeature[] = ["safeMode", "askBeforeChanges"]

export interface MakeDefaultEntry {
  readonly feature: ComposerFeature
  readonly value: boolean
}

export interface MakeDefaultPlan {
  /** Everything the chat declared that a project file could carry, in the order the file lists it. */
  readonly declared: readonly MakeDefaultEntry[]
  /** Of those, what will land in the file. */
  readonly persisted: readonly MakeDefaultEntry[]
  /** Of those, what will be dropped: a folder may raise a safety rail, never lower one. */
  readonly omitted: readonly MakeDefaultEntry[]
}

/**
 * @param overrides the switches THIS CHAT declared — not its effective stance. A switch the user
 * never touched is absent here, stays absent in the file, and therefore keeps following Settings.
 */
export function planMakeDefault(overrides: Partial<Record<ComposerFeature, boolean>>): MakeDefaultPlan {
  const declared: MakeDefaultEntry[] = []
  for (const feature of PROJECT_TUNE_FEATURES) {
    const value = overrides[feature]
    if (value === undefined) continue
    declared.push({ feature, value })
  }
  const omitted = declared.filter(
    (entry) => entry.value === false && PROJECT_SUPERVISION_FEATURES.includes(entry.feature),
  )
  const persisted = declared.filter((entry) => !omitted.includes(entry))
  return { declared, persisted, omitted }
}

/** The `tune.features` payload for the write, from a plan. Includes the omitted ones deliberately. */
export function makeDefaultPayload(plan: MakeDefaultPlan): Partial<Record<ComposerFeature, boolean>> {
  const features: Partial<Record<ComposerFeature, boolean>> = {}
  // ⚠️ `declared`, not `persisted`. The SERVER decides what may be recorded and reports back what it
  // dropped, and sending only what we already believe is allowed would make the receipt's `refused`
  // list permanently empty — the client silently agreeing with itself instead of being told.
  for (const entry of plan.declared) features[entry.feature] = entry.value
  return features
}

// ---------------------------------------------------------------------------------------------
// What governs this folder RIGHT NOW — the sentence above the control
// ---------------------------------------------------------------------------------------------

/**
 * 🔴 **This sentence was affirmatively FALSE in a draft chat, and that is worse than saying nothing.**
 * Measured in the packaged app 2026-08-18 (`notes/reports/electron-render-gates-2026-08-18.md`, D4):
 * a new unsent chat always read *"This folder has no project file yet. Saving creates one here."* —
 * including in a folder holding a valid file, and including in a folder whose file was present but
 * UNREADABLE, where the very next click was refused one second after the UI promised a creation.
 *
 * The cause is that the provenance layer comes from the kernel's resolved config, which is keyed on a
 * session id a draft does not have yet. The old comment called that "a draft simply has no
 * provenance and the panel keeps its previous wording" — but the wording it kept is a POSITIVE CLAIM,
 * and principle 12(d) is about saying what is in force, not about defaulting to the cheerful branch.
 *
 * ⚠️ **Why there are UNKNOWN variants rather than reusing `here`/`ancestor`.** They exist for the
 * case where we know a file governs the folder and NOT what it declares: presenting that as a
 * resolved layer would mean rendering `applied: []`, which prints "it sets nothing" and is just a
 * different false statement. So the honest answer names the file and declines to summarise it.
 *
 * ⚠️ **Updated 2026-08-19 — this used to say `GET /api/project` never carries `applied`, and it now
 * does.** The route answers with the kernel's own fold for the folder (`tune.applied`), so a draft
 * against a current instance takes the RESOLVED `here`/`ancestor` arm through `governedBy`, exactly
 * like a session. The unknown arms remain reachable against an instance older than that field, which
 * is the one situation where *"open a chat here to see what it sets"* is still the right advice.
 */
export type InForce =
  /** Nobody has answered yet. Distinct from `none` on purpose — see {@link inForceState}. */
  | { readonly kind: "pending" }
  | { readonly kind: "none" }
  /** A resolved layer: we know the file AND what it contributed. */
  | { readonly kind: "here"; readonly file: string }
  | { readonly kind: "ancestor"; readonly file: string }
  /** Discovered by directory: the file exists and governs, but what it declares is not known here. */
  | { readonly kind: "here-unknown"; readonly file: string }
  | { readonly kind: "ancestor-unknown"; readonly file: string }
  /** Present and unusable — the case that previously promised a creation the next click refused. */
  | { readonly kind: "broken"; readonly file: string; readonly future: boolean }

export interface InForceInput {
  readonly folder: string
  /** The kernel's resolved project layer, when there is a session to resolve. */
  readonly governedBy?: { readonly root: string; readonly file: string }
  /** The directory-keyed answer, used when there is no session yet (a draft). */
  readonly discovered?:
    | { readonly kind: "project"; readonly root: string; readonly file: string }
    | { readonly kind: "invalid"; readonly file: string; readonly reason: string }
    | { readonly kind: "none" }
  /**
   * Path comparison, injected so this stays pure and testable.
   *
   * ⚠️ Never `===`. The two strings arrive from different places — the browser's session record and
   * the server's own `path.resolve` — so they can differ in separator style or a trailing slash while
   * naming one directory, and a raw comparison then tells the user their edit will create a NEW file
   * when it is about to update the one they are looking at.
   */
  readonly samePath: (a: string, b: string) => boolean
}

export function inForceState(input: InForceInput): InForce {
  // The resolved layer WINS when present: it knows strictly more than the directory probe does.
  if (input.governedBy)
    return input.samePath(input.governedBy.root, input.folder)
      ? { kind: "here", file: input.governedBy.file }
      : { kind: "ancestor", file: input.governedBy.file }

  const found = input.discovered
  // 🔴 These two are NOT the same answer, and collapsing them is the original bug in miniature.
  // `kind: "none"` is the server SAYING there is no file — evidence, so "saving creates one here" is
  // true. `undefined` is no answer yet (probe in flight, or no server at all), which is not evidence
  // of anything; asserting an absence there is how a positive claim gets made about a folder nobody
  // has looked at.
  if (!found) return { kind: "pending" }
  if (found.kind === "none") return { kind: "none" }
  if (found.kind === "invalid") return { kind: "broken", file: found.file, future: found.reason === "future-version" }
  return input.samePath(found.root, input.folder)
    ? { kind: "here-unknown", file: found.file }
    : { kind: "ancestor-unknown", file: found.file }
}
