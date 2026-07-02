/**
 * Model-facing "make me an app" leaf (B14): registers a home-screen app MANIFEST —
 * a launcher tile (open a route, a URL, or a pre-filled chat prompt), never code.
 * Persisted under Global.Path.data/apps/<id>.json; the client merges persisted
 * manifests into the home screen. Permission-gated like `trash`.
 */
export * as RegisterAppTool from "./register-app"

import { ToolFailure } from "@novaclaw/llm"
import { AppEvent } from "@novaclaw/schema/app-event"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import { saveApp } from "../app-registry"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "register-app"

// Flat params — nested structs trip small models; this rides the tool-call recovery path.
export const Input = Schema.Struct({
  title: Schema.String.annotate({ description: "Display title for the app tile (e.g. 'Stock Prices')" }),
  id: Schema.optional(Schema.String).annotate({
    description: "Lowercase slug id (a-z, 0-9, -, _). Derived from the title when omitted; reusing an id updates that app.",
  }),
  subtitle: Schema.optional(Schema.String).annotate({ description: "One-line description shown on the tile" }),
  icon: Schema.optional(Schema.String).annotate({ description: "Sprite icon name (optional; a default is used)" }),
  accent: Schema.optional(Schema.String).annotate({ description: "CSS accent color for the tile, e.g. #38bdf8 (optional)" }),
  open_type: Schema.Literals(["route", "url", "prompt"]).annotate({
    description: "What the tile opens: 'route' = an in-app path (/files), 'url' = an external http(s) page, 'prompt' = a new chat pre-filled with this prompt",
  }),
  open_value: Schema.String.annotate({
    description: "The route path, URL, or prompt text — e.g. open_type 'prompt' + open_value 'Show me today's stock prices for my portfolio'",
  }),
})

export const Output = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  `Registered home app "${output.title}" (id: ${output.id}). It appears on the user's home screen.`

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const events = yield* EventV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Register (or update) an app tile on the user's home screen. An app is a LAUNCHER manifest: it opens an in-app route, an external URL, or a new chat pre-filled with a prompt — use open_type 'prompt' to turn a repeatable request into a one-tap app. Reusing an id updates that app.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                yield* permission.assert({
                  action: name,
                  resources: [input.id?.trim() || input.title],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool" as const,
                    messageID: context.assistantMessageID,
                    callID: context.toolCallID,
                  },
                })
                const manifest = yield* Effect.tryPromise(() =>
                  saveApp({
                    id: input.id,
                    title: input.title,
                    icon: input.icon,
                    accent: input.accent,
                    subtitle: input.subtitle,
                    open: { type: input.open_type, value: input.open_value },
                  }),
                )
                yield* events.publish(AppEvent.Registered, { id: manifest.id, title: manifest.title })
                return { id: manifest.id, title: manifest.title }
              }).pipe(
                Effect.mapError((error) => {
                  if (error instanceof ToolFailure) return error
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return new ToolFailure({ message: denial })
                  return new ToolFailure({
                    message: `Unable to register app: ${
                      error instanceof Error && error.cause instanceof Error
                        ? error.cause.message
                        : error instanceof Error
                          ? error.message
                          : String(error)
                    }`,
                  })
                }),
              ),
          }),
          name,
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/register-app",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, EventV2.node],
})
