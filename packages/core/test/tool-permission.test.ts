import { afterAll, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { PermissionV2 } from "@novaclaw/core/permission"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SessionStore } from "@novaclaw/core/session/store"
import { PermissionTool } from "@novaclaw/core/tool/permission"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool } from "./lib/tool"

// Auto mode's TOOL. The ceiling algebra is pinned by `auto-mode-algebra.test.ts` and the live
// evaluator by `permission-auto-mode.test.ts`; this file proves the tool gathers the right state,
// spends the right permission action, and — the ruling-2 half — never reports a move it did not make.

const assertions: PermissionV2.AssertInput[] = []
/** Drives the consent card's answer. ⚠️ Set it EXPLICITLY to refuse; never "negative-control" a
 *  permission gate by removing a rule, because the assert then resolves to `ask` and parks on
 *  `Deferred.await` with nothing to reap it. */
let assertFailure: PermissionV2.Error | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.gen(function* () {
        assertions.push(input)
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
      SessionStore.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      PermissionTool.node,
    ]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const insert = (input: {
  readonly id: string
  readonly type?: "interactive" | "sub-agent" | "auto-prompting" | "goal-oriented"
  readonly permissionMode?: "plan" | "ask" | "surgical" | "bypass" | "yolo"
}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make(input.id),
        slug: input.id,
        directory: "/project",
        title: input.id,
        version: "test",
        agent: "build",
        ...(input.type ? { type: input.type } : {}),
        ...(input.permissionMode ? { permission_mode: input.permissionMode } : {}),
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = Effect.sync(() => {
  assertions.length = 0
  assertFailure = undefined
  PermissionV2.clearAutoGrants()
})

// ⚠️ `bun test` runs every file of a unit in ONE process and the grant map is process-global, so a
// file that leaves grants behind changes `anyAutoGrant()` for whatever runs next. Harmless (the ids
// are unique, so a later session folds to `undefined`) but it would make this file a suspect the
// next time somebody bisects a core failure. Clean up after ourselves.
afterAll(() => {
  PermissionV2.clearAutoGrants()
})

const REASON = "the plan is agreed and I now need to edit src/ to apply it"

const call = (
  sessionID: string,
  input: { op: "raise" | "lower"; mode: string; justification?: string },
  id = `call-${sessionID}-${input.op}-${input.mode}`,
) => ({
  sessionID: SessionV2.ID.make(sessionID),
  ...toolIdentity,
  call: {
    type: "tool-call" as const,
    id,
    name: PermissionTool.name,
    input: { op: input.op, mode: input.mode, justification: input.justification ?? REASON },
  },
})

describe("the `permission` tool (Auto mode)", () => {
  it.effect("registers under its own name — no `withPermission` wrap that repeats the key", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      // `Tool.validateRegistration` REFUSES a tool whose declared action equals its registration
      // key, so a `Tool.withPermission(tool, "permission")` wrap would have died at registration.
      // Reaching this line at all is the check; the name is what the model actually sees.
      const materialized = yield* registry.materialize()
      expect(materialized.definitions).toEqual([])
      expect(materialized.deferred.map((source) => source.definition.name)).toEqual([PermissionTool.name])
      // The second action it spends is a DIFFERENT word, or the split buys nothing.
      expect(PermissionTool.PRIVILEGED_ACTION).not.toBe(PermissionTool.name)
    }),
  )

  it.effect("LOWERING is granted without a card, and the grant is what the evaluator will read", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insert({ id: "ses_tool_lower", permissionMode: "bypass" })
      const registry = yield* ToolRegistry.Service

      const result = yield* executeTool(
        registry,
        call("ses_tool_lower", { op: "lower", mode: "plan", justification: "reading first; changing nothing yet" }),
      )
      expect(result.type).toBe("text")
      expect(result.value).toContain("LOWERED")
      expect(result.value).toContain("reading first; changing nothing yet")
      // "Lowering is always permitted and never asks."
      expect(assertions).toEqual([])
      expect(PermissionV2.autoGrant("ses_tool_lower")?.mode).toBe("plan")
    }),
  )

  it.effect("RAISING back inside the ceiling is granted without a card — an unattended run cannot brick", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insert({ id: "ses_tool_back", type: "goal-oriented", permissionMode: "bypass" })
      const registry = yield* ToolRegistry.Service

      yield* executeTool(registry, call("ses_tool_back", { op: "lower", mode: "plan" }))
      const result = yield* executeTool(registry, call("ses_tool_back", { op: "raise", mode: "bypass" }))

      expect(result.type).toBe("text")
      expect(result.value).toContain("RAISED")
      // The whole reason the card sits at `yolo` and not lower: nobody is present to answer here, so
      // a card on this raise would strand the run at `plan` for the rest of its life.
      expect(assertions).toEqual([])
      expect(PermissionV2.autoGrant("ses_tool_back")?.mode).toBe("bypass")
    }),
  )

  it.effect("a raise PAST the user's pick is refused, and writes nothing", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insert({ id: "ses_tool_ceiling", permissionMode: "plan" })
      const registry = yield* ToolRegistry.Service

      const result = yield* executeTool(registry, call("ses_tool_ceiling", { op: "raise", mode: "bypass" }))
      expect(result.type).toBe("error")
      expect(result.value).toContain("the user set this chat to")
      expect(assertions).toEqual([])
      expect(PermissionV2.autoGrant("ses_tool_ceiling")).toBeUndefined()
    }),
  )

  it.effect("an empty justification is refused, and the level is untouched", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insert({ id: "ses_tool_blank", permissionMode: "bypass" })
      const registry = yield* ToolRegistry.Service

      const blank = yield* executeTool(
        registry,
        call("ses_tool_blank", { op: "lower", mode: "plan", justification: "   " }),
      )
      expect(blank.type).toBe("error")
      expect(blank.value).toContain("empty")
      expect(PermissionV2.autoGrant("ses_tool_blank")).toBeUndefined()

      // NEGATIVE CONTROL: the identical call with a real justification lands, so the refusal above
      // is the justification and nothing else about this session.
      const written = yield* executeTool(registry, call("ses_tool_blank", { op: "lower", mode: "plan" }))
      expect(written.type).toBe("text")
      expect(PermissionV2.autoGrant("ses_tool_blank")?.mode).toBe("plan")
    }),
  )

  it.effect("a return to `yolo` routes through the EXISTING permission ask, per-mode scoped", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insert({ id: "ses_tool_yolo", permissionMode: "yolo" })
      const registry = yield* ToolRegistry.Service

      yield* executeTool(registry, call("ses_tool_yolo", { op: "lower", mode: "plan" }))
      expect(assertions).toEqual([])

      const result = yield* executeTool(registry, call("ses_tool_yolo", { op: "raise", mode: "yolo" }))
      expect(result.type).toBe("text")
      expect(PermissionV2.autoGrant("ses_tool_yolo")?.mode).toBe("yolo")
      // A SEPARATE action from the tool's own name, and `save` scoped to the mode rather than `*`:
      // an "always" answer means "this agent may return to yolo", never "…may do anything".
      expect(assertions).toMatchObject([
        {
          action: PermissionTool.PRIVILEGED_ACTION,
          resources: ["yolo"],
          save: ["yolo"],
          metadata: { from: "plan", justification: REASON },
        },
      ])
    }),
  )

  it.effect("a REFUSED card leaves the level exactly where it was — ruling 2", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insert({ id: "ses_tool_refused", permissionMode: "yolo" })
      const registry = yield* ToolRegistry.Service

      yield* executeTool(registry, call("ses_tool_refused", { op: "lower", mode: "plan" }))
      // Drive the refusal EXPLICITLY (see the note on `assertFailure`).
      assertFailure = new PermissionV2.RejectedError()

      const result = yield* executeTool(registry, call("ses_tool_refused", { op: "raise", mode: "yolo" }))
      expect(result.type).toBe("error")
      expect(result.value).toContain("unchanged")
      // The denial keeps its own identity instead of collapsing into a generic tool error.
      expect(result.value).toContain(PermissionV2.denialMessage(new PermissionV2.RejectedError()) ?? "<missing>")
      // The write happens AFTER the card, so a refusal cannot half-apply.
      expect(PermissionV2.autoGrant("ses_tool_refused")?.mode).toBe("plan")
    }),
  )

  it.effect("an UNATTENDED root cannot reach `yolo` — refused before any card is ever raised", () =>
    Effect.gen(function* () {
      yield* setup
      // The user set yolo on a scheduled chain: the one posture that escapes the deny-fast stance.
      yield* insert({ id: "ses_tool_unattended", type: "goal-oriented", permissionMode: "yolo" })
      const registry = yield* ToolRegistry.Service

      yield* executeTool(registry, call("ses_tool_unattended", { op: "lower", mode: "bypass" }))
      const result = yield* executeTool(registry, call("ses_tool_unattended", { op: "raise", mode: "yolo" }))

      expect(result.type).toBe("error")
      expect(result.value).toContain("UNATTENDED")
      // The cap is MECHANICAL, not a card nobody could answer: no assert was spent at all.
      expect(assertions).toEqual([])
      expect(PermissionV2.autoGrant("ses_tool_unattended")?.mode).toBe("bypass")

      // NEGATIVE CONTROL: the identical sequence on an ATTENDED root does reach the card, so the
      // refusal above is the attendance cap rather than something about `yolo` in general.
      yield* insert({ id: "ses_tool_attended", permissionMode: "yolo" })
      yield* executeTool(registry, call("ses_tool_attended", { op: "lower", mode: "bypass" }))
      const attended = yield* executeTool(registry, call("ses_tool_attended", { op: "raise", mode: "yolo" }))
      expect(attended.type).toBe("text")
      expect(assertions).toHaveLength(1)
    }),
  )
})
