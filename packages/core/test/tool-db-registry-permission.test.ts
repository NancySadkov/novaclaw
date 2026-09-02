import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { DbRegistry } from "@novaclaw/core/db-registry"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { PermissionV2 } from "@novaclaw/core/permission"
import { AgentPlugin } from "@novaclaw/core/plugin/agent"
import { SessionV2 } from "@novaclaw/core/session"
import { MODE_RULES } from "@novaclaw/core/session/config-resolve"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { DbRegistryTool } from "@novaclaw/core/tool/db-registry"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { ToolPolicyGate } from "@novaclaw/core/tool-policy-gate"
import { it } from "./lib/effect"
import { bypassedPolicyGate, executeTool, toolIdentity } from "./lib/tool"

/**
 * **The `registry` tool's write GATE** — the half of the raw-database surface that a refusal list
 * cannot cover.
 *
 * The refusals pinned in `tool-db-registry.test.ts` close the escalation: an agent may not rewrite
 * the tiers `configure` enforces nor the verdicts the evaluator reads. They said nothing about the
 * other ~50 tables, so a raw agent write to `credential`, `messenger_binding` or `agent_status` cost
 * ZERO consent while the same repair through a typed tool was gated — ruling 4's *unclassified ⇒
 * privileged* read backwards, on the widest surface in the instance.
 *
 * Four claims, and each is a way the obvious implementation goes wrong:
 *
 *  1. **A write SPENDS `registry_write`, scoped to the one table it names.** `resources`/`save` are
 *     the pattern a standing rule matches, so `["*"]` would turn one decision about `agent_status`
 *     into a standing grant over `credential` — `configure.ts`'s own `save: [key]` argument.
 *  2. **A refused table is NOT also charged.** The kernel and config refusals carry wording that
 *     says where the capability actually lives; charging first replaces it with a generic denial and
 *     makes a settled refusal look grantable. This is the double-charge control.
 *  3. **A refusal arrives AS a refusal, and nothing is written.**
 *  4. **The read path is untouched — ungated and still redacted.** That is round 1's design and
 *     `configure.ts`'s stated invariant: *"read is ungated precisely BECAUSE it is redacted."* A
 *     gate added to writes must not quietly acquire one.
 *
 * ⚠️ The last suite is the one that would rot silently: "absent from the baseline, therefore it
 * asks" is an inference over THREE shipped constants, and `bash` is the standing proof that a mode
 * overlay can grant what the baseline does not. So it is asserted over the real constants, with the
 * pre-B4c catch-all restored as the negative control.
 */

const sessionID = SessionV2.ID.make("ses_registry_tool_permission")

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})

/** Every `permission.assert` the tool made, in order. */
type Asserted = {
  action: string
  resources: readonly string[]
  save?: readonly string[]
  metadata?: Record<string, unknown>
}

const recording = (into: Asserted[]) =>
  Layer.mock(PermissionV2.Service, {
    assert: (input) =>
      Effect.sync(() => {
        into.push({
          action: input.action,
          resources: input.resources,
          ...(input.save ? { save: input.save } : {}),
          ...(input.metadata ? { metadata: input.metadata as Record<string, unknown> } : {}),
        })
      }),
  })

/** What a default install actually does with `registry_write`: refuse, with the product's wording. */
const denying = Layer.mock(PermissionV2.Service, {
  assert: () => Effect.fail(new PermissionV2.DeniedError({ rules: [], reason: "ask-removed" })),
})

/**
 * One graph over a real (`:memory:`) SQLite instance, so "the row changed" / "the row did not
 * change" is read from the store the product reads. The permission layer is a parameter because the
 * suites disagree about it on purpose.
 */
const withTool = <A, E, R>(
  permission: Layer.Layer<PermissionV2.Service>,
  body: (input: {
    registry: ToolRegistry.Interface
    settings: SettingsConfigStore.Interface
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    return yield* body({
      registry: yield* ToolRegistry.Service,
      settings: yield* SettingsConfigStore.Service,
    })
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          DbRegistryTool.node,
          Database.node,
          SettingsConfigStore.node,
        ]),
        [
          [ToolOutputStore.node, outputStore],
          [ToolPolicyGate.node, bypassedPolicyGate],
          [PermissionV2.node, permission],
        ],
      ),
    ),
  )

let callCounter = 0
const call = (registry: ToolRegistry.Interface, input: unknown) =>
  executeTool(registry, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call", id: `call-${++callCounter}`, name: DbRegistryTool.name, input },
  })

const textOf = (result: { type: string; value: unknown }) => String(result.value)

// ═══ 1. an ordinary write spends the action, scoped to its own table ═══════════════════════════

