export * as ProjectDefaults from "./project-defaults"

import { ProjectFile } from "@novaclaw/schema/project-file"
import type { EffectiveConfig } from "./config-resolve"

/**
 * A folder's `novaclaw.json` as a LAYER BENEATH the session entity.
 *
 * `architecture.md`'s ECS lens: a session is the entity, each per-session fact is a component, and
 * the inherit-on-`undefined` walk is the sparse-override column — only divergent values create rows.
 * A folder default is not a per-session fact at all; it is a property of the LOCATION. So it is not a
 * component of the session and must never be written onto one: it is a lower-precedence source that
 * the entity's own columns override.
 *
 * The resulting precedence, lowest first:
 *
 *     EFFECTIVE_CONFIG_DEFAULTS  <  the folder's tune  <  parent chain  <  the session's own row
 *
 * ⚠️ **It folds into `defaults`, NOT onto the front of the chain**, and the difference is not
 * cosmetic. `resolveConfig` gives chain index 0 special authority — the root session sets a
 * `merge: "narrow"` field (today `permissionMode`) freely, while deeper layers may only narrow.
 * Prepending a project layer would shift the session root to index 1 and silently clamp a root
 * session's own permission mode against the defaults.
 *
 * ⚠️ Nothing is stamped onto the row, which is what keeps three properties the stamping alternative
 * loses: a chat still tracks later edits to the file, a fork carries only what the USER declared,
 * and the composer can still tell "you chose this" from "this folder suggests it" — a distinction it
 * renders (`prompt.features.source.inherit` vs `.override`) and would otherwise misreport.
 */

/**
 * The components a folder may actually influence. ⛔ GROWS ONLY as readers are wired.
 *
 * 🔴 **The half-wired hazard is worse than the missing feature.** If a folder could set `safeMode`
 * while just one of its two readers saw the fold, the same chat would be confined for one decision
 * and not the next — a supervision switch that is half on, which is indistinguishable from a bug and
 * worse than not offering it.
 *
 * So a component is listed here only once EVERY kernel reader of it resolves through a folded layer.
 * That used to be a claim about eleven call sites, each passing the shipped defaults to
 * `resolveSessionConfig` itself; it is now a claim about ONE — `session/effective-config.ts` — and
 * `project-defaults-entry-point.test.ts` is the ledger that keeps it one.
 *
 * ⭐ **The full set, as measured 2026-08-13.** Every reader below resolves through the entry point:
 *
 *  · `surgicalEdits`, `askBeforeChanges` — `permission.ts`'s rule overlay.
 *  · `safeMode` — `tool/bash.ts`'s jail decision, and `runner/strict-drain.ts` via the runner's
 *    handoff resolution (`host-exec.ts`/`agent-jail.ts` take it as an argument from those two).
 *  · `contextBudget` — the runner's turn config, and the strict drain's two profile sites.
 *  · `memory` — the runner's recall gate, post-drain auto-extraction, and the `kb` tool's stand-down.
 *  · `introspection`, `quality` — the runner's per-drain `introspectionOn`/`qualityOn`, and the
 *    strict drain's quality overlay.
 *  · `affective` — the runner's mood appraisal.
 *
 * ⚠️ The FORK path (`session.ts`, via `forkSessionConfig`) is deliberately not in that list. It
 * materialises only what the CHAIN declares, so a folder's tune is never stamped onto a fork's row —
 * the fork keeps resolving it from the folder, exactly as its source did.
 */
export const WIRED: readonly ProjectFile.TuneFeature[] = [
  "surgicalEdits",
  "askBeforeChanges",
  "safeMode",
  "contextBudget",
  "memory",
  "introspection",
  "quality",
  "affective",
]

/**
 * Fold a folder's declared tune into the defaults a session resolves against.
 *
 * 🔴 **The structure is the security property here, and `narrowTune` is the backstop.** Because this
 * layer sits BELOW the parent chain and the session's own row, an explicit `safeMode: true` anywhere
 * on the chain already outranks a file that says `false` — a cloned repository cannot lower a stance
 * the user or a parent session actually took, by construction rather than by a check. `narrowTune`
 * still runs, because it is the only thing standing between a future instance-wide supervision
 * default (which would live in `base`, below this layer) and a repository that disagrees with it.
 *
 * Refusals are RETURNED, not swallowed: a file asking for something it may not have is a thing the
 * user should be told about on the Project surface, not a silent no-op.
 */
export function fold(
  base: EffectiveConfig,
  tune: ProjectFile.Tune | undefined,
): {
  readonly defaults: EffectiveConfig
  /**
   * The components the folder actually supplied. Reported because a value's ORIGIN is a question the
   * introspection surface has to answer — "you chose this" and "this folder suggests it" look
   * identical in the resolved config, and only the layer that produced it knows which.
   */
  readonly applied: readonly ProjectFile.TuneFeature[]
  readonly refused: readonly ProjectFile.TuneFeature[]
  /**
   * Declared, allowed, and NOT applied because a reader of it does not see this layer yet — see
   * {@link WIRED}. Reported rather than dropped: a folder asking for something that quietly does
   * nothing is the failure the Project surface exists to make visible.
   */
  readonly deferred: readonly ProjectFile.TuneFeature[]
} {
  if (!tune?.features) return { defaults: base, applied: [], refused: [], deferred: [] }
  // The baseline is what is in force WITHOUT the project — everything below this layer.
  const baseline: Partial<Record<ProjectFile.TuneFeature, boolean>> = {}
  for (const feature of ProjectFile.SUPERVISION_FEATURES) {
    const value = base[feature]
    if (typeof value === "boolean") baseline[feature] = value
  }
  const { features, refused } = ProjectFile.narrowTune(tune, baseline)
  // `applied` is the keys that survived BOTH narrowing and the wired check — a refused or deferred
  // switch must never be reported as something the folder contributed.
  const effective: Record<string, boolean> = {}
  const applied: ProjectFile.TuneFeature[] = []
  const deferred: ProjectFile.TuneFeature[] = []
  for (const [key, value] of Object.entries(features)) {
    const feature = key as ProjectFile.TuneFeature
    if (!WIRED.includes(feature)) {
      deferred.push(feature)
      continue
    }
    effective[feature] = value
    applied.push(feature)
  }
  return { defaults: { ...base, ...effective }, applied, refused, deferred }
}
