import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { Config } from "@novaclaw/core/config"
import { ConfigTier } from "@novaclaw/core/config-tier"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { ProjectFileCache } from "@novaclaw/core/project-file-cache"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SettingsConfigSeed } from "@novaclaw/core/settings-config-seed"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { ToolPolicy } from "@novaclaw/core/tool-policy"
import { ToolPolicyBuiltin } from "@novaclaw/core/tool-policy-builtin"
import { ToolPolicyGate } from "@novaclaw/core/tool-policy-gate"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { Tool } from "@novaclaw/core/tool/tool"
import { Tools } from "@novaclaw/core/tool/tools"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { toolIdentity } from "./lib/tool"

/**
 * `` → **Typed pre-action policies**, the MANAGEMENT half.
 *
 * The kernel could compose, refuse, patch and record from the day it landed, and a person could
 * neither see which policies were installed nor decide which of them ran. This file covers the
 * second half: `list()` — what a management surface is shown — and `config.tool_policy.<id>.enabled`
 * — the one switch that stops a policy being consulted.
 *
 * 🔴 Every case drives the REAL `ToolRegistry.materialize().settle(…)` against a tool that really
 * runs, and writes the switch through the REAL settings store, so what is proved is that the next
 * tool call changes behaviour — not that a boolean was stored.
 */

const sessionID = SessionV2.ID.make("ses_policy_mgmt")
const agent = AgentV2.ID.make("build")

const echo = Tool.make({
  description: "Echo a command back",
  input: Schema.Struct({ command: Schema.String }),
  output: Schema.Struct({ ran: Schema.String }),
  execute: ({ command }) => Effect.succeed({ ran: command }),
  toModelOutput: ({ output }) => [{ type: "text", text: `ran: ${output.ran}` }],
})

const permissionStub = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
  }),
)

const graph = (directory: string) =>
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      ProjectFileCache.node,
      Config.node,
      SettingsConfigStore.node,
      ToolPolicyGate.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
    ]),
    [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
      [PermissionV2.node, permissionStub],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  )

interface Harness {
  readonly registry: ToolRegistry.Interface
  readonly gate: ToolPolicyGate.Interface
  readonly settings: SettingsConfigStore.Interface
  readonly directory: string
}

function withHarness<A>(
  body: (harness: Harness) => Effect.Effect<A, any, any>,
  options: { readonly project?: Record<string, unknown> } = {},
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (held) => Effect.promise(() => held[Symbol.asyncDispose]()),
      )
      if (options.project)
        yield* Effect.promise(() =>
          fs.writeFile(path.join(tmp.path, "novaclaw.json"), JSON.stringify(options.project, null, 2)),
        )
      return yield* Effect.gen(function* () {
        const tools = yield* Tools.Service
        yield* tools.register({ echo }).pipe(Effect.orDie)
        const { db } = yield* Database.Service
        yield* db
          .insert(SessionTable)
          .values({ id: sessionID, slug: "mgmt", directory: tmp.path, title: "mgmt", version: "test", agent: "build" })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        return yield* body({
          registry: yield* ToolRegistry.Service,
          gate: yield* ToolPolicyGate.Service,
          settings: yield* SettingsConfigStore.Service,
          directory: tmp.path,
        }).pipe(Effect.orDie)
      }).pipe(Effect.provide(graph(tmp.path))) as Effect.Effect<A, never, never>
    }).pipe(Effect.scoped),
  )
}

const call = (registry: ToolRegistry.Interface, command: string, id = "call-mgmt") =>
  registry
    .materialize([], () => true, new Set(["echo"]))
    .pipe(
      Effect.flatMap((materialized) =>
        materialized.settle({
          sessionID,
          ...toolIdentity,
          agent,
          call: { type: "tool-call", id, name: "echo", input: { command } },
        }),
      ),
    )

const provider = (id: string, outcome: ToolPolicy.Outcome, extra: Partial<ToolPolicy.Provider> = {}) =>
  ({ id, describe: `what ${id} does`, evaluate: () => Effect.succeed(outcome), ...extra }) satisfies ToolPolicy.Provider

