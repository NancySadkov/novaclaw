import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { PermissionV2 } from "@novaclaw/core/permission"
import { Project } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SessionTodo } from "@novaclaw/core/session/todo"
import { TodoWriteTool } from "@novaclaw/core/tool/todowrite"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_todowrite_tool_test")
const assertions: PermissionV2.AssertInput[] = []
/**
 * Set to make the permission gate fail. ⚠️ `assert`'s error channel is
 * `PermissionV2.Error | SessionV2.NotFoundError` — and `PermissionV2.Error` is the module's own
 * union (`DeniedError | RejectedError | CorrectedError`), NOT the global `Error`. `denialMessage`
 * answers all three of those, so `NotFoundError` is the only member it declines, which makes it the
 * one honest negative control available here. `todos.update` is `Effect<void>` (its DB errors are
 * `orDie`'d), so nothing else in the tool's block can reach the absorber at all.
 */
let assertFailure: PermissionV2.Error | SessionV2.NotFoundError | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.gen(function* () {
        assertions.push(input)
        // No `return` — returning the failed effect widens the success channel to `undefined`,
        // which is not assignable to the interface's `Effect<void, …>`.
        if (assertFailure) yield* Effect.fail(assertFailure)
      }),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionTodo.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      TodoWriteTool.node,
    ]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const setup = Effect.gen(function* () {
  assertions.length = 0
  assertFailure = undefined
  const { db } = yield* Database.Service
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      slug: "todowrite",
      directory: "/project",
      title: "todowrite",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

const call = (todos: ReadonlyArray<SessionTodo.Info>, id = "call-todowrite") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: TodoWriteTool.name, input: { todos } },
})

describe("TodoWriteTool", () => {
  it.effect("registers, approves the wildcard resource, persists todos, and returns typed output", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* SessionTodo.Service
      const todoList: ReadonlyArray<SessionTodo.Info> = [
        { content: "Implement slice", status: "in_progress", priority: "high" },
      ]

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([TodoWriteTool.name])
      expect(yield* settleTool(registry, call(todoList))).toEqual({
        result: { type: "text", value: JSON.stringify(todoList, null, 2) },
        output: {
          structured: { todos: todoList },
          content: [{ type: "text", text: JSON.stringify(todoList, null, 2) }],
        },
      })
      expect(assertions).toMatchObject([{ sessionID, action: "todowrite", resources: ["*"], save: ["*"] }])
      expect(yield* service.get(sessionID)).toEqual(todoList)
    }),
  )

  // The blanket `mapError` used to ignore its error, so a permission verdict reached the model as
  // "Unable to update todos" — indistinguishable from a transient fault and therefore worth
  // retrying, with a reject's user feedback erased along the way.
  //
  // ⚠️ Pinned over EVERY member of `PermissionV2.Error`, not one specimen: `assert` may raise any of
  // the three and `denialMessage` answers all three, so a check over a single member would leave
  // the others free to collapse silently — the defect class ruling 1 names. The `reason` variants
  // are covered for the same reason (each is a DIFFERENT string from `denialMessage`); this is a
  // statement about what the absorber must not throw away, not a claim about which verdict this
  // action reaches in production.
  const denialCases = [
    {
      kind: "a policy denial",
      failure: new PermissionV2.DeniedError({ rules: [{ action: "todowrite", resource: "*", effect: "deny" }] }),
      contains: "todowrite",
    },
    {
      kind: "a deny-fast refusal with no answerer",
      failure: new PermissionV2.DeniedError({
        rules: [{ action: "todowrite", resource: "*", effect: "deny" }],
        reason: "unattended-unanswerable",
      }),
      contains: "UNATTENDED",
    },
    { kind: "a plain user rejection", failure: new PermissionV2.RejectedError(), contains: "declined" },
    {
      // The clause `permission.ts` names by name: "including the user's optional reject feedback".
      kind: "a rejection carrying user feedback",
      failure: new PermissionV2.CorrectedError({ feedback: "leave the list alone for now" }),
      contains: "leave the list alone for now",
    },
  ] as const

  for (const { kind, failure, contains } of denialCases)
    it.effect(`${kind} keeps its own text instead of collapsing into the todo fallback`, () =>
      Effect.gen(function* () {
        yield* setup
        const registry = yield* ToolRegistry.Service
        const service = yield* SessionTodo.Service
        yield* service.update({ sessionID, todos: [{ content: "keep", status: "pending", priority: "low" }] })
        assertFailure = failure

        const expected = PermissionV2.denialMessage(failure)
        // Guard the instrument: if `denialMessage` ever returned undefined or the fallback wording,
        // the assertion below would pass while proving nothing.
        expect(typeof expected).toBe("string")
        expect(expected).not.toBe("Unable to update todos")
        expect(expected).toContain(contains)

        expect(
          yield* executeTool(registry, call([{ content: "blocked", status: "completed", priority: "high" }])),
        ).toEqual({ type: "error", value: expected })
        // A refused mutation must not have happened — ruling 2's *a failed mutation never reports
        // success*, checked at the store rather than at the message.
        expect(yield* service.get(sessionID)).toEqual([{ content: "keep", status: "pending", priority: "low" }])
        expect(assertions).toMatchObject([{ sessionID, action: "todowrite", resources: ["*"], save: ["*"] }])
      }),
    )

  it.effect("NEGATIVE CONTROL: a non-permission failure still gets the todo fallback", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* SessionTodo.Service
      yield* service.update({ sessionID, todos: [{ content: "keep", status: "pending", priority: "low" }] })
      // A vanished session, not a denial — `denialMessage` declines it, so the else arm must still
      // answer. `todos.update` cannot fail (it is `Effect<void>`), so this is the ONLY error that
      // reaches the fallback, which is why the fallback may not describe itself as a denial.
      assertFailure = new SessionV2.NotFoundError({ sessionID })

      expect(PermissionV2.denialMessage(assertFailure)).toBeUndefined()
      expect(
        yield* executeTool(registry, call([{ content: "blocked", status: "completed", priority: "high" }])),
      ).toEqual({ type: "error", value: "Unable to update todos" })
      expect(yield* service.get(sessionID)).toEqual([{ content: "keep", status: "pending", priority: "low" }])
    }),
  )
})
