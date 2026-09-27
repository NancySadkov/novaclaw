export * as WorkProject from "./work-project"

import { Schema } from "effect"

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))
const Objective = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000))
export const Phase = Schema.Struct({
  id: Schema.String,
  name: Name,
  status: Schema.Literals(["pending", "complete"]),
})
export type Phase = typeof Phase.Type
const Plan = Schema.Array(Phase).check(Schema.isMaxLength(256))
export const Officer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  title: Schema.String,
  paused: Schema.Boolean,
  working: Schema.Boolean,
  projectID: Schema.NullOr(Schema.String),
})
export type Officer = typeof Officer.Type
export const Info = Schema.Struct({
  id: Schema.String,
  name: Name,
  objective: Objective,
  phases: Plan,
  paused: Schema.Boolean,
  revision: Schema.Int,
  completedPhases: Schema.Int,
  totalPhases: Schema.Int,
  workingOfficers: Schema.Int,
  totalOfficers: Schema.Int,
})
export type Info = typeof Info.Type
export const Snapshot = Schema.Struct({ projects: Schema.Array(Info), officers: Schema.Array(Officer) })
export type Snapshot = typeof Snapshot.Type
export const Command = Schema.Union([
  Schema.Struct({ op: Schema.Literal("list") }),
  Schema.Struct({ op: Schema.Literal("create"), name: Name, objective: Objective, phases: Plan }),
  Schema.Struct({
    op: Schema.Literal("edit"),
    id: Schema.String,
    revision: Schema.Int,
    name: Name,
    objective: Objective,
    phases: Plan,
  }),
  Schema.Struct({ op: Schema.Literal("pause"), id: Schema.String, paused: Schema.Boolean }),
  Schema.Struct({
    op: Schema.Literal("phase"),
    id: Schema.String,
    phaseID: Schema.String,
    status: Schema.Literals(["pending", "complete"]),
  }),
  Schema.Struct({ op: Schema.Literal("assign"), officer: Schema.String, projectID: Schema.NullOr(Schema.String) }),
  Schema.Struct({ op: Schema.Literal("delete"), id: Schema.String, revision: Schema.Int }),
]).annotate({ identifier: "WorkProject.Command" })
export type Command = typeof Command.Type
