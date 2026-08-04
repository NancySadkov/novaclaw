import { describe, expect } from "bun:test"
import { Tool } from "@novaclaw/core/tool/tool"
import { ApplicationTools } from "@novaclaw/core/tool/application-tools"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionMessage } from "@novaclaw/core/session/message"
import { AgentV2 } from "@novaclaw/core/agent"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { executeTool, settleTool, toolDefinitions } from "./lib/tool"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { Tools } from "@novaclaw/core/tool/tools"
import { Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, ToolRegistry.node, ToolRegistry.toolsNode]), [
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ]),
)

const sessionID = SessionV2.ID.make("ses_application_tool")
const agent = AgentV2.ID.make("build")
const assistantMessageID = SessionMessage.ID.make("msg_application_tool")
const contextual = (contexts: Tool.Context[]) =>
  Tool.make({
    description: "Read application context",
    input: Schema.Struct({ query: Schema.String }),
    output: Schema.Struct({ answer: Schema.String }),
    execute: ({ query }, context) =>
      Effect.sync(() => {
        contexts.push(context)
        return { answer: query.toUpperCase() }
      }),
    toModelOutput: ({ output }) => [
      { type: "text", text: output.answer },
      { type: "file", data: "aGVsbG8=", mime: "image/png", name: "result.png" },
    ],
  })

