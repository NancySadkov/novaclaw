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
} {
  if (!tune?.features) return { defaults: base, applied: [], refused: [] }
  // The baseline is what is in force WITHOUT the project — everything below this layer.
  const baseline: Partial<Record<ProjectFile.TuneFeature, boolean>> = {}
  for (const feature of ProjectFile.SUPERVISION_FEATURES) {
    const value = base[feature]
    if (typeof value === "boolean") baseline[feature] = value
  }
  const { features, refused } = ProjectFile.narrowTune(tune, baseline)
  // `applied` is the keys that SURVIVED narrowing, not the keys the file declared — a refused switch
  // must never be reported as something the folder contributed.
  return { defaults: { ...base, ...features }, applied: Object.keys(features) as ProjectFile.TuneFeature[], refused }
}
