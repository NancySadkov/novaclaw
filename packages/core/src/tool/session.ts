export * as SessionTool from "./session"

import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@novaclaw/llm"
import { isDeepStrictEqual } from "node:util"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionComponentRegistry } from "../session/component-registry"
import { SessionComponentTier } from "../session/component-tier"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "session"

const SchemaOp = Schema.Struct({
  op: Schema.Literal("schema"),
  kind: Schema.optional(Schema.String).annotate({
    description: "One component kind to describe. Omit to survey every component this kernel exposes.",
  }),
})
const ReadOp = Schema.Struct({
  op: Schema.Literal("read"),
  kind: Schema.String,
  id: Schema.optional(Schema.String),
})
const ListOp = Schema.Struct({ op: Schema.Literal("list"), kind: Schema.String })
const SetOp = Schema.Struct({
  op: Schema.Literal("set"),
  kind: Schema.String,
  id: Schema.optional(Schema.String),
  value: Schema.Unknown,
})
const RemoveOp = Schema.Struct({
  op: Schema.Literal("remove"),
  kind: Schema.String,
  id: Schema.optional(Schema.String),
})

export const Input = Schema.Union([SchemaOp, ReadOp, ListOp, SetOp, RemoveOp])
const Output = Schema.Struct({ op: Schema.String, message: Schema.String })

const description =
  "Inspect and manage YOUR session's components through one typed registry. Operations: schema describes " +
  "available kinds and their exact JSON shape; read gets one singleton or set member; list gets every " +
  "member of one kind; set validates and stores a value; remove clears it so inheritance can resume. " +
  "Start with schema when unsure. Component ids are accepted only for set-valued kinds. Writes to standing " +
  "instructions require explicit privileged approval. This first reach is deliberately self-only; it cannot " +
  "stage state in a sibling, ancestor, or child session."

const failure = (message: string) => new ToolFailure({ message })

/** Pure diff breadcrumb retained from the retired one-field `reconfigure` tool. */
export function diffSummary(previous: string, next: string | null) {
  const target = next ?? ""
  if (previous === target)
    return `System-prompt override unchanged (${previous.length} chars).`
  if (next === null) return `System-prompt override cleared (${previous.length} -> 0 chars).`
  const previousLines = previous.split("\n")
  const nextLines = next.split("\n")
  const count = Math.max(previousLines.length, nextLines.length)
  let detail = "Texts differ."
  for (let index = 0; index < count; index++) {
    if (previousLines[index] === nextLines[index]) continue
    const clip = (line: string | undefined) =>
      line === undefined ? "<none>" : JSON.stringify(line.length > 80 ? `${line.slice(0, 77)}...` : line)
    detail = `First difference at line ${index + 1}: ${clip(previousLines[index])} -> ${clip(nextLines[index])}.`
    break
  }
  return (
    `System-prompt override replaced (${previous.length} -> ${target.length} chars). ${detail} ` +
    "It applies from the next turn; the immutable base prompt is untouched. Remove this component to revert."
  )
}

