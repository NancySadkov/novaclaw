export * as McpExternalCommandSource from "./external-command-source"

import { Cause, Effect, Layer } from "effect"
import { ExternalCommandSource } from "@novaclaw/core/command/external-command-source"
import { makeLocationNode } from "@novaclaw/core/effect/app-node"
import { Location } from "@novaclaw/core/location"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { MCP } from "."

// Novaclaw-side `ExternalCommandSource` backed by MCP prompts (the
// `McpExternalToolSource` pattern applied to slash commands). Each connected server's
// prompts become commands; a prompt's template is fetched lazily at DISPATCH time with its
// declared arguments mapped to `$1..$N` placeholders, so the session command op's normal
// argument substitution fills them (the V1 `Command.Service` MCP mapping, now V2-native).
// Replaces core's empty `ExternalCommandSource` node via `buildLocationServiceMap`
// replacements, so MCP prompts list AND dispatch without core depending on novaclaw.
//
// MCP runs against novaclaw's instance context, which the V2 (core) location graph doesn't
// construct — bridge a minimal `InstanceRef` from the location's directory (the only field
// MCP reads on this path), exactly like the MCP tool source. `Effect.catchCause` keeps a
// missing-context defect from breaking the command list — no prompts is a valid state.
export const make = Effect.gen(function* () {
  const mcp = yield* MCP.Service
  const location = yield* Location.Service

  const instance = {
    directory: location.directory,
    worktree: location.directory,
    project: {},
  } as unknown as InstanceContext

  return ExternalCommandSource.Service.of({
    entries: () =>
      Effect.gen(function* () {
        const prompts = yield* mcp.prompts().pipe(
          Effect.provideService(InstanceRef, instance),
          Effect.catchCause((cause) =>
            Effect.logDebug(
              "MCP prompts unavailable for V2 location " + location.directory + ": " + Cause.pretty(cause),
            ).pipe(Effect.map(() => ({}) as Record<string, never>)),
          ),
        )
        const entries = new Map<string, ExternalCommandSource.Entry>()
        for (const [name, prompt] of Object.entries(prompts)) {
          entries.set(name, {
            description: prompt.description,
            hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
            template: mcp
              .getPrompt(
                prompt.client,
                prompt.name,
                prompt.arguments
                  ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                  : {},
              )
              .pipe(
                Effect.provideService(InstanceRef, instance),
                Effect.map(
                  (template) =>
                    template?.messages
                      .map((message) => (message.content.type === "text" ? message.content.text : ""))
                      .join("\n") || "",
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("MCP prompt resolution failed for " + name + ": " + Cause.pretty(cause)).pipe(
                    Effect.as(""),
                  ),
                ),
              ),
          })
        }
        return entries
      }),
  })
})

export const layer = Layer.effect(ExternalCommandSource.Service, make)

export const node = makeLocationNode({
  service: ExternalCommandSource.Service,
  layer,
  deps: [MCP.node, Location.node],
})
