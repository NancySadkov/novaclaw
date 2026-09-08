export * as SessionTool from "./session"

import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@novaclaw/llm"
import { isDeepStrictEqual } from "node:util"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionComponentRegistry } from "../session/component-registry"
import { SessionComponentTier } from "../session/component-tier"
import { SessionExecutionAttempt } from "../session/execution-attempt"
import { SessionOrigin } from "../session/origin"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
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
  sessionID: Schema.optional(SessionSchema.ID).annotate({
    description: "Session to inspect. Omit for your own session.",
  }),
  kind: Schema.String,
  id: Schema.optional(Schema.String),
})
const ListOp = Schema.Struct({
  op: Schema.Literal("list"),
  sessionID: Schema.optional(SessionSchema.ID).annotate({
    description: "Session to inspect. Omit for your own session.",
  }),
  kind: Schema.String,
})
const SetOp = Schema.Struct({
  op: Schema.Literal("set"),
  sessionID: Schema.optional(SessionSchema.ID).annotate({
    description: "Reserved for a future descendant-write capability. Omit: writes are self-only.",
  }),
  kind: Schema.String,
  id: Schema.optional(Schema.String),
  value: Schema.Unknown,
})
const RemoveOp = Schema.Struct({
  op: Schema.Literal("remove"),
  sessionID: Schema.optional(SessionSchema.ID).annotate({
    description: "Reserved for a future descendant-write capability. Omit: writes are self-only.",
  }),
  kind: Schema.String,
  id: Schema.optional(Schema.String),
})

export const Input = Schema.Union([SchemaOp, ReadOp, ListOp, SetOp, RemoveOp])
const Output = Schema.Struct({ op: Schema.String, message: Schema.String, foreign: Schema.optional(Schema.Boolean) })
export type Output = typeof Output.Type

export const toModelOutput = (output: Output): string =>
  (output.foreign ? SessionOrigin.externalContentFrame("another NovaClaw session") : "") + output.message

const description =
  "Inspect session components and manage YOUR OWN through one typed registry. Operations: schema describes " +
  "available kinds and their exact JSON shape; read gets one singleton or set member; list gets every member " +
  "of one kind; set validates and stores a value; remove clears it so inheritance can resume. Read/list may " +
  "name any session in this instance; prompt-bearing values require privileged approval. Set/remove remain " +
  "self-only and reject a target. Start with schema when unsure. Component ids are only for set-valued kinds."

const failure = (message: string) => new ToolFailure({ message })

/** Pure diff breadcrumb retained from the retired one-field `reconfigure` tool. */
export function diffSummary(previous: string, next: string | null) {
  const target = next ?? ""
  if (previous === target) return `System-prompt override unchanged (${previous.length} chars).`
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
    sessionID: entry.sessionID,
    kind: entry.kind,
    ...(entry.id === undefined ? {} : { id: entry.id }),
    value: entry.value,
    version: entry.version,
    lifetime: entry.lifetime,
    ...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
    ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
    stale: entry.stale,
    ...(entry.staleReason === undefined ? {} : { staleReason: entry.staleReason }),
  })

export const metadata = { description, input: Input, output: Output } as const

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const components = yield* SessionComponentRegistry.Service
    const permission = yield* PermissionV2.Service
    const sessions = yield* SessionStore.Service
    const attempts = yield* SessionExecutionAttempt.Service

    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            ...metadata,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const prepareRead = Effect.fn("SessionTool.prepareRead")(function* (
                  targetID: SessionSchema.ID,
                  kind: string,
                  operation: "read" | "list",
                ) {
                  if (!(yield* sessions.get(targetID))) return yield* failure(`Target session not found: ${targetID}`)
                  const definition = components.definitions().find((item) => item.kind === kind)
                  if (!definition) return yield* failure(`Unknown session component kind: ${kind}`)
                  const crossSession = targetID !== context.sessionID
                  const readTier = SessionComponentTier.readTierOf(kind, crossSession)
                  if (readTier !== "operational")
                    yield* permission.assert({
                      action: SessionComponentTier.TIER_ACTION[readTier],
                      resources: [`${targetID}/${kind}`],
                      save: [`${targetID}/${kind}`],
                      metadata: { tier: readTier, operation, targetSessionID: targetID },
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                    })
                  const attempt = crossSession
                    ? yield* attempts
                        .get(targetID)
                        .pipe(
                          Effect.map((attempt) =>
                            attempt !== undefined && ["starting", "busy", "recovering"].includes(attempt.state)
                              ? { attemptID: attempt.attemptID, generation: attempt.generation }
                              : undefined,
                          ),
                        )
                    : yield* SessionExecutionAttempt.currentFence()
                  return { targetID, attempt }
                })

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
                                `${definition.kind} [${definition.cardinality}, ${definition.lifetime}, write:${SessionComponentTier.tierOf(definition.kind)}, cross-read:${SessionComponentTier.readTierOf(definition.kind, true)}] — ${definition.description}\n` +
                                (definition.removable ? "" : "remove: unavailable (this component is required)\n") +
                                JSON.stringify(definition.schema),
                            )
                            .join("\n\n"),
                  }
                }

                if (input.op === "read") {
                  const targetID = input.sessionID ?? context.sessionID
                  const { attempt } = yield* prepareRead(targetID, input.kind, "read")
                  const entry = yield* components.get({
                    sessionID: targetID,
                    kind: input.kind,
                    ...(input.id === undefined ? {} : { id: input.id }),
                    ...(attempt === undefined ? {} : { attempt }),
                  })
                  return {
                    op: input.op,
                    ...(targetID === context.sessionID ? {} : { foreign: true }),
                    message:
                      entry === undefined
                        ? `Session ${targetID} declares no ${input.kind}${input.id ? ` component with id ${input.id}` : " component"}.`
                        : renderEntry(entry),
                  }
                }

                if (input.op === "list") {
                  const targetID = input.sessionID ?? context.sessionID
                  const { attempt } = yield* prepareRead(targetID, input.kind, "list")
                  const entries = yield* components.list({
                    sessionID: targetID,
                    kind: input.kind,
                    ...(attempt === undefined ? {} : { attempt }),
                  })
                  return {
                    op: input.op,
                    ...(targetID === context.sessionID ? {} : { foreign: true }),
                    message:
                      entries.length === 0
                        ? `Session ${targetID} declares no ${input.kind} components.`
                        : entries.map(renderEntry).join("\n"),
                  }
                }

                if (input.sessionID !== undefined)
                  return yield* failure(
                    `Cross-session ${input.op} is unavailable. Omit sessionID to change only your own session.`,
                  )

                const definition = components.definitions().find((item) => item.kind === input.kind)
                if (input.op === "remove" && definition?.removable === false)
                  return yield* failure(`${input.kind} cannot be removed; set a different value instead.`)
                const validated =
                  input.op === "set"
                    ? yield* components.validate({
                        sessionID: context.sessionID,
                        kind: input.kind,
                        ...(input.id === undefined ? {} : { id: input.id }),
                        value: input.value,
                      })
                    : undefined
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
                if (input.op === "remove")
                  yield* components.validateRemoval({
                    sessionID: context.sessionID,
                    kind: input.kind,
                    ...(input.id === undefined ? {} : { id: input.id }),
                  })
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
  deps: [
    ToolRegistry.node,
    SessionComponentRegistry.node,
    PermissionV2.node,
    SessionStore.node,
    SessionExecutionAttempt.node,
  ],
})