describe("ApplicationTools", () => {
  it.effect("catalogues application and Location tools through the canonical registry", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const tools = yield* Tools.Service
      const registry = yield* ToolRegistry.Service

      yield* applications.register({ application_echo: contextual([]) })
      yield* tools.register({ core_echo: contextual([]) })

      expect((yield* registry.catalogue()).map((source) => [source.definition.name, source.server])).toEqual([
        ["application_echo", "application"],
        ["core_echo", "core"],
      ])
    }),
  )

  it.effect("keeps the Core carrier opaque and executes its single handler", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []
      const tool = contextual(contexts)
      expect(Object.keys(tool)).toEqual([])

      yield* applications.register({ opaque: tool })
      expect(
        yield* executeTool(registry, {
          sessionID,
          agent,
          assistantMessageID,
          call: { type: "tool-call", id: "call-opaque", name: "opaque", input: { query: "once" } },
        }),
      ).toEqual({
        type: "content",
        value: [
          { type: "text", text: "ONCE" },
          { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "result.png" },
        ],
      })
      expect(contexts).toEqual([
        { sessionID, agent, assistantMessageID, toolCallID: "call-opaque", attachmentPaths: new Set() },
      ])
    }),
  )

  it.effect("exposes narrow scoped Location registration and validates names", () =>
    Effect.gen(function* () {
      const tools: Tools.Interface = yield* Tools.Service
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()

      yield* tools.register({ location_tool: contextual([]) }).pipe(Scope.provide(scope))
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["location_tool"])
      expect(yield* Effect.flip(tools.register({ "invalid name": contextual([]) }))).toBeInstanceOf(
        Tool.RegistrationError,
      )

      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(registry)).toEqual([])
    }),
  )

  it.effect("filters an application tool by its name without adding execution authorization", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []
      yield* applications.register({ application_context: contextual(contexts) })

      expect(
        yield* toolDefinitions(registry, [{ action: "application_context", resource: "*", effect: "deny" }]),
      ).toEqual([])
      expect(
        yield* settleTool(registry, {
          sessionID,
          agent,
          assistantMessageID,
          call: { type: "tool-call", id: "call-denied", name: "application_context", input: { query: "hello" } },
        }),
      ).toMatchObject({ result: { type: "content" } })
      expect(contexts).toEqual([
        { sessionID, agent, assistantMessageID, toolCallID: "call-denied", attachmentPaths: new Set() },
      ])
    }),
  )

  it.effect("advertises and executes a scoped application tool with Session context", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []

      yield* applications.register({ application_context: contextual(contexts) })

      expect(yield* toolDefinitions(registry)).toMatchObject([
        { name: "application_context", description: "Read application context" },
      ])
      expect(
        yield* settleTool(registry, {
          sessionID,
          agent,
          assistantMessageID,
          call: { type: "tool-call", id: "call-context", name: "application_context", input: { query: "hello" } },
        }),
      ).toEqual({
        result: {
          type: "content",
          value: [
            { type: "text", text: "HELLO" },
            { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "result.png" },
          ],
        },
        output: {
          structured: { answer: "HELLO" },
          content: [
            { type: "text", text: "HELLO" },
            { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "result.png" },
          ],
        },
      })
      expect(contexts).toEqual([
        { sessionID, agent, assistantMessageID, toolCallID: "call-context", attachmentPaths: new Set() },
      ])
    }),
  )

  it.effect("removes an application tool when its registration scope closes", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()

      yield* applications.register({ temporary: contextual([]) }).pipe(Scope.provide(scope))
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["temporary"])

      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(registry)).toEqual([])
    }),
  )

  it.effect("removes a tool before settling a call produced from an earlier definition", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const registrationScope = yield* Scope.make()
      yield* applications.register({ contextual: contextual([]) }).pipe(Scope.provide(registrationScope))
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["contextual"])

      yield* Scope.close(registrationScope, Exit.void)
      expect(
        yield* settleTool(registry, {
          sessionID,
          agent,
          assistantMessageID,
          call: { type: "tool-call", id: "call-removed", name: "contextual", input: { query: "hello" } },
        }),
        // Identifying clause only — the registry now also names the advertised tools, and pinning
        // that prose here would churn this suite every time the recovery message improves.
      ).toMatchObject({ result: { type: "error", value: expect.stringContaining("Unknown tool: contextual.") } })
    }),
  )

  it.effect("does not leak a registration into an already closed scope", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      yield* Scope.close(scope, Exit.void)

      yield* applications.register({ closed: contextual([]) }).pipe(Scope.provide(scope))

      expect(yield* toolDefinitions(registry)).toEqual([])
    }),
  )

  it.effect("preserves an interrupted application registration until its scope closes", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      const registered = yield* Deferred.make<void>()
      const fiber = yield* applications
        .register({ interrupted: contextual([]) })
        .pipe(
          Effect.andThen(Deferred.succeed(registered, undefined)),
          Effect.andThen(Effect.never),
          Scope.provide(scope),
          Effect.forkChild,
        )
      yield* Deferred.await(registered)
      yield* Fiber.interrupt(fiber)

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["interrupted"])
      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(registry)).toEqual([])
    }),
  )

  it.effect("captures the registered record before later State rebuilds", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const registered = { stable: contextual([]) }
      yield* applications.register(registered)
      Object.assign(registered, { late: contextual([]) })

      yield* Effect.scoped(applications.register({ temporary: contextual([]) }))

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["stable"])
    }),
  )

  it.effect("settles with the current same-name application tool and restores earlier registrations", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const firstContexts: Tool.Context[] = []
      const secondContexts: Tool.Context[] = []
      const scope = yield* Scope.make()
      yield* applications.register({ contextual: contextual(firstContexts) })
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["contextual"])
      yield* applications.register({ contextual: contextual(secondContexts) }).pipe(Scope.provide(scope))

      yield* settleTool(registry, {
        sessionID,
        agent,
        assistantMessageID,
        call: { type: "tool-call", id: "call-second", name: "contextual", input: { query: "second" } },
      })
      yield* Scope.close(scope, Exit.void)
      yield* settleTool(registry, {
        sessionID,
        agent,
        assistantMessageID,
        call: { type: "tool-call", id: "call-first", name: "contextual", input: { query: "first" } },
      })

      expect(secondContexts).toEqual([
        { sessionID, agent, assistantMessageID, toolCallID: "call-second", attachmentPaths: new Set() },
      ])
      expect(firstContexts).toEqual([
        { sessionID, agent, assistantMessageID, toolCallID: "call-first", attachmentPaths: new Set() },
      ])
    }),
  )

  it.effect("keeps the Location tool when an application tool has the same name", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const locationContexts: Tool.Context[] = []
      const applicationContexts: Tool.Context[] = []
      const location = contextual(locationContexts)
      yield* registry.register({ shared: location })
      yield* applications.register({ shared: contextual(applicationContexts) })

      expect(
        (yield* toolDefinitions(registry, [{ action: "shared", resource: "*", effect: "deny" }])).map(
          (definition) => definition.name,
        ),
      ).toEqual([])
      expect(
        yield* settleTool(registry, {
          sessionID,
          agent,
          assistantMessageID,
          call: { type: "tool-call", id: "call-shared", name: "shared", input: { query: "location" } },
        }),
      ).toMatchObject({ result: { type: "content" } })
      expect(locationContexts).toEqual([
        { sessionID, agent, assistantMessageID, toolCallID: "call-shared", attachmentPaths: new Set() },
      ])
      expect(applicationContexts).toEqual([])
    }),
  )
})
