import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { PermissionV2 } from "@novaclaw/core/permission"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionComponentRegistry } from "@novaclaw/core/session/component-registry"
import { SessionComponentTier } from "@novaclaw/core/session/component-tier"
import { SessionComponentTable, SessionTable } from "@novaclaw/core/session/sql"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionTool } from "@novaclaw/core/tool/session"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { executeTool, toolIdentity } from "./lib/tool"

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})

type Asserted = { action: string; resources: readonly string[]; save?: readonly string[] }
const recording = (asserted: Asserted[]) =>
  Layer.mock(PermissionV2.Service, {
    assert: (input) =>
      Effect.sync(() =>
        asserted.push({
          action: input.action,
          resources: input.resources,
          ...(input.save ? { save: input.save } : {}),
        }),
      ),
  })

let sequence = 0
const withTool = <A, E, R>(
  asserted: Asserted[],
  body: (input: {
    registry: ToolRegistry.Interface
    db: Database.Interface["db"]
    sessionID: SessionSchema.ID
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessionID = SessionSchema.ID.make(`ses_session_tool_${++sequence}`)
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, slug: String(sessionID), directory: process.cwd(), title: "session tool", version: "test" })
      .run()
      .pipe(Effect.orDie)
    return yield* body({ registry: yield* ToolRegistry.Service, db, sessionID })
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          SessionTool.node,
          SessionComponentRegistry.node,
          SessionProjector.node,
          Database.node,
          EventV2.node,
        ]),
        [
          [ToolOutputStore.node, outputStore],
          [PermissionV2.node, recording(asserted)],
        ],
      ),
    ),
  )

const call = (registry: ToolRegistry.Interface, sessionID: SessionSchema.ID, input: unknown) =>
  executeTool(registry, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call", id: `call-session-${++sequence}`, name: "session", input },
  })

const textOf = (result: { value: unknown }) => String(result.value)

describe("session tool", () => {
  test("classifies every closed kernel kind and fails tool-owned kinds closed", () => {
    expect(Object.keys(SessionComponentTier.KERNEL_KIND_TIERS).sort()).toEqual(
      [...SessionComponentRegistry.KERNEL_KIND_NAMES].sort(),
    )
    expect(SessionComponentTier.tierOf("system_prompt_override")).toBe("privileged")
    expect(SessionComponentTier.tierOf("tool/fixture/marker")).toBe("privileged")
    expect(SessionComponentTier.TIER_ACTION).toEqual({
      consequential: "session",
      privileged: "session_privileged",
    })
  })

  test("projects the prompt override through its canonical row and retires a second component store", () => {
    const asserted: Asserted[] = []
    return Effect.runPromise(
      withTool(asserted, ({ registry, db, sessionID }) =>
        Effect.gen(function* () {
          const schema = yield* call(registry, sessionID, { op: "schema", kind: "system_prompt_override" })
          expect(textOf(schema)).toContain("system_prompt_override [singleton, entity, privileged]")

          const absent = yield* call(registry, sessionID, { op: "read", kind: "system_prompt_override" })
          expect(textOf(absent)).toContain("declares no system_prompt_override")

          const set = yield* call(registry, sessionID, {
            op: "set",
            kind: "system_prompt_override",
            value: "Keep explanations concrete.",
          })
          expect(textOf(set)).toContain("override replaced")
          expect(asserted).toEqual([
            { action: "session_privileged", resources: ["system_prompt_override"], save: ["system_prompt_override"] },
          ])

          const row = yield* db
            .select({ override: SessionTable.system_prompt_override })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(Effect.orDie)
          expect(row?.override).toBe("Keep explanations concrete.")
          expect(
            yield* db
              .select()
              .from(SessionComponentTable)
              .where(eq(SessionComponentTable.session_id, sessionID))
              .all()
              .pipe(Effect.orDie),
          ).toEqual([])

          const identical = yield* call(registry, sessionID, {
            op: "set",
            kind: "system_prompt_override",
            value: "Keep explanations concrete.",
          })
          expect(textOf(identical)).toContain("override unchanged")
          expect(asserted).toHaveLength(1)

          const removed = yield* call(registry, sessionID, { op: "remove", kind: "system_prompt_override" })
          expect(textOf(removed)).toContain("override cleared")
          const cleared = yield* db
            .select({ override: SessionTable.system_prompt_override })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(Effect.orDie)
          expect(cleared?.override).toBeNull()
        }),
      ),
    )
  })

  test("validates before asking and names unknown or malformed writes", () => {
    const asserted: Asserted[] = []
    return Effect.runPromise(
      withTool(asserted, ({ registry, sessionID }) =>
        Effect.gen(function* () {
          const malformed = yield* call(registry, sessionID, {
            op: "set",
            kind: "system_prompt_override",
            value: 42,
          })
          expect(malformed.type).toBe("error")
          expect(textOf(malformed)).toContain("system_prompt_override")

          const unknown = yield* call(registry, sessionID, { op: "remove", kind: "mystery" })
          expect(unknown.type).toBe("error")
          expect(textOf(unknown)).toContain("Unknown session component kind: mystery")
          expect(asserted).toEqual([])
        }),
      ),
    )
  })

  test("discovers and manages a tool-owned namespaced component through the same grammar", () => {
    const asserted: Asserted[] = []
    return Effect.runPromise(
      withTool(asserted, ({ registry, sessionID }) =>
        Effect.gen(function* () {
          const components = yield* SessionComponentRegistry.Service
          yield* components.registerTool(
            SessionComponentRegistry.toolDefinition("fixture", {
              name: "marker",
              description: "A fixture-owned durable marker",
              cardinality: "singleton",
              lifetime: "entity",
              version: 1,
              codec: Schema.Struct({ label: Schema.NonEmptyString }),
            }),
          )

          const schema = yield* call(registry, sessionID, { op: "schema", kind: "tool/fixture/marker" })
          expect(textOf(schema)).toContain("tool/fixture/marker [singleton, entity, privileged]")

          const set = yield* call(registry, sessionID, {
            op: "set",
            kind: "tool/fixture/marker",
            value: { label: "ready" },
          })
          expect(textOf(set)).toContain('{"label":"ready"}')
          expect(asserted).toEqual([
            { action: "session_privileged", resources: ["tool/fixture/marker"], save: ["tool/fixture/marker"] },
          ])

          const read = yield* call(registry, sessionID, { op: "read", kind: "tool/fixture/marker" })
          expect(textOf(read)).toContain('"label":"ready"')
          const listed = yield* call(registry, sessionID, { op: "list", kind: "tool/fixture/marker" })
          expect(textOf(listed)).toContain('"label":"ready"')
        }),
      ),
    )
  })
})
