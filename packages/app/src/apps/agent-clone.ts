// Cloning a colleague (owner, 2026-08-21): "new agent inherits everything, beside a name".
//
// 🔴 **What a clone must NOT inherit is the interesting half.** It takes the BRIEF — the job, the
// personality, the model, the memory setting — and none of the LIFE: not the conversation, not the
// remembered facts, not the spend. Those belong to the colleague that lived them, and a copy that
// inherited them would be a second Theron who remembers work it never did. (The surveyed competitor
// draws the same line — profile, settings and skills yes, history and learned memory no —
// `notes/survey/grokbot-research.md`.) Here that separation is free rather than enforced: memory is
// keyed `agent:<id>` and chats are bound to an agent id, so a new id starts empty by construction.
//
// ⚠️ **The carried set is DERIVED, never hand-listed — measured 2026-08-21.** It used to be a literal
// array, and it had silently drifted from the schema: a clone dropped `model`, `archiveChats`, `color`
// and `steps`, so a colleague tuned to a capable model cloned into one running the default, and a
// colleague told not to archive its chats cloned into one that does. The module's own comment claimed
// the model was carried while the code did not carry it. A hand-kept subset of a schema that grows is
// a list that is wrong the first time somebody adds a field and never says so; `agent-clone.test.ts`
// now fails when a new field is neither carried nor deliberately excluded.

import { ConfigAgent } from "@novaclaw/core/config/agent"
import { retargetScratchGrants } from "@novaclaw/core/agent/scratch-grants"
import { OfficerName } from "@novaclaw/core/agent/officer-name"
import { modelRef } from "./agent-model"
import type { AgentLike } from "./contacts"

/** Nova's charter is unique to one instance; copying its prompt would create a second apparent CEO
 * without creating a second authority root. */
export class NovaCloneRefusal extends Error {
  readonly name = "NovaCloneRefusal"
}

export const isNovaCloneRefusal = (error: unknown): error is NovaCloneRefusal => error instanceof NovaCloneRefusal

/**
 * Fields a clone deliberately does NOT take, each for its own reason. Everything else in
 * `ConfigAgent.Info` is carried, so adding a field to the schema carries it by default — the safe
 * direction, because a forgotten field then shows up as "the clone kept too much" in review rather
 * than as a silent behavioural divergence nobody notices.
 */
export const NOT_CLONED = {
  /** The whole point: a clone is a NEW colleague, drawn from the pool. */
  name: "the clone is given its own drawn name",
  /** `disabled` is a state, not a brief — cloning a switched-off colleague to get another switched-off
   *  one is nobody's intent, and the roster would not show it. */
  disabled: "a clone is created live, never pre-disabled",
  /** Provider request overrides are per-deployment plumbing (headers, body), not who a colleague IS.
   *  Copying them duplicates a credential-shaped detail into a second place to keep in sync. */
  request: "deployment plumbing, not the brief",
  /** A workspace is a PLACE, not a brief, and two colleagues on one checkout is not sharing — it is
   *  two writers on one tree with no lock. Measured 2026-09-10: `geryon.directory` equalled
   *  `daedalus.directory`, and the collision was the backdrop to every other symptom in that incident.
   *  Dropping it is not a downgrade: with no `directory` the clone works in its OWN scratch
   *  (`AgentWorkspace.folderFor` falls back to `Scratch.forAgent`), so it is productive from its first
   *  turn and a person assigns a project when they mean to. */
  directory: "a checkout is chosen, not inherited — the clone starts in its own scratch",
} as const satisfies Partial<Record<keyof ConfigAgent.Info, string>>

/** Every config field a clone carries: the schema's own keys, minus the deliberate exclusions. */
export const clonedFields = (): ReadonlyArray<string> =>
  Object.keys(ConfigAgent.Info.fields).filter((key) => !(key in NOT_CLONED))

/** The config fragment a clone is written with, plus the identity it was given. */
export interface Clone {
  /** The new agent's id — the key its memory scope and its chat will hang off. */
  readonly id: string
  /** Its display name, drawn from the pool. */
  readonly name: string
  /** The `agents.<id>` fragment to PATCH. */
  readonly fragment: Record<string, unknown>
}

/**
 * Write one clone through the shared mutation seam used by every surface that offers the action.
 * Planning and persistence belong together here: a second caller must not independently rediscover
 * which names are taken or shape a different config patch while still calling its button “Clone”.
 */