describe("registry tool: a row write spends `registry_write`", () => {
  it.live("an ordinary table is asserted per TABLE — never `*` — and the row lands once granted", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry }) =>
      Effect.gen(function* () {
        const result = yield* call(registry, {
          op: "insert",
          table: "data_migration",
          values: { name: "gate-probe", time_completed: 1 },
        })
        expect(result.type).not.toBe("error")

        expect(asserted).toEqual([
          {
            action: "registry_write",
            resources: ["data_migration"],
            save: ["data_migration"],
            metadata: { op: "insert", table: "data_migration" },
          },
        ])
        // 🔴 The wildcard this must never become, stated as its own assertion so a widened `save`
        // fails on the sentence that explains it rather than on a diff of an object literal.
        expect(asserted[0]!.save).not.toContain("*")
        expect(asserted[0]!.resources).not.toContain("*")
        // The action is NOT the registered tool name: `registry` is what the horizon filter reads
        // (`whollyDisabled`), so spending it would mean "withdraw the whole surface, reads included".
        expect(asserted[0]!.action).not.toBe(DbRegistryTool.name)

        // Granted ⇒ the write really happened. Without this the suite would pass against a tool
        // that asserted correctly and then did nothing.
        const rows = yield* DbRegistry.rows({ table: "data_migration", limit: 500 })
        expect(rows.rows.map((row) => row.values.name)).toContain("gate-probe")
      }),
    )
  })

  it.live("update and delete are charged too, each naming its own table", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry }) =>
      Effect.gen(function* () {
        yield* DbRegistry.insertRow({ table: "data_migration", values: { name: "before", time_completed: 1 } })
        const seeded = yield* DbRegistry.rows({ table: "data_migration", limit: 500 })
        const rowid = seeded.rows[0]!.rowid

        const updated = yield* call(registry, {
          op: "update",
          table: "data_migration",
          rowid,
          values: { name: "after" },
        })
        expect(updated.type).not.toBe("error")
        expect((yield* DbRegistry.rows({ table: "data_migration", limit: 500 })).rows[0]!.values.name).toBe("after")

        const deleted = yield* call(registry, { op: "delete", table: "data_migration", rowid })
        expect(deleted.type).not.toBe("error")
        expect((yield* DbRegistry.rows({ table: "data_migration", limit: 500 })).rowCount).toBe(0)

        expect(asserted.map((entry) => [entry.action, ...entry.resources])).toEqual([
          ["registry_write", "data_migration"],
          ["registry_write", "data_migration"],
        ])
      }),
    )
  })

  it.live("a refusal arrives as the deny-fast paragraph, and the row is untouched", () =>
    withTool(denying, ({ registry }) =>
      Effect.gen(function* () {
        yield* DbRegistry.insertRow({ table: "data_migration", values: { name: "survives", time_completed: 1 } })

        const result = yield* call(registry, {
          op: "insert",
          table: "data_migration",
          values: { name: "refused", time_completed: 2 },
        })
        expect(result.type).toBe("error")
        // The PRODUCT's wording, not the mock's — the mock's `DeniedError` carries no message at
        // all, which is precisely how `js`/`computer` lost theirs (`absorb-ledger.test.ts`).
        expect(textOf(result)).toContain("Permission denied")
        expect(textOf(result)).not.toContain("Unable to reach the instance database")

        const rows = yield* DbRegistry.rows({ table: "data_migration", limit: 500 })
        expect(rows.rows.map((row) => row.values.name)).toEqual(["survives"])
      }),
    ),
  )
})

// ═══ 2. the double-charge control ══════════════════════════════════════════════════════════════

