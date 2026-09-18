// Copying an officer's TUNING onto another officer (the prototype pattern).
//
// 🔴 **The inverse of a clone, and the two must never be confused.** `agent-clone.ts`
// carries the BRIEF (job, personality, model, memory setting) to a NEW identity and
// none of the life. This carries the TUNING (model, harness detail, tool horizon,
// recipes, nudges, worker policy) to the SAME identity and none of the brief: the
// target keeps its name, its job instructions, its goal, its folder, its face, its
// reporting line and its cabinet. A bookkeeper tuned like a scout is still the
// bookkeeper — that is the whole point.
//
// ⚠️ **The copied set is DERIVED, never hand-listed** — the same lesson `agent-clone.ts`
// records (2026-08-21): a hand-kept subset of a schema that grows is wrong the first
// time somebody adds a field. Everything in `ConfigAgent.Info` copies EXCEPT
// `NOT_COPIED`, so a new tuning field rides along by default and a new identity
// field must be deliberately excluded with a reason, or `agent-settings-copy.test.ts`
// fails.

import { ConfigAgent } from "@novaclaw/core/config/agent"
import { retargetScratchGrants } from "@novaclaw/core/agent/scratch-grants"

/**
 * Fields a settings copy deliberately does NOT carry, each for its own reason.
 * Everything else in `ConfigAgent.Info` is tuning and copies.
 */
export const NOT_COPIED = {
  /** The target keeps its own id-keyed memory scope, chat and identity. */
  name: "the target keeps its own name — a copy that renamed it would be a clone, not a tuning",
  /** The roster blurb describes the role's job, which stays. */
  title: "the brief stays with the target — title names its job, not its tuning",
  /** The job instructions ARE the work the request names. Never copied. */
  system: "the brief stays with the target — job instructions are the work itself",
  /** The durable objective the live goal component refines but never replaces. */
  goal: "the brief stays with the target — the objective is the work itself",
  /** A checkout is chosen, not inherited — the clone incident (2026-09-10) applies doubled
   *  here, because the target already HAS a project of its own. */
  directory: "a checkout is chosen, not inherited — the target keeps its own project",
  /** The roster face is identity, and a derived avatar route would point at the source. */
  avatar: "the face is identity — the target keeps its own",
  /** The org-chart position is authority, not tuning (the structural metaphor). */
  superior: "the reporting line is authority, not tuning",
  /** Posture is what the colleague IS (officer vs chat vs human), not how it is tuned. */
  kind: "posture is identity — an officer tuned like a chat is still an officer",
  /** The older posture spelling, same reason. */
  shortChat: "posture is identity — see `kind`",
  /** Officer vs staff visibility: roster placement, not tuning. */
  mode: "roster placement is identity, not tuning",
  /** Visibility in the picker: presentation, not tuning. */
  hidden: "picker visibility is presentation, not tuning",
  /** A state, not tuning — copying it would switch the target off by surprise. */
  disabled: "a state, not tuning — the target stays live",
  /** The filing cabinet: the target keeps its own `agent:<id>` scope. */
  memory: "the cabinet stays with the target — memory scope is identity",
  /** Whether the target archives its own chats — the cabinet's policy, not tuning. */
  archiveChats: "the cabinet's policy stays with the target",
  /** The roster dot is decoration on the identity, not tuning. */
  color: "the face is identity — the target keeps its own color",
  /** The role summary shown in the roster describes the job, which stays. */
  description: "the brief stays with the target — the summary describes its job",
  /** Provider request overrides are per-deployment plumbing (headers, body), not tuning.
   *  Copying them duplicates a credential-shaped detail into a second place to keep in sync. */
  request: "deployment plumbing, not tuning",
} as const satisfies Partial<Record<keyof ConfigAgent.Info, string>>

/** Every config field a settings copy carries: the schema's own keys, minus identity/work. */
export const copiedFields = (): ReadonlyArray<string> =>
  Object.keys(ConfigAgent.Info.fields).filter((key) => !(key in NOT_COPIED))

/** The config fragment a settings copy is written with. */
export interface SettingsCopy {
  /** The prototype the tuning came from — reported, so the surface can say so. */
  readonly prototypeID: string
  /** The `agents.<targetID>` fragment to PATCH. */
  readonly fragment: Record<string, unknown>
  /** Private-list fields in the fragment (`nudges`, `adhocTools`): these REPLACE the
   *  target's lists, so the UI confirms before writing when either is present. */
  readonly replacesLists: ReadonlyArray<string>
}

/** Private-list fields: present in the fragment means the target's list is replaced. */
const LIST_FIELDS = ["nudges", "adhocTools"] as const

/**
 * Plan a settings copy. Pure: the caller does the writing, so the tuning/identity
 * boundary is testable without a server.
 *
 * `source` is the prototype's CONFIG bag (string models, authored ruleset) — the shape
 * `sync().data.config.agents[id]` holds. Absent on the prototype stays absent on the
 * fragment rather than clearing the target: absent = inherit, not "erase".
 */
export const planSettingsCopy = (input: {
  readonly prototypeID: string
  readonly targetID: string
  readonly source: Record<string, unknown>
}): SettingsCopy => {
  const fragment: Record<string, unknown> = {}
  for (const key of copiedFields()) {
    const value = input.source[key]
    if (value === undefined || value === null) continue
    if (typeof value === "string" && value.trim() === "") continue
    // 🔴 The materialized floor names the SOURCE's private workspace (the clone incident,
    // 2026-09-10): carried verbatim, the target would hold a write grant into a
    // colleague's scratch folder. Retarget to the target's own scratch, in the same
    // breath — dropping without re-granting turns a leak into a refusal.
    if (key === "permissions" && Array.isArray(value)) {
      fragment[key] = retargetScratchGrants(input.prototypeID, input.targetID, value as never)
      continue
    }
    fragment[key] = structuredClone(value)
  }
  const replacesLists = LIST_FIELDS.filter((field) => fragment[field] !== undefined)
  return { prototypeID: input.prototypeID, fragment, replacesLists }
}
