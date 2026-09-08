/**
 * Model-facing "make me an app" leaf (B14): registers a home-screen app MANIFEST —
 * a launcher tile (open a closed built-in route id, a URL, or a pre-filled chat prompt), never code.
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
import { saveApp, type ManifestOpen } from "../app-registry"
import { MANIFEST_ROUTE_IDS } from "../app-route"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "register-app"

const RouteId = Schema.Literals(MANIFEST_ROUTE_IDS)

// Flat params — nested structs trip small models; this rides the tool-call recovery path.
export const Input = Schema.Struct({
  title: Schema.String.annotate({ description: "Display title for the app tile (e.g. 'Stock Prices')" }),
  id: Schema.optional(Schema.String).annotate({
    description:
      "Lowercase slug id (a-z, 0-9, -, _). Derived from the title when omitted; reusing an id updates that app.",
  }),
  subtitle: Schema.optional(Schema.String).annotate({ description: "One-line description shown on the tile" }),
  icon: Schema.optional(Schema.String).annotate({ description: "Sprite icon name (optional; a default is used)" }),
  accent: Schema.optional(Schema.String).annotate({
    description: "CSS accent color for the tile, e.g. #38bdf8 (optional)",
  }),
  open_type: Schema.Literals(["route", "url", "prompt"]).annotate({
    description:
      "What the tile opens: 'route' = a built-in app selected by id, 'url' = an external http(s) page, 'prompt' = a new chat pre-filled with this prompt",
  }),
  route_id: Schema.optional(RouteId).annotate({
    description: `Built-in app to open when open_type is 'route'. Choose one of: ${MANIFEST_ROUTE_IDS.join(", ")}`,
  }),
  open_value: Schema.optional(Schema.String).annotate({
    description:
      "External URL or prompt text when open_type is 'url' or 'prompt'. Example: open_type 'prompt' + open_value 'Show me today's stock prices for my portfolio'",
  }),
})

type OpenInput = Pick<typeof Input.Type, "open_type" | "route_id" | "open_value">

/** Convert the flat, small-model-friendly input into the persisted launcher's closed open spec. */
export function openFromInput(input: OpenInput): ManifestOpen {
  if (input.open_type === "route") {
    if (!input.route_id)
      throw new Error(`open_type "route" requires route_id. Choose one of: ${MANIFEST_ROUTE_IDS.join(", ")}`)
    return { type: "route", value: input.route_id }
  }
  if (!input.open_value?.trim()) throw new Error(`open_type "${input.open_type}" requires open_value`)
  return { type: input.open_type, value: input.open_value }
}

export const Output = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  `Registered home app "${output.title}" (id: ${output.id}). It appears on the user's home screen.`

export const metadata = {
  description: `Register (or update) an app tile on the user's home screen. An app is a LAUNCHER manifest: it opens a built-in app by route id (${MANIFEST_ROUTE_IDS.join(", ")}), an external URL, or a new chat pre-filled with a prompt — use open_type 'prompt' to turn a repeatable request into a one-tap app. Reusing an id updates that app.`,
  input: Input,
  output: Output,
} as const

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const events = yield* EventV2.Service

    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            ...metadata,
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
                    open: openFromInput(input),
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
