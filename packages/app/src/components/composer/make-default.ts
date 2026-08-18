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