const renderEntry = (entry: SessionComponentRegistry.Entry) =>
  JSON.stringify({
    kind: entry.kind,
    ...(entry.id === undefined ? {} : { id: entry.id }),
    value: entry.value,
    version: entry.version,
    lifetime: entry.lifetime,
    stale: entry.stale,
    ...(entry.staleReason === undefined ? {} : { staleReason: entry.staleReason }),
  })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const components = yield* SessionComponentRegistry.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            description,
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
            execute: (input, context) =>
              Effect.gen(function* () {
                if (input.op === "schema") {
                  const definitions = components.definitions()
                  const selected = input.kind
                    ? definitions.filter((definition) => definition.kind === input.kind)
                    : definitions
                  if (input.kind && selected.length === 0)
                    return yield* failure(`Unknown session component kind: ${input.kind}`)
                  return {
                    op: input.op,
                    message:
                      selected.length === 0
                        ? "This kernel exposes no session components."
                        : selected
                            .map(
                              (definition) =>
                                `${definition.kind} [${definition.cardinality}, ${definition.lifetime}, ${SessionComponentTier.tierOf(definition.kind)}] — ${definition.description}\n` +
                                JSON.stringify(definition.schema),
                            )
                            .join("\n\n"),
                  }
                }

                if (input.op === "read") {
                  const entry = yield* components.get({
                    sessionID: context.sessionID,
                    kind: input.kind,
                    ...(input.id === undefined ? {} : { id: input.id }),
                  })
                  return {
                    op: input.op,
                    message:
                      entry === undefined
                        ? `This session declares no ${input.kind}${input.id ? ` component with id ${input.id}` : " component"}.`
                        : renderEntry(entry),
                  }
                }

                if (input.op === "list") {
                  const entries = yield* components.list({ sessionID: context.sessionID, kind: input.kind })
                  return {
                    op: input.op,
                    message:
                      entries.length === 0
                        ? `This session declares no ${input.kind} components.`
                        : entries.map(renderEntry).join("\n"),
                  }
                }

                const validated = input.op === "set" ? yield* components.validate(input.kind, input.value) : undefined
                const previous = yield* components.get({
                  sessionID: context.sessionID,
                  kind: input.kind,
                  ...(input.id === undefined ? {} : { id: input.id }),
                })

                if (input.op === "remove" && previous === undefined)
                  return {
                    op: input.op,
                    message:
                      input.kind === "system_prompt_override"
                        ? diffSummary("", null)
                        : `Nothing changed: this session declared no ${input.kind}${input.id ? `/${input.id}` : ""}.`,
                  }
                if (input.op === "set" && previous && isDeepStrictEqual(previous.value, validated))
                  return {
                    op: input.op,
                    message:
                      input.kind === "system_prompt_override" && typeof validated === "string"
                        ? diffSummary(validated, validated)
                        : `Nothing changed: ${input.kind}${input.id ? `/${input.id}` : ""} already has that value.`,
                  }

                const tier = SessionComponentTier.tierOf(input.kind)
                if (tier !== "operational") {
                  const action = SessionComponentTier.TIER_ACTION[tier]
                  yield* permission.assert({
                    action,
                    resources: [input.kind],
                    save: [input.kind],
                    metadata: { tier, operation: input.op },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: {
                      type: "tool",
                      messageID: context.assistantMessageID,
                      callID: context.toolCallID,
                    },
                  })
                }

                if (input.op === "remove") {
                  const removed = yield* components.remove({
                    sessionID: context.sessionID,
                    kind: input.kind,
                    ...(input.id === undefined ? {} : { id: input.id }),
                  })
                  const message =
                    input.kind === "system_prompt_override"
                      ? diffSummary(typeof previous?.value === "string" ? previous.value : "", null)
                        : removed
                          ? `Removed ${input.kind}${input.id ? `/${input.id}` : ""}.`
                          : `Nothing changed: this session declared no ${input.kind}${input.id ? `/${input.id}` : ""}.`
                  return { op: input.op, message }
                }

                const entry = yield* components.put({
                  sessionID: context.sessionID,
                  kind: input.kind,
                  ...(input.id === undefined ? {} : { id: input.id }),
                  value: input.value,
                })
                return {
                  op: input.op,
                  message:
                    input.kind === "system_prompt_override" && typeof entry.value === "string"
                      ? diffSummary(typeof previous?.value === "string" ? previous.value : "", entry.value)
                      : `Stored ${entry.kind}${entry.id ? `/${entry.id}` : ""}: ${JSON.stringify(entry.value)}`,
                }
              }).pipe(
                Effect.mapError((error) => {
                  if (error instanceof ToolFailure) return error
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return failure(`Session component unchanged. ${denial}`)
                  if (error instanceof SessionComponentRegistry.InvalidValueError)
                    return failure(`Invalid value for ${error.kind}: ${error.message}`)
                  return failure(error instanceof Error ? error.message : String(error))
                }),
              ),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/session",
  layer,
  deps: [ToolRegistry.node, SessionComponentRegistry.node, PermissionV2.node],
})