const resultText = (result: { readonly type: string; readonly value: unknown }) =>
  typeof result.value === "string" ? result.value : JSON.stringify(result.value)

describe("list() — what a management surface is shown", () => {
  test("names every installed policy, what it does, and how it behaves", async () => {
    const rows = await withHarness(({ gate }) =>
      Effect.gen(function* () {
        yield* gate
          .install([
            provider("z-advisor", { type: "allow" }, { alwaysOn: false, safetyCritical: false }),
            provider("a-guard", { type: "allow" }),
          ])
          .pipe(Effect.orDie)
        return yield* gate.list()
      }).pipe(Effect.scoped),
    )
    // Sorted by id, so a list that is read twice reads the same way.
    expect(rows.map((row) => row.id)).toEqual(["a-guard", "z-advisor"])
    expect(rows[0]).toEqual({
      id: "a-guard",
      describe: "what a-guard does",
      // 🔴 The two defaults are surfaced as the values they DEFAULT to, not as absences. A
      // management screen that showed `alwaysOn: undefined` would have to re-derive the kernel's
      // "an operator who installed a guard installed it to run" rule, and a second derivation of a
      // safety default is one too many.
      alwaysOn: true,
      safetyCritical: true,
      enabled: true,
    })
    expect(rows[1]).toEqual({
      id: "z-advisor",
      describe: "what z-advisor does",
      alwaysOn: false,
      safetyCritical: false,
      enabled: true,
    })
  })

  test("the SHIPPED policies are listed with the descriptions they carry", async () => {
    const rows = await withHarness(({ gate }) =>
      Effect.gen(function* () {
        yield* gate.install(ToolPolicyBuiltin.BUILTINS).pipe(Effect.orDie)
        return yield* gate.list()
      }).pipe(Effect.scoped),
    )
    expect(rows.map((row) => row.id)).toEqual(["git-no-pager", "irreversible-shell"])
    // Not a copy of the string: the surface shows the provider's own sentence, whoever wrote it.
    for (const row of rows) {
      const builtin = ToolPolicyBuiltin.BUILTINS.find((entry) => entry.id === row.id)!
      expect(row.describe).toBe(builtin.describe)
    }
    // ⚠️ The advisory one is advisory here too — this is the field that tells a reader why one
    // policy failing closed refuses their call and the other one does not.
    expect(rows.find((row) => row.id === "git-no-pager")?.safetyCritical).toBe(false)
    expect(rows.find((row) => row.id === "irreversible-shell")?.safetyCritical).toBe(true)
  })
})

describe("the switch, driven through a real tool call", () => {
  test("🔴 a disabled policy is not consulted — and the change lands on the NEXT call, not the next boot", async () => {
    const observed = await withHarness(({ registry, gate, settings }) =>
      Effect.gen(function* () {
        yield* gate.install([provider("blocker", { type: "deny", reason: "no" })]).pipe(Effect.orDie)

        const before = yield* call(registry, "hello")
        expect(before.result.type).toBe("error")

        // The same instance, no restart, no reload trigger.
        yield* settings.set("tool_policy", { blocker: { enabled: false } })
        const after = yield* call(registry, "hello", "call-mgmt-2")

        yield* settings.set("tool_policy", { blocker: { enabled: true } })
        const again = yield* call(registry, "hello", "call-mgmt-3")

        return [before.result.type, resultText(after.result), again.result.type]
      }).pipe(Effect.scoped),
    )
    expect(observed[0]).toBe("error")
    // Off: the call runs untouched.
    expect(observed[1]).toBe("ran: hello")
    // 🔴 And back ON again. A switch that only worked in the disabling direction would leave a user
    // unable to undo it, which is how a safety control becomes a one-way door.
    expect(observed[2]).toBe("error")
  })

  test("list() reports the switch, so the screen and the gate cannot disagree", async () => {
    const rows = await withHarness(({ gate, settings }) =>
      Effect.gen(function* () {
        yield* gate.install([provider("a", { type: "allow" }), provider("b", { type: "allow" })]).pipe(Effect.orDie)
        yield* settings.set("tool_policy", { b: { enabled: false } })
        return yield* gate.list()
      }).pipe(Effect.scoped),
    )
    expect(rows.map((row) => [row.id, row.enabled])).toEqual([
      ["a", true],
      ["b", false],
    ])
  })

  test("a switch for a policy that is not installed changes nothing and lists nothing", async () => {
    const rows = await withHarness(({ gate, settings }) =>
      Effect.gen(function* () {
        yield* gate.install([provider("a", { type: "allow" })]).pipe(Effect.orDie)
        yield* settings.set("tool_policy", { "long-gone": { enabled: false } })
        return yield* gate.list()
      }).pipe(Effect.scoped),
    )
    // The list is the INSTALLED set, never the stored decisions. A stale row must not conjure a
    // policy onto a screen that promises to say what is running right now.
    expect(rows.map((row) => row.id)).toEqual(["a"])
  })
})

