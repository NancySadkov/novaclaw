export * as ProjectsTool from "./projects"

import { Effect, Layer } from "effect"
import { ToolFailure } from "@novaclaw/llm"
import { WorkProject } from "@novaclaw/schema/work-project"
import { AgentV2 } from "../agent"
import { WorkProjects } from "../work-project/store"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "projects"
export const metadata = {
  sideEffect: "non-idempotent",
  description:
    "Nova manages the workgroup's projects here. List projects and officers, create or edit an objective, ordered phases and an optional absolute server directory (null clears the folder), assign an officer to one project (null releases them), mark phases pending or complete, pause/resume, or delete a project. Phase IDs must be unique stable strings. Edit and delete require the current revision from list. Assignments deliver the objective, plan and folder to the officer's chat. Pausing holds assigned officers and their workers at the next safe step; resuming preserves individual pauses. Nova oversees every project and is not assigned to one. Only Nova may use this tool; other officers report progress to their superior.",
  input: WorkProject.Command,
  output: WorkProject.Snapshot,
} as const
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const projects = yield* WorkProjects.Service
    yield* tools
      .register({
        [name]: Tool.make({
          ...metadata,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) =>
            String(context.agent) !== AgentV2.NOVA_ID
              ? Effect.fail(
                  new ToolFailure({
                    message: "Only Nova manages projects. Report your progress or staffing request to your superior.",
                  }),
                )
              : projects.execute(input).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
export const node = makeLocationNode({ name: "tool/projects", layer, deps: [ToolRegistry.node, WorkProjects.node] })