export const cloneAgent = async (input: {
  readonly source: AgentLike
  readonly roster: readonly AgentLike[]
  readonly random: () => number
  readonly updateConfig: (patch: { readonly agents: Record<string, Record<string, unknown>> }) => Promise<unknown>
}): Promise<Clone> => {
  const plan = planClone({
    source: input.source,
    taken: input.roster.flatMap((row) => [row.id, row.name ?? ""]),
    random: input.random,
  })
  await input.updateConfig({ agents: { [plan.id]: plan.fragment } })
  return plan
}

/**
 * Plan a clone. Pure: the caller does the writing, so the naming rule and the inheritance rule are
 * both testable without a server.
 *
 * `taken` must carry every existing id AND display name — a roster with two "Theron"s is
 * indistinguishable in a hand-off line even when the ids differ, which is the confusion the name
 * pool exists to prevent.
 */
export const planClone = (input: {
  readonly source: AgentLike
  readonly taken: Iterable<string>
  readonly random: () => number
}): Clone => {
  if (input.source.id === "nova")
    throw new NovaCloneRefusal(
      "Nova is the single CEO of this instance. To have another Nova, deploy a separate NovaClaw instance.",
    )
  const name = OfficerName.pick({ taken: input.taken, random: input.random })
  const fragment: Record<string, unknown> = { name: OfficerName.display(name) }
  // The CONFIG bag when the loader supplied one, the view object otherwise. The bag is the whole
  // brief; the view object is the subset the roster renders, and cloning from it drops whatever the
  // roster happens not to display.
  const source = (input.source.config ?? (input.source as unknown as Record<string, unknown>)) as Record<
    string,
    unknown
  >
  for (const key of clonedFields()) {
    const value = source[key]
    // Anything ABSENT on the source stays absent on the clone rather than being written as an empty
    // string or a null: a blank title is a different fact from "no title", and the roster already
    // renders the two differently. Arrays and objects are carried as-is (`permissions` is a ruleset
    // the user authored for this role, and a clone of the role keeps it).
    if (value === undefined || value === null) continue
    if (typeof value === "string" && value.trim() === "") continue
    // 🔴 `model` crosses a SHAPE BOUNDARY and must be converted, not copied. The roster reads the API
    // shape — `{ providerID, id }`, with the variant nested — while the config field this fragment is
    // PATCHed into is a `providerID/modelID` string. Found by driving a real clone 2026-08-21: the
    // unit test passed because its fixture was the string the config wants, and the live object would
    // have been written into a string field.
    if (key === "model") {
      const model = value as { readonly providerID?: string; readonly id?: string; readonly variant?: string }
      if (model.providerID && model.id) fragment["model"] = modelRef({ providerID: model.providerID, id: model.id })
      // The variant rides INSIDE the model on the API shape and is its own field in config.
      if (model.variant) fragment["variant"] = model.variant
      continue
    }
    // 🔴 **Two fields are DERIVED FROM THE SOURCE and must not ride across an identity boundary**, even
    // though they arrive in the bag looking like authored config. They do because the roster hands back
    // a RESOLVED record, not the stored one: `avatar` may be the source's own derived route (only the
    // `agent.list` handler emits `/api/agent/<id>/avatar`, and it appends `?v=<hash>`), and
    // `permissions` carries the MATERIALIZED floor, whose per-agent scratch grant names the SOURCE's
    // private workspace. Carried verbatim, a clone wears the source's face and holds a write grant to a
    // colleague's scratch folder. Measured on a live instance 2026-09-10: that is how `geryon` acquired
    // Daedalus's portrait, Daedalus's description and `…/scratch/daedalus/*`. An authored glyph (`"📒"`)
    // is a value the user chose and still carries. (`directory` was the third leg of that incident and
    // is now excluded outright in `NOT_CLONED`, so it never reaches this loop.)
    if (key === "avatar") {
      const derived = typeof value === "string" && value.startsWith(`/api/agent/${input.source.id}/avatar`)
      if (!derived) fragment["avatar"] = value
      continue
    }
    if (key === "permissions" && Array.isArray(value)) {
      // Strip the source's scratch grant AND grant the clone's own, in the same breath: dropping one
      // without the other turns a leak into a refusal. Retarget the INSTANCE-SUPPLIED path rather
      // than resolving Scratch on the renderer machine: the UI and NovaClaw may be different hosts.
      fragment["permissions"] = retargetScratchGrants(input.source.id, name, value as never)
      continue
    }
    fragment[key] = value
  }
  // A clone of a colleague with no explicit mode is still a colleague, not staff: without this a
  // fragment carrying no `mode` would default to whatever the store's default is, and a roster entry
  // that silently becomes a sub-agent vanishes from the list the user just cloned it in.
  if (fragment["mode"] === undefined) fragment["mode"] = "primary"
  return { id: name, name: OfficerName.display(name), fragment }
}