describe("a folder that declared a policy the user then switched off", () => {
  test("🔴 is REFUSED, and the refusal names the switch rather than telling the model to install something", async () => {
    const message = await withHarness(
      ({ registry, gate, settings }) =>
        Effect.gen(function* () {
          yield* gate.install([provider("opt-in-guard", { type: "allow" }, { alwaysOn: false })]).pipe(Effect.orDie)
          yield* settings.set("tool_policy", { "opt-in-guard": { enabled: false } })
          const settlement = yield* call(registry, "hello")
          return resultText(settlement.result)
        }).pipe(Effect.scoped),
      { project: { version: 1, policies: ["opt-in-guard"] } },
    )
    // The direction is fail-closed, exactly as for a policy that was never installed: a folder that
    // asked for a guard and did not get one is refused rather than run unpoliced.
    expect(message).toContain("Refused before running")
    expect(message).toContain("opt-in-guard")
    // 🔴 The two reasons get DIFFERENT sentences. "Install it" and "switch it back on" are opposite
    // actions, and a model told the wrong one spends the rest of the turn on it.
    expect(message).toContain("switched OFF in Settings")
    expect(message).not.toContain("not installed in this NovaClaw")
    // And it says who can fix it, because the session provably cannot.
    expect(message).toContain("Only the person at this computer")
  })

  test("a policy nobody's folder declared simply stops being consulted — no refusal", async () => {
    const text = await withHarness(({ registry, gate, settings }) =>
      Effect.gen(function* () {
        yield* gate.install([provider("blocker", { type: "deny", reason: "no" })]).pipe(Effect.orDie)
        yield* settings.set("tool_policy", { blocker: { enabled: false } })
        const settlement = yield* call(registry, "hello")
        return resultText(settlement.result)
      }).pipe(Effect.scoped),
    )
    expect(text).toBe("ran: hello")
  })

  test("a folder naming a policy that was never installed still gets the OTHER refusal", async () => {
    const message = await withHarness(
      ({ registry, gate }) =>
        Effect.gen(function* () {
          yield* gate.install([provider("present", { type: "allow" })]).pipe(Effect.orDie)
          const settlement = yield* call(registry, "hello")
          return resultText(settlement.result)
        }).pipe(Effect.scoped),
      { project: { version: 1, policies: ["absent"] } },
    )
    expect(message).toContain("not installed in this NovaClaw")
    expect(message).not.toContain("switched OFF in Settings")
  })
})

/**
 * ``: *"A folder's policy list is READ-ONLY in the app — wants the section-scoped
 * write Permissions got."* Before a write surface existed, the property below was enforced by the
 * TYPE and by nothing else — `policies` is an array of ids, so a removal had no spelling. A write
 * surface is exactly what could grow one, so the property is pinned here as behaviour.
 *
 * 🔴 **The claim: no `policies` section can stop an installed always-on policy being consulted.** A
 * folder that could is a cloned repository disarming the user's rails, and the reader is where that
 * has to hold — `ProjectFileWrite.writablePolicies` only keeps our own writer honest, and an
 * attacker's file never goes through it.
 *
 * ⚠️ **A/B, run by hand and reported:** change the gate's applicability filter from
 * `ToolPolicy.alwaysOn(provider) || wanted.has(provider.id)` to `wanted.has(provider.id)` — all
 * three cases below go red.
 */