describe("registry tool: a table this tool already REFUSES is not also charged", () => {
  it.live("the permission kernel's tables stay refused, in their own words, with no assert spent", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry }) =>
      Effect.gen(function* () {
        for (const table of DbRegistry.permissionKernelTables()) {
          const result = yield* call(registry, {
            op: "insert",
            table,
            values: { id: `prm_escalation_${table}`, action: "*", resource: "*", effect: "allow" },
          })
          expect(result.type).toBe("error")
          // Its OWN refusal, which names where the capability lives — not a permission denial that
          // reads as "grant this and it will work". It never will.
          expect(textOf(result)).toContain("permission kernel")
          expect(textOf(result)).not.toContain("Permission denied")
        }
        expect(asserted).toEqual([])
        expect((yield* DbRegistry.rows({ table: "permission", limit: 500 })).rowCount).toBe(0)
      }),
    )
  })

  it.live("a config-backed table is refused toward `configure`, with no assert spent", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry, settings }) =>
      Effect.gen(function* () {
        yield* settings.set("username", "unchanged")
        const rows = yield* DbRegistry.rows({ table: "runtime_setting", limit: 500 })
        const rowid = rows.rows[0]!.rowid

        const result = yield* call(registry, {
          op: "update",
          table: "runtime_setting",
          rowid,
          values: { value: JSON.stringify("written-by-agent") },
        })
        expect(result.type).toBe("error")
        expect(textOf(result)).toContain("`configure`")
        expect(textOf(result)).not.toContain("Permission denied")
        expect(asserted).toEqual([])
        expect((yield* settings.all()).username).toBe("unchanged")
      }),
    )
  })

  it.effect("the skip list is READ OFF the shared module, so it cannot go stale under it", () =>
    Effect.gen(function* () {
      // A hand-kept copy of those two sets in the tool is the failure this pins: `writeGate` must
      // answer `undefined` for every member of both, and a table for the whole set.
      for (const table of DbRegistry.permissionKernelTables())
        expect(DbRegistryTool.writeGate({ op: "delete", table, rowid: 1 })).toBeUndefined()
      for (const table of DbRegistry.configBackedTables())
        expect(DbRegistryTool.writeGate({ op: "delete", table, rowid: 1 })).toBeUndefined()
      // Non-empty, or every line above is a tautology.
      expect(DbRegistry.permissionKernelTables().size).toBeGreaterThan(0)
      expect(DbRegistry.configBackedTables().size).toBeGreaterThan(0)
      // …and the ordinary case is charged, which is what makes the `undefined`s above mean anything.
      expect(DbRegistryTool.writeGate({ op: "delete", table: "data_migration", rowid: 1 })).toBe("data_migration")
      // The migration journal is DELIBERATELY not skipped: it is refused to BOTH writers, so it is
      // not a question about this agent's privilege, and either verdict refuses the write.
      expect(DbRegistryTool.writeGate({ op: "delete", table: "migration", rowid: 1 })).toBe("migration")
    }),
  )
})

// ═══ 3. the read path is unchanged ═════════════════════════════════════════════════════════════

describe("registry tool: reads stay ungated and stay redacted", () => {
  it.live("`tables` and `rows` spend nothing, and a credential still comes back redacted", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry, settings }) =>
      Effect.gen(function* () {
        yield* settings.set("server", { port: 4096, hostname: "127.0.0.1", password: "s3cr3t-incoming-token" })
        yield* settings.set("username", "nancy")

        const tables = yield* call(registry, { op: "tables" })
        expect(textOf(tables)).toContain("runtime_setting")

        const rows = yield* call(registry, { op: "rows", table: "runtime_setting", limit: 500 })
        // Ungated — round 1's design, and `configure.ts`'s invariant: *read is ungated precisely
        // BECAUSE it is redacted*. Both halves, or neither is safe.
        expect(asserted).toEqual([])
        expect(textOf(rows)).not.toContain("s3cr3t-incoming-token")
        // BOTH DIRECTIONS: still a repair target, not a blanked row.
        expect(textOf(rows)).toContain("4096")
        expect(textOf(rows)).toContain("nancy")
        expect(textOf(rows)).toContain(DbRegistryTool.FOREIGN_LABEL)
      }),
    )
  })
})

// ═══ 4. the fall-through, asserted rather than inferred ════════════════════════════════════════

describe("`registry_write` falls through to ask on a default install", () => {
  // The build agent's shipped floor, read from the constant rather than copied — a literal copy is
  // exactly what cannot notice when what it mirrors changes.
  const floor = AgentPlugin.floor({ scratchDirs: [], officer: false })

  it.effect("no mode overlay grants it — including `bypass`, the default", () =>
    Effect.sync(() => {
      // The sweep can see something: `bash` IS granted by `bypass`, which is the standing proof that
      // "absent from the baseline" is not on its own an answer.
      expect(PermissionV2.evaluate("bash", "ls", [...floor, ...MODE_RULES.bypass]).effect).toBe("allow")

      for (const mode of ["plan", "ask", "surgical", "bypass", "yolo"] as const)
        expect({
          mode,
          effect: PermissionV2.evaluate(DbRegistryTool.WRITE_ACTION, "credential", [...floor, ...MODE_RULES[mode]])
            .effect,
        }).toEqual({ mode, effect: "ask" })

      // And it is not in the ambient-safe allowlist, which is the other half of the claim.
      expect(PermissionV2.AMBIENT_SAFE_BASELINE.map((rule) => rule.action)).not.toContain(
        DbRegistryTool.WRITE_ACTION,
      )
    }),
  )

  it.effect("NEGATIVE CONTROL: restore the pre-B4c catch-all and the write is granted silently", () =>
    Effect.sync(() => {
      // The one line B4c removed from `plugin/agent.ts`, put back where it stood. Without this the
      // test above would pass just as happily against an `ask` that came from somewhere else.
      const preB4c = [{ action: "*", resource: "*", effect: "allow" as const }, ...floor]
      for (const mode of ["bypass", "yolo"] as const)
        expect(
          PermissionV2.evaluate(DbRegistryTool.WRITE_ACTION, "credential", [...preB4c, ...MODE_RULES[mode]]).effect,
        ).toBe("allow")
    }),
  )
})
