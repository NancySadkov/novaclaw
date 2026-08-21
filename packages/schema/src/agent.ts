export * as Agent from "./agent"

import { Schema } from "effect"
import { optional } from "./schema"
import { Model } from "./model"
import { Permission } from "./permission"
import { Provider } from "./provider"
import { PositiveInt, statics } from "./schema"

export const ID = Schema.String.pipe(Schema.brand("AgentV2.ID"))
export type ID = typeof ID.Type

export const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
]).annotate({ identifier: "Agent.Color" })
export type Color = typeof Color.Type

/** Memory reach of one agent. Mirrors `ConfigV2.Agent.memory` — the config side is the authoring
 *  surface, this is the wire the roster UI reads. */
export const Memory = Schema.Literals(["own", "none"]).annotate({ identifier: "Agent.Memory" })
export type Memory = typeof Memory.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  model: Model.Ref.pipe(optional),
  request: Provider.Request,
  system: Schema.String.pipe(optional),
  /** Roster profile — the durable half of a named agent's identity (AGENTS.md, the structural metaphor).
   *  These ride the PROFILE, never the transcript, which is what makes them survive compaction. */
  /** The display name. The `id` keys the memory scope and never changes; this is what people read
   *  and may rename. */
  name: Schema.String.pipe(optional),
  title: Schema.String.pipe(optional),
  personality: Schema.String.pipe(optional),
  avatar: Schema.String.pipe(optional),
  /** `own` = private `agent:<id>` scope + `global`; `none` = a throwaway with no memory at all. */
  memory: Memory.pipe(optional),
  description: Schema.String.pipe(optional),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  hidden: Schema.Boolean,
  color: Color.pipe(optional),
  steps: PositiveInt.pipe(optional),
  permissions: Permission.Ruleset,
})
  .annotate({ identifier: "AgentV2.Info" })
  .pipe(
    statics((schema) => ({
      empty: (id: ID) =>
        schema.make({ id, request: { headers: {}, body: {} }, mode: "all", hidden: false, permissions: [] }),
    })),
  )