describe("what a folder's policy list can NEVER do", () => {
  const drives = [
    ["with no project file at all", undefined],
    ["with an empty list", { version: 1, policies: [] }],
    ["with a list naming a DIFFERENT installed policy", { version: 1, policies: ["other-guard"] }],
  ] as const

  for (const [label, project] of drives)
    test(`an always-on policy still refuses the call ${label}`, async () => {
      const text = await withHarness(
        ({ registry, gate }) =>
          Effect.gen(function* () {
            // Always-on by default — `alwaysOn` is `!== false`, the safe direction: an operator who
            // installed a guard installed it to run.
            yield* gate
              .install([
                provider("blocker", { type: "deny", reason: "no" }),
                // Opt-in and permissive, so the third arm's list is a real, honoured declaration
                // rather than a missing-policy refusal wearing the same clothes.
                provider("other-guard", { type: "allow" }, { alwaysOn: false }),
              ])
              .pipe(Effect.orDie)
            const settlement = yield* call(registry, "hello")
            return resultText(settlement.result)
          }).pipe(Effect.scoped),
        project === undefined ? {} : { project: project as Record<string, unknown> },
      )
      // Refused in every arm, by the always-on policy itself — not by the fail-closed missing-policy
      // path, which would be a different refusal wearing the same clothes.
      expect(text).not.toBe("ran: hello")
      expect(text).toContain("Refused by an installed policy before this call ran")
      expect(text).toContain("blocker")
    })
})

describe("the fold from stored switches to the OFF set", () => {
  test("absent means ON, and only an explicit `false` switches anything off", () => {
    expect([...ToolPolicy.disabledPolicies([])]).toEqual([])
    expect([...ToolPolicy.disabledPolicies([undefined])]).toEqual([])
    // An entry with no `enabled` at all is a row a surface wrote and then cleared — not an "off".
    expect([...ToolPolicy.disabledPolicies([{ a: {} }])]).toEqual([])
    expect([...ToolPolicy.disabledPolicies([{ a: { enabled: true } }])]).toEqual([])
    expect([...ToolPolicy.disabledPolicies([{ a: { enabled: false } }])]).toEqual(["a"])
  })

  test("🔴 last writer wins in BOTH directions — a later document can switch one back ON", () => {
    expect([...ToolPolicy.disabledPolicies([{ a: { enabled: false } }, { a: { enabled: true } }])]).toEqual([])
    expect([...ToolPolicy.disabledPolicies([{ a: { enabled: true } }, { a: { enabled: false } }])]).toEqual(["a"])
    // Untouched ids are carried through rather than reset by the later document.
    expect([
      ...ToolPolicy.disabledPolicies([{ a: { enabled: false }, b: { enabled: false } }, { a: { enabled: true } }]),
    ]).toEqual(["b"])
  })
})

describe("the key is declared everywhere an undeclared settings key would bite", () => {
  // ⚠️ An undeclared settings key is accepted by the write, stored, and then bricks the NEXT BOOT
  // when the synthetic settings document fails to decode. All three declarations below are load
  // bearing, and only the third one's absence is silent.
  test("it decodes as part of the settings document, so a stored switch survives a restart", () => {
    const settings = SettingsConfigSeed.settingsInfoFromStore({
      tool_policy: { "git-no-pager": { enabled: false } },
    })
    expect(settings.skipped).toEqual([])
    expect(settings.info?.tool_policy).toEqual({ "git-no-pager": { enabled: false } })
  })

  test("⛔ it is PRIVILEGED, so an agent cannot switch a guard off without a consent card", () => {
    // The tier decides whether a `configure` write asks. Turning a pre-action policy off removes a
    // gate from the agent's OWN path, which is a capability grant however small the diff looks.
    expect(ConfigTier.tierOf("tool_policy")).toBe("privileged")
  })

  test("a malformed switch is skipped and REPORTED, never silently applied", () => {
    const settings = SettingsConfigSeed.settingsInfoFromStore({
      tool_policy: { "git-no-pager": { enabled: "sometimes" } },
    })
    expect(settings.skipped.map((entry) => entry.key)).toEqual(["tool_policy"])
    // The rest of the document survives — one bad row must not revert every other setting.
    expect(settings.info?.tool_policy).toBeUndefined()
  })
})
