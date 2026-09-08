import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { Config } from "@novaclaw/core/config"
import { ConfigProjection } from "@novaclaw/core/config-projection"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { CapabilityRegistry } from "@novaclaw/core/effect/capability-registry"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { PermissionV2 } from "@novaclaw/core/permission"
import { SessionV2 } from "@novaclaw/core/session"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { ConfigureTool } from "@novaclaw/core/tool/configure"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { it } from "./lib/effect"
import { bypassedPolicyGate, executeTool, toolIdentity } from "./lib/tool"
import { ToolPolicyGate } from "@novaclaw/core/tool-policy-gate"

/**
 * The `configure` tool — todo.md ruling 4's privilege tiers, and AGENTS.md's self-healing law made
 * reachable from a model.
 *
 * What is pinned here, and why each would otherwise be a claim in a comment (ruling 1):
 *
 *  1. **Every `Config.Info` key is classified, in both directions, and an unclassified key is
 *     PRIVILEGED.** The `Record<keyof Config.Info, Tier>` annotation makes a new key a compile
 *     error; this makes it a test failure too, and additionally proves the RUNTIME fallback is safe
 *     rather than open — the two halves ruling 1 asks for.
 *  2. **The partition itself, by name.** Re-pricing a key is a legitimate decision and an invisible
 *     one: without this, moving `permissions` to `operational` would be a one-word diff that no check
 *     notices. Pinned as three sorted lists, so it shows up as a decision.
 *  3. **The tiers do different things.** A tier-1 write proceeds with NO consent card; a
 *     consequential one asks on `configure`; a privileged one asks on `configure_privileged`. The
 *     count of asserts is the whole claim, not a side effect of it.
 *  4. **Ruling 2.** A refused write changes nothing; an undeclared key is refused BY NAME rather
 *     than silently dropped; a key the router accepts and discards is not reported as stored.
 *  5. **The read op does not hand the model this instance's own credentials**, which is the only
 *     reason it is ungated.
 */

const sessionID = SessionV2.ID.make("ses_configure_tool")

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})

const configStub = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))

const emptyCapabilities = Layer.succeed(
  CapabilityRegistry.Service,
  CapabilityRegistry.Service.of({
    inspect: () => Effect.succeed([]),
    lines: () => Effect.succeed([]),
    retry: (name) => Effect.fail(new CapabilityRegistry.NotFoundError({ name })),
    register: () => Effect.void,
  }),
)

/** Every `permission.assert` the tool made, in order — the subject of the ruling-4 suite. */
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

/** Fails synchronously with the permission service's policy-denial type. */
const denying = Layer.mock(PermissionV2.Service, {
  assert: () => Effect.fail(new PermissionV2.DeniedError({ rules: [] })),
})

/**
 * One graph over a real (`:memory:`, per `test/preload.ts`) SQLite instance, so every "it landed" /
 * "it did not land" assertion reads the store the product reads rather than a mock's opinion. The
 * permission layer is a parameter because the suites disagree about it on purpose.
 */
const withTool = <A, E, R>(
  permission: Layer.Layer<PermissionV2.Service>,
  body: (input: {
    registry: ToolRegistry.Interface
    settings: SettingsConfigStore.Interface
    catalog: CatalogStore.Interface
  }) => Effect.Effect<A, E, R>,
  capabilityLayer: Layer.Layer<CapabilityRegistry.Service> = emptyCapabilities,
) =>
  Effect.gen(function* () {
    return yield* body({
      registry: yield* ToolRegistry.Service,
      settings: yield* SettingsConfigStore.Service,
      catalog: yield* CatalogStore.Service,
    })
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          ConfigureTool.node,
          Database.node,
          SettingsConfigStore.node,
          CatalogStore.node,
        ]),
        [
          [ToolOutputStore.node, outputStore],
          [ToolPolicyGate.node, bypassedPolicyGate],
          [PermissionV2.node, permission],
          [Config.node, configStub],
          [CapabilityRegistry.node, capabilityLayer],
        ],
      ),
    ),
  )

let callCounter = 0
const call = (registry: ToolRegistry.Interface, input: unknown) =>
  executeTool(registry, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call", id: `call-${++callCounter}`, name: "configure", input },
  })

const textOf = (result: { type: string; value: unknown }) => String(result.value)

// ═══ 1. the tier table — every key priced, unclassified ⇒ privileged ═══════════════════════════

describe("ruling 4: every Config.Info key is classified, and an unclassified one is privileged", () => {
  test("the table and the schema agree, in BOTH directions", () => {
    const schemaKeys = Object.keys(Config.Info.fields).sort()
    const tableKeys = Object.keys(ConfigureTool.KEY_TIERS).sort()

    // The sweep has something to look at — an empty read would make every assertion below vacuous.
    expect(schemaKeys.length).toBeGreaterThan(30)

    // A NEW config key that nobody priced. The `Record<keyof Config.Info, Tier>` annotation makes
    // this a compile error first; this is the second half, because a table widened to
    // `Record<string, Tier>` would compile and this would still fail.
    expect(schemaKeys.filter((key) => !tableKeys.includes(key))).toEqual([])
    // …and a priced key that no longer exists, so the table can only track the schema.
    expect(tableKeys.filter((key) => !schemaKeys.includes(key))).toEqual([])
  })

  test("the partition is what it claims — pinned by name so a re-pricing is a visible decision", () => {
    const of = (tier: ConfigureTool.Tier) =>
      Object.entries(ConfigureTool.KEY_TIERS)
        .filter(([, value]) => value === tier)
        .map(([key]) => key)
        .sort()

    // The operational tier is the SHORT list, and the shortness is the measurement rather than an
    // oversight: the config surface really is mostly execution surfaces, prompt text and endpoint URLs
    // (review finding S2). ⚠️ No count is written in this comment — the header used to carry one and it
    // rotted the moment a key was added. The lists below ARE the count.
    expect(of("operational")).toEqual([
      "$schema",
      "attachments",
      "compaction",
      "context",
      // v0.2.0 B2. Priced operational deliberately: an endpoint listed under `devices` is COMPARED
      // against a model's own `api.url` and never called, nothing here is executed or egresses, and
      // no string reaches a prompt. The worst a hostile entry does is group unrelated backends,
      // which makes turns queue behind one another — a throughput loss undone by deleting the entry.
      "devices",
      "folder_bookmarks",
      "log",
      "provider_connection",
      // The measured per-request IMAGE CAP per model. Operational: a wrong value costs images in one
      // request and is undone by deleting the entry, where a wrong TOOL CHANNEL (consequential,
      // below) leaves an agent that silently cannot act.
      "provider_media_limit",
      // Bounded measurements for one exact provider route. A bad row only reserves extra prompt
      // room or is ignored, and deleting it restores the conservative built-in estimate.
      "provider_route_profile",
      "tool_output",
    ])

    expect(of("consequential")).toEqual([
      "affective",
      "disabled_providers",
      "expertise",
      // The five harness drives (reground, set-listing, fan-out join, unfinished-set cue, image
      // shortcut). Consequential rather than operational because each one CHANGES WHAT THE AGENT IS
      // TOLD on later turns — switching one off does not degrade a single request, it removes a
      // correction the model was relying on for the rest of the session. Not privileged: every drive
      // is a `?? true` switch that can only ever withhold guidance, never widen authority.
      "harness_drives",
      "model",
      // The capability probe's measured tool channel per model. Consequential rather than
      // operational: it decides HOW the agent is offered tools on every later turn, and a wrong
      // value is a chat where the agent silently cannot act. Not privileged — it grants no
      // capability the model did not already have, and the self-healing law wants a still-working
      // model able to repair a stale verdict.
      "provider_capability",
      "provider_presets",
      "resource_pressure",
      // Which skills appear in the USER'S OWN slash list. Consequential rather than operational for
      // the reason `watcher` and `snapshots` are: nothing runs, nothing leaves, no text reaches a
      // prompt — but an agent that writes it makes a skill disappear from its owner's own menu, and
      // "the instance behaves differently afterwards in a way the user should get to see" is exactly
      // what this tier is. Not privileged: whether the AGENT may choose a skill is the `skill`
      // permission action, which is gated under `permissions` and stays gated there.
      "skill_invocation",
      "snapshots",
      "strict",
      "tool_routing",
      "trash",
      "virtualFs",
      "watcher",
    ])

    // The execution surfaces ruling 4 names by hand (`shell`, `mcp`), the prompt-text surfaces its
    // fourth test names (`persona`, `adhoc_tools`, `introspection`), and the ones only reading the
    // code reveals: `username` (the `profile` tool's fallback name) and `providers`/`models` (whose
    // per-model `prePrompt` is prepended to the system context).
    expect(of("privileged")).toEqual([
      "adhoc_tools",
      "agents",
      "capability_services",
      "commands",
      // Community participation. PRIVILEGED beside `offline` and `telemetry` and for the same
      // reason: it has consequences outside this machine — joining exposes this box's IP to anyone
      // it talks to, and subscribes the user to content nobody moderates. An agent may USE the
      // community once its owner enabled it; deciding to JOIN is not a thing a model does on
      // somebody's behalf because it read a message asking it to.
      "community",
      "computer",
      "default_agent",
      "experimental",
      "formatter",
      "instances",
      "instructions",
      "introspection",
      "local_model_catalog",
      "mcp",
      "memory",
      "models",
      // Nudge text reaches selected agents' prompts and its closed hooks decide when, so changing it
      // is prompt authorship even though no hook can execute user code.
      "nudges",
      "offline",
      "permissions",
      "persona",
      "providers",
      "quality",
      "references",
      "server",
      "shell",
      "skills",
      "telemetry",
      // Which pre-action policies are switched off. PRIVILEGED because switching one off is the only
      // way to stop a guard that screens every tool call before it runs — it changes who may do what,
      // which is this tier's own definition. The contrast with `skill_invocation` two tiers up is
      // deliberate: that one decides what a HUMAN sees in their own menu and grants the agent nothing.
      "tool_policy",
      "user_profile",
      "username",
      "web_search",
    ])

    expect(of("operational").length + of("consequential").length + of("privileged").length).toBe(
      Object.keys(Config.Info.fields).length,
    )
  })

  test("tierOf defaults to privileged — and the default is not simply what it always answers", () => {
    // The structural half of *unclassified ⇒ privileged*: even with the table bypassed entirely, the
    // lookup is safe rather than open.
    expect(ConfigureTool.tierOf("a_key_invented_next_month")).toBe("privileged")
    expect(ConfigureTool.tierOf("")).toBe("privileged")
    // NEGATIVE CONTROL on that assertion: a function that returned "privileged" unconditionally would
    // satisfy the two lines above and be useless, so pin one key of each other tier.
    expect(ConfigureTool.tierOf("tool_output")).toBe("operational")
    expect(ConfigureTool.tierOf("model")).toBe("consequential")
  })

  test("the two gated tiers spend DIFFERENT actions, and operational spends none", () => {
    // The whole mechanical difference between consequential and privileged: one rule
    // (`configure -> allow`) can pre-grant every consequential write without touching a privileged
    // one. If these two strings were ever equal, the tier distinction would be decoration.
    expect(ConfigureTool.TIER_ACTION.consequential).toBe("configure")
    expect(ConfigureTool.TIER_ACTION.privileged).toBe("configure_privileged")
    expect(ConfigureTool.TIER_ACTION.consequential).not.toBe(ConfigureTool.TIER_ACTION.privileged)
    expect(Object.keys(ConfigureTool.TIER_ACTION).sort()).toEqual(["consequential", "privileged"])
  })

  test("the tool's own name IS the consequential action — one string, now spelled in two files", () => {
    // `TIER_ACTION` used to be built from `name` in this very module, so the two could not diverge.
    // The tier table is a LEAF now (see below) and may not import the tool, so the derivation became
    // two literals — and a literal in two files is exactly what drifts when somebody renames one.
    // A card that asks for `configure` while the registry spends `config` would gate nothing.
    expect(ConfigureTool.TIER_ACTION.consequential).toBe(ConfigureTool.name)
    expect(ConfigureTool.TIER_ACTION.privileged).toBe(`${ConfigureTool.name}_privileged`)
    // NEGATIVE CONTROL: the two lines above would also pass if `name` were the empty string and both
    // actions were derived from it, which is the one way this pin could be true and useless.
    expect(ConfigureTool.name).toBe("configure")
  })
})

// ═══ 1b. the tier table is a LEAF — the source ratchet under a defect `tsgo` cannot see ═══════════

/**
 * **`config-tier.ts` must never gain a runtime import, and `config-projection.ts` must never import
 * this tool.** Ruling 1: the invariant this pins is invisible to the typechecker and to any test that
 * happens to import in the lucky order, which is precisely how it shipped.
 *
 * ⚠️ **Measured 2026-08-07, twice.** While `KEY_TIERS`/`tierOf`/`REDACTED` lived in `tool/configure.ts`
 * and the tool statically imported `config-projection.ts`, the two files closed an ESM cycle that was
 * safe in ONE import order only: a module importing **`tool/configure` first** died with
 * *"ReferenceError: Cannot access 'REDACTED' before initialization"* at `config-projection.ts:580`,
 * while one importing the projection first ran clean — and **`tsgo --noEmit` was green in both
 * cases**. The fix was to lift the shared table into `config-tier.ts`, whose only import is
 * `type`-only, so it has no runtime edge and cannot participate in a cycle at all.
 *
 * ⚠️ A regex over source counts PROSE, and this file's own header names the very import it forbids —
 * so comments and template/quoted text are stripped before anything is matched. A guard that reads
 * its own warning as a violation is the failure mode this repo hit three times in one day.
 */
describe("the ESM cycle stays gone: config-tier.ts is a leaf", () => {
  const srcDir = path.join(import.meta.dir, "..", "src")

  /** Source with block comments, line comments and string bodies removed — imports survive, prose does not. */
  const codeOf = (file: string): string =>
    fs
      .readFileSync(path.join(srcDir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1")

  /** Every module specifier the file imports AT RUNTIME. `import type` carries no runtime edge. */
  const runtimeImports = (file: string): string[] => {
    const code = codeOf(file)
    const found: string[] = []
    for (const match of code.matchAll(/(?:^|\n)\s*import\s+([\s\S]*?)from\s*["']([^"']+)["']/g)) {
      if (/^\s*type\s/.test(match[1]!)) continue
      found.push(match[2]!)
    }
    // `export … from` is also a runtime edge; `export * as X from "./self"` is the house self-alias.
    for (const match of code.matchAll(/(?:^|\n)\s*export\s+(?!type\b)([\s\S]*?)from\s*["']([^"']+)["']/g)) {
      found.push(match[2]!)
    }
    return found
  }

  test("config-tier.ts imports NOTHING at runtime but itself", () => {
    const imports = runtimeImports("config-tier.ts")
    // Negative control on the scanner: it must actually find the self-alias, or an empty answer here
    // would be what a BROKEN regex also returns and every assertion below would be vacuous.
    expect(imports).toEqual(["./config-tier"])
    // …and it must see the `import type` line it is required to ignore, so "no runtime edge" is a
    // measurement about that line rather than a scanner that cannot read the file.
    expect(codeOf("config-tier.ts")).toContain('import type { Config } from "./config"')
  })

  test("the scanner is not blind — it sees the edges the two consumers really have", () => {
    // The positive control the test above needs: run the same function over files that DO import.
    expect(runtimeImports("config-projection.ts")).toContain("./config-tier")
    expect(runtimeImports("tool/configure.ts")).toContain("../config-tier")
    // The static import that the extraction bought back. It is the whole point of the unit: before
    // it, the tool resolved the projection through a dynamic `import()` inside its layer.
    expect(runtimeImports("tool/configure.ts")).toContain("../config-projection")
  })

  test("config-projection.ts does not import the tool — the edge that closed the cycle", () => {
    expect(runtimeImports("config-projection.ts")).not.toContain("./tool/configure")
    // And the workaround is gone rather than merely unused: a dynamic import of the projection here
    // would mean somebody re-created the cycle and papered over it a second time.
    expect(codeOf("tool/configure.ts")).not.toContain('import("../config-projection")')
  })
})

// ═══ 2. the tiers actually behave differently ═════════════════════════════════════════════════

describe("ruling 4: an operational write proceeds, a consequential one asks, a privileged one asks louder", () => {
  it.live("a tier-1 write lands with NO consent card at all", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry, settings }) =>
      Effect.gen(function* () {
        const result = yield* call(registry, { op: "set", config: { tool_output: { max_lines: 42 } } })
        expect(result.type).toBe("text")
        expect(textOf(result)).toContain("tool_output")

        // ZERO asserts is the claim. One would mean the operational tier does not exist.
        expect(asserted).toEqual([])
        // …and it really wrote: read the store the product reads, not the tool's own success text.
        expect((yield* settings.all()).tool_output).toEqual({ max_lines: 42 })
      }),
    )
  })

  it.live("a consequential write asks on `configure`, scoped to the key, and lands", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry, settings }) =>
      Effect.gen(function* () {
        const result = yield* call(registry, { op: "set", config: { snapshots: false } })
        expect(result.type).toBe("text")

        expect(asserted).toHaveLength(1)
        expect(asserted[0]!.action).toBe("configure")
        expect(asserted[0]!.resources).toEqual(["snapshots"])
        // `save: [key]`, never `["*"]` — an "always" answered once must not become a standing grant
        // to rewrite `permissions` in every later session.
        expect(asserted[0]!.save).toEqual(["snapshots"])
        expect(asserted[0]!.save).not.toContain("*")

        expect((yield* settings.all()).snapshots).toBe(false)
      }),
    )
  })

  it.live("a privileged write asks on `configure_privileged`", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry, settings }) =>
      Effect.gen(function* () {
        const result = yield* call(registry, { op: "set", config: { shell: "pwsh" } })
        expect(result.type).toBe("text")

        expect(asserted).toHaveLength(1)
        expect(asserted[0]!.action).toBe("configure_privileged")
        expect(asserted[0]!.resources).toEqual(["shell"])
        expect((yield* settings.all()).shell).toBe("pwsh")
      }),
    )
  })

  it.live("a mixed patch asks ONCE PER TIER, and each card carries only its own tier's keys", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry, settings, catalog }) =>
      Effect.gen(function* () {
        // One key of each tier in a single call. Two cards, never one merged card and never three.
        const result = yield* call(registry, {
          op: "set",
          config: { tool_output: { max_bytes: 1024 }, model: "spark/qwen", shell: "bash" },
        })
        expect(result.type).toBe("text")

        expect(asserted.map((entry) => entry.action)).toEqual(["configure", "configure_privileged"])
        expect(asserted[0]!.resources).toEqual(["model"])
        expect(asserted[1]!.resources).toEqual(["shell"])
        // The operational key appears on NEITHER card — it is not "asked about quietly", it is not
        // asked about.
        for (const entry of asserted) expect(entry.resources).not.toContain("tool_output")
        // The card knows what it is about: the value rides `metadata`, because `resources` doubles
        // as the saved-rule pattern and a value there would make every "always" a dead rule.
        expect(asserted[0]!.metadata).toEqual({ tier: "consequential", values: { model: "spark/qwen" } })

        // All three landed, from one transaction.
        const all = yield* settings.all()
        expect(all.tool_output).toEqual({ max_bytes: 1024 })
        expect(all.shell).toBe("bash")
        expect(yield* catalog.getDefault()).toBe("spark/qwen")
      }),
    )
  })
})

describe("the tool reaches EVERY store the router writes to", () => {
  it.live("a patch touching all six store-backed keys commits, and every key is consumed", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry, catalog }) =>
      Effect.gen(function* () {
        // ⚠️ This is not a duplicate of the routing-ledger suite, and what it catches is precise:
        // `layeredArm`/`listArm` resolve their store ONLY when the patch carries their key, so a
        // store missing from `ConfigureTool.node`'s `deps` is invisible — the tool registers, reads
        // work, four of the six writes work — until somebody writes THAT key, and it then surfaces
        // as a `Service not found` defect in production. Measured 2026-07-31 by deleting
        // `SkillConfigStore.node` from those deps: this test fails with exactly that message.
        // (It does NOT stand in for a typecheck of the layer's captured context: `Effect.context`'s
        // type argument is erased at runtime, so an under-declared union is a compile error only.)
        const result = yield* call(registry, {
          op: "set",
          config: {
            providers: { spark: { name: "Spark", models: { m1: { name: "M1" } } } },
            agents: { build: { description: "the builder" } },
            commands: { deploy: { template: "run it" } },
            references: { docs: { path: "/docs" } },
            skills: ["/opt/skills"],
          },
        })
        expect(result.type).toBe("text")
        for (const key of ["providers", "agents", "commands", "references", "skills"])
          expect(textOf(result)).toContain(key)
        expect(textOf(result)).not.toContain("DISCARDED")

        // Read one of them back through its own store, so "it committed" is not the tool's opinion.
        expect(Object.keys(yield* catalog.providers())).toContain("spark")
        // All five are privileged, so exactly one card, carrying all five.
        expect(asserted).toHaveLength(1)
        expect(asserted[0]!.action).toBe("configure_privileged")
        expect([...asserted[0]!.resources].sort()).toEqual(["agents", "commands", "providers", "references", "skills"])
      }),
    )
  })
})

describe("capability repair: retry the live refusal without restarting", () => {
  it.live("delegates to the registry and reports the state returned by the new attempt", () => {
    const retried: string[] = []
    const capabilityLayer = Layer.succeed(
      CapabilityRegistry.Service,
      CapabilityRegistry.Service.of({
        inspect: () => Effect.succeed([{ name: "memory", status: { state: "idle" as const } }]),
        lines: () => Effect.succeed([]),
        retry: (name) =>
          Effect.sync(() => {
            retried.push(name)
            return { state: "ready" as const, since: 123 }
          }),
        register: () => Effect.void,
      }),
    )
    return withTool(
      recording([]),
      ({ registry }) =>
        Effect.gen(function* () {
          const result = yield* call(registry, { op: "retry", capability: "memory" })
          expect(result.type).toBe("text")
          expect(textOf(result)).toBe('Capability "memory" is ready after retry.')
          expect(retried).toEqual(["memory"])
        }),
      capabilityLayer,
    )
  })

  it.live("names an unknown target and lists the capabilities this graph actually declares", () => {
    const capabilityLayer = Layer.succeed(
      CapabilityRegistry.Service,
      CapabilityRegistry.Service.of({
        inspect: () => Effect.succeed([{ name: "memory", status: { state: "idle" as const } }]),
        lines: () => Effect.succeed([]),
        retry: (name) => Effect.fail(new CapabilityRegistry.NotFoundError({ name })),
        register: () => Effect.void,
      }),
    )
    return withTool(
      recording([]),
      ({ registry }) =>
        Effect.gen(function* () {
          const result = yield* call(registry, { op: "retry", capability: "not-real" })
          expect(result.type).toBe("error")
          expect(textOf(result)).toContain('no capability named "not-real"')
          expect(textOf(result)).toContain("Available capabilities: memory")
        }),
      capabilityLayer,
    )
  })
})

// ═══ 3. ruling 2 — a refused or malformed write changes nothing and says so ════════════════════

describe("ruling 2: a write that did not happen never reports success", () => {
  it.live("a refused write changes NOTHING, and reports the kernel's own denial", () =>
    withTool(denying, ({ registry, settings }) =>
      Effect.gen(function* () {
        yield* settings.set("shell", "before-the-refused-write")

        const result = yield* call(registry, { op: "set", config: { shell: "after-the-refused-write" } })
        expect(result.type).toBe("error")
        expect(textOf(result)).toContain("Nothing was written")
        // The PRODUCT's wording, not the mock's — asserting a string the mock invented would prove
        // only that some error propagated.
        expect(textOf(result)).toContain("Permission denied by policy")

        expect((yield* settings.all()).shell).toBe("before-the-refused-write")
      }),
    ),
  )

  it.live("an undeclared key is refused BY NAME, and the rest of the patch does not sneak through", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry, settings }) =>
      Effect.gen(function* () {
        // The wire path 400s on this and names every offender (`rejectUnknownConfigKeys`); in-process
        // the schema decode would silently DROP it (`onExcessProperty: "ignore"`), which is the exact
        // ruling-2 violation that guard closed. An agent told nothing cannot tell a typo from a
        // broken instance, so it loops.
        const result = yield* call(registry, {
          op: "set",
          config: { shel: "pwsh", tool_output: { max_lines: 7 } },
        })
        expect(result.type).toBe("error")
        expect(textOf(result)).toContain('"shel"')
        expect(textOf(result)).toContain("shell") // the message lists the keys that DO exist

        // Refused BEFORE anything ran: no card was raised and the valid half of the patch is not stored.
        expect(asserted).toEqual([])
        expect((yield* settings.all()).tool_output).toBeUndefined()
      }),
    )
  })

  it.live("a value that does not fit the schema names the offending key and writes nothing", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry, settings }) =>
      Effect.gen(function* () {
        const result = yield* call(registry, { op: "set", config: { snapshots: "yes please" } })
        expect(result.type).toBe("error")
        expect(textOf(result)).toContain("snapshots")
        expect(asserted).toEqual([])
        expect((yield* settings.all()).snapshots).toBeUndefined()
      }),
    )
  })

  it.live("a NESTED field this instance does not have is refused by name, not silently dropped", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry, settings }) =>
      Effect.gen(function* () {
        // The hole `onExcessProperty: "error"` closes. The top-level guard above — and the wire's
        // `rejectUnknownConfigKeys` — see TOP-LEVEL keys only, so under the tree's usual lenient
        // decode `{tool_output:{max_linez:5}}` becomes `{}`, commits an empty object, and answers
        // SUCCESS: the silent-drop shape ruling 2 outlaws, one level down.
        //
        // ⚠️ The fixture has to be an excess property on a plain struct. A first draft used
        // `providers.<id>.api.ur`, which fails under BOTH readings for an unrelated reason (the
        // tagged union below), so it passed with the strictness removed — a test that proved nothing.
        const result = yield* call(registry, { op: "set", config: { tool_output: { max_linez: 5 } } })
        expect(result.type).toBe("error")
        expect(textOf(result)).toContain("tool_output")
        expect(textOf(result)).toContain("max_linez")
        expect((yield* settings.all()).tool_output).toBeUndefined()

        // The realistic version of the same mistake: `mcp` servers carry `disabled`, never `enabled`,
        // so a model that guesses would otherwise be told its server was saved with a flag that was
        // thrown away.
        const mcp = yield* call(registry, {
          op: "set",
          config: { mcp: { servers: { fs: { type: "local", command: ["npx", "x"], enabled: true } } } },
        })
        expect(mcp.type).toBe("error")
        expect(textOf(mcp)).toContain("enabled")
        expect((yield* settings.all()).mcp).toBeUndefined()

        // Both refused before any card was raised.
        expect(asserted).toEqual([])
      }),
    )
  })

  it.live("the endpoint repairs the self-healing law depends on are accepted verbatim", () =>
    withTool(recording([]), ({ registry, catalog }) =>
      Effect.gen(function* () {
        // ⚠️ The other side of the strict decode. Refusing an unknown nested property is only correct
        // while the SHAPES THE LAW DEPENDS ON still pass. If this ever fails, `onExcessProperty:
        // "error"` is the thing that is wrong, not the patch.
        const result = yield* call(registry, {
          op: "set",
          config: {
            provider_presets: { anthropic: { baseURL: "https://api.anthropic.com/v1" } },
            local_model_catalog: {
              runtime: { url: "https://mirror.example/llama.zip", sha256: "a".repeat(64) },
            },
            models: { "qwen3.6-35b": { url: "http://192.168.178.40:8000/v1" } },
            providers: { spark: { api: { type: "native", url: "http://192.168.178.40:8000/v1", settings: {} } } },
          },
        })
        expect(result.type).toBe("text")
        expect(textOf(result)).toContain("provider_presets")
        expect(textOf(result)).toContain("local_model_catalog")
        expect(Object.keys(yield* catalog.providers())).toContain("spark")
      }),
    ),
  )

  it.live("⚠️ a URL-ONLY `providers.<id>.api` fragment is refused — and that is a KERNEL shape limit", () =>
    withTool(recording([]), ({ registry }) =>
      Effect.gen(function* () {
        // AGENTS.md's self-healing example is written as *"one PATCH updates … `providers.<id>.api.url`"*.
        // Measured 2026-07-31: that fragment does not decode against `Config.Info` in ANY decode mode,
        // because `schema/provider.ts`'s `Provider.Api` is a union TAGGED on `type` — so a
        // discriminant-less fragment has no branch to match. It is not this tool's strictness (pinned
        // by asserting the failure under both a strict and a lenient reading in the probe that found
        // it), and `PATCH /config` rejects it identically.
        //
        // This test pins the CURRENT truth rather than the documented one, so that when the kernel is
        // taught to accept a partial `api` merge, this line fails and gets deleted deliberately.
        const result = yield* call(registry, {
          op: "set",
          config: { providers: { spark: { api: { url: "http://192.168.178.40:8000/v1" } } } },
        })
        expect(result.type).toBe("error")
        // The refusal is legible and names the key — an agent can read it and retry with `type`.
        expect(textOf(result)).toContain("providers")
        expect(textOf(result)).toContain("Provider.Api")
      }),
    ),
  )

  it.live("an empty patch is refused rather than reported as a successful no-op", () =>
    withTool(recording([]), ({ registry }) =>
      Effect.gen(function* () {
        const result = yield* call(registry, { op: "set", config: {} })
        expect(result.type).toBe("error")
        expect(textOf(result)).toContain("Nothing was written")
      }),
    ),
  )

  it.live("a key the router ACCEPTS AND DISCARDS is not reported as stored", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry, settings }) =>
      Effect.gen(function* () {
        // `$schema` is on `ConfigStoreWrite.NOT_ROUTED_KEYS`: the export→import round trip carries it,
        // and nothing stores it. Reporting it as saved would be a repair the agent never made.
        const result = yield* call(registry, {
          op: "set",
          config: { $schema: "https://novaclaw.app/config.json", shell: "zsh" },
        })
        expect(result.type).toBe("text")
        expect(textOf(result)).toContain("Saved to this instance's configuration: shell")
        expect(textOf(result)).toContain("DISCARDED")
        expect(textOf(result)).toContain("$schema")

        // `$schema` is operational, `shell` is privileged, so exactly one card was raised.
        expect(asserted.map((entry) => entry.action)).toEqual(["configure_privileged"])
        expect((yield* settings.all()).shell).toBe("zsh")
      }),
    )
  })
})

// ═══ 4. the read op — ungated BECAUSE it is redacted ═══════════════════════════════════════════

describe("read: no consent card, and no credentials", () => {
  it.live("reading asserts nothing and shows each key's tier", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry }) =>
      Effect.gen(function* () {
        const survey = yield* call(registry, { op: "read" })
        expect(survey.type).toBe("text")
        expect(textOf(survey)).toContain("shell [privileged]")
        expect(textOf(survey)).toContain("tool_output [operational]")
        expect(textOf(survey)).toContain("model [consequential]")
        expect(asserted).toEqual([])
      }),
    )
  })

  it.live("this instance's own API token and its peer tokens read back REDACTED", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry, settings }) =>
      Effect.gen(function* () {
        // Both are privileged WRITES and both are allowed here — the point is the read side.
        yield* call(registry, { op: "set", config: { server: { port: 4096, password: "hunter2" } } })
        yield* call(registry, {
          op: "set",
          config: { instances: [{ name: "spark", url: "http://10.0.0.5:4096", token: "peer-secret" }] },
        })

        const read = yield* call(registry, { op: "read", keys: ["server", "instances"] })
        const text = textOf(read)
        // ⚠️ PRESENCE CONTROL, without which the two absence assertions below are vacuous: the store
        // really does hold both secrets, so "not in the reply" is a redaction and not an empty read.
        const stored = yield* settings.all()
        expect((stored.server as { password?: string }).password).toBe("hunter2")
        expect((stored.instances as readonly { token?: string }[])[0]!.token).toBe("peer-secret")
        // `overlay` hands back both verbatim; a model that has seen one has put it in a transcript,
        // a compaction summary, and possibly a messenger reply.
        expect(text).not.toContain("hunter2")
        expect(text).not.toContain("peer-secret")
        expect(text).toContain(ConfigureTool.REDACTED)
        // NEGATIVE CONTROL on the redaction: the non-secret fields beside them survive, so this is a
        // redaction rather than the read op simply failing to find anything.
        expect(text).toContain("4096")
        expect(text).toContain("http://10.0.0.5:4096")
      }),
    )
  })

  /**
   * v0.2.0 item 4.1 — the redactor under the read op is now `ConfigProjection.redact` (a walk of the
   * VALUE against the SCHEMA) instead of `redactSecrets` (a test over KEY NAMES).
   *
   * `config-projection.test.ts` owns the side-by-side measurement that licensed the swap and pins the
   * marker ledger; this suite owns the only question that file cannot answer — **did the read op
   * actually change hands?** A swap made in a helper and not at the call site is the defect class this
   * repo keeps finding (a guard's SITE is invisible to behaviour), so every assertion below runs the
   * retired function over the SAME stored document as a control: it fails exactly where the shipped
   * one now succeeds, at this call site, on this reply.
   */
  it.live("the read op's redactor is the schema marker: it closes three leaks the name test had", () =>
    withTool(recording([]), ({ registry, settings }) =>
      Effect.gen(function* () {
        yield* settings.set("mcp", {
          servers: {
            weather: {
              type: "remote",
              url: "https://weather.example/mcp",
              oauth: { client_id: "public-id", client_secret: "oauth-client-secret" },
            },
            files: {
              type: "local",
              command: ["node", "server.js"],
              environment: { PATH: "/usr/bin", SERVICE_TOKEN: "ghp-local-mcp-env" },
            },
          },
        })

        const text = textOf(yield* call(registry, { op: "read", keys: ["mcp"] }))

        // ⚠️ PRESENCE CONTROL first: the store holds all three verbatim, so the absence assertions
        // below measure a redaction rather than an empty read.
        const stored = yield* settings.all()
        const raw = JSON.stringify(stored.mcp)
        for (const secret of ["oauth-client-secret", "ghp-local-mcp-env"]) expect(raw).toContain(secret)

        // ⚠️ NEGATIVE CONTROL on the swap itself: the retired name test, run over the same document,
        // still hands both back in the clear. Without this the two lines below would also pass on the
        // day before the swap, and would be measuring nothing.
        const byName = JSON.stringify(ConfigureTool.redactSecrets(stored.mcp))
        expect(byName).toContain("oauth-client-secret")
        expect(byName).toContain("ghp-local-mcp-env")

        expect(text).not.toContain("oauth-client-secret")
        expect(text).not.toContain("ghp-local-mcp-env")
        expect(text).toContain(ConfigureTool.REDACTED)
        // The non-credential neighbours survive — a redaction, not a blanked subtree. `client_id` sits
        // beside the secret INSIDE THE SAME OBJECT and reads back, which is the property that keeps an
        // OAuth server repairable.
        expect(text).toContain("public-id")
        expect(text).toContain("https://weather.example/mcp")
        // ⚠️ `environment` is marked secret WHOLE, not per entry — the entry names are the user's, so
        // a name test over them is the guess this swap refuses (`config/mcp.ts` says so at the marker).
        // Both VALUES are therefore blanked, `PATH` included; both KEYS survive, so "which variables
        // are set" stays answerable. Asserting `/usr/bin` reads back would have been asserting the
        // opposite of the design.
        expect(text).toContain("SERVICE_TOKEN")
        expect(text).toContain("PATH")
        expect(text).not.toContain("/usr/bin")
      }),
    ),
  )

  it.live("…and it stops OVER-redacting an MCP server a user named `headers`, which made that repair unmakeable", () =>
    withTool(recording([]), ({ registry, settings }) =>
      Effect.gen(function* () {
        // The name test replaces every string field of anything CALLED `headers`, so this server's own
        // `type` and `url` came back as the redaction sentence — an agent asked to repair it could not
        // read what it was repairing.
        yield* settings.set("mcp", {
          servers: { headers: { type: "remote", url: "https://named-headers.example/mcp" } },
        })

        const stored = yield* settings.all()
        // NEGATIVE CONTROL: the retired function really does eat it, so the line below is a change.
        const byName = ConfigureTool.redactSecrets(stored.mcp) as {
          servers: { headers: { type: string; url: string } }
        }
        expect(byName.servers.headers.url).toBe(ConfigureTool.REDACTED)

        const text = textOf(yield* call(registry, { op: "read", keys: ["mcp"] }))
        expect(text).toContain("https://named-headers.example/mcp")
        expect(text).toContain("remote")
      }),
    ),
  )

  it.live("reading an undeclared key is refused by name", () =>
    withTool(recording([]), ({ registry }) =>
      Effect.gen(function* () {
        const result = yield* call(registry, { op: "read", keys: ["providerz"] })
        expect(result.type).toBe("error")
        expect(textOf(result)).toContain('"providerz"')
      }),
    ),
  )
})

// ═══ the `schema` op (v0.2.0 item 4.1) ════════════════════════════════════════════════════════
//
// Item 4.1 shipped `ConfigProjection` and nothing called it. This is the op that makes it reachable
// from a model, and the reason it had to exist: the tool's own description told the model to "READ A
// KEY BEFORE YOU WRITE IT and follow the shape you get back", and `read` reports a VALUE — so the
// key a repair most often targets, one this instance has never set, read back `(not set)`.
//
// ⚠️ These are NOT a second copy of `config-projection.test.ts`. That file measures the projection;
// this one measures the OP — that it is reachable, ungated, value-free, and that the write its text
// prescribes actually lands through the same tool.

describe("schema: an agent can discover what is settable", () => {
  it.live("the survey names every key with its tier, and asserts nothing", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry }) =>
      Effect.gen(function* () {
        const result = yield* call(registry, { op: "schema" })
        expect(result.type).toBe("text")
        const text = textOf(result)

        // Every key is named, derived rather than pinned — a literal list here would be the second
        // source this whole item exists to remove.
        const missing = ConfigProjection.keys().filter((key) => !text.includes(`\n${key} [`))
        expect(missing).toEqual([])
        expect(ConfigProjection.keys().length).toBeGreaterThan(40)
        // …with the price of the write, which is the fact a model needs before it plans a repair.
        expect(text).toContain("shell [privileged]")
        expect(text).toContain("tool_output [operational]")
        expect(text).toContain("model [consequential]")
        // It points at the next call rather than dead-ending, and separates the two verbs.
        expect(text).toContain('{"op":"schema","keys":["providers"],"depth":2}')
        expect(text).toContain("Paths are SEGMENT ARRAYS")

        // Ungated: describing the schema mutates nothing and reveals no stored value.
        expect(asserted).toEqual([])
      }),
    )
  })

  it.live("the survey describes the SCHEMA and never the stored values", () =>
    withTool(recording([]), ({ registry, settings }) =>
      Effect.gen(function* () {
        yield* settings.set("shell", "a-value-only-this-instance-has")
        yield* settings.set("server", { port: 4096, password: "hunter2" })

        for (const input of [{ op: "schema" }, { op: "schema", keys: ["shell", "server"], depth: 2 }]) {
          const text = textOf(yield* call(registry, input))
          // ⚠️ PRESENCE CONTROL: `read` over the same store DOES print the non-secret value, so the
          // two absences below are a property of `schema` rather than of an empty store.
          expect(textOf(yield* call(registry, { op: "read", keys: ["shell"] }))).toContain(
            "a-value-only-this-instance-has",
          )
          expect(text).not.toContain("a-value-only-this-instance-has")
          expect(text).not.toContain("hunter2")
          // …and it did describe the key it was asked about, so the absences are not an empty reply.
          expect(text).toContain("shell")
        }
      }),
    ),
  )

  it.live("one key comes back with its fields, its legal values and its WRITE SHAPE", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry }) =>
      Effect.gen(function* () {
        const text = textOf(yield* call(registry, { op: "schema", keys: ["providers"], depth: 3 }))

        // The two sentences AGENTS.md spent two corrections learning by hand — now printed.
        expect(text).toContain("Send one COMPLETE alternative including its `type`")
        expect(text).toContain('type="native" needs {type, settings}')
        expect(text).toContain('type="aisdk" needs {type, package}')
        // …and the one it got WRONG: `request` really is partially patchable.
        expect(text).toContain('["providers","<key>","request"]')
        // Secrets are named as writable-but-unreadable rather than hidden, so the agent knows the
        // field exists and can still repair it.
        expect(text).toContain("[secret — writable, never read back]")
        expect(text).toContain("[the apiKey entry is secret — writable, never read back]")
        // The price, and the verb this tool can actually spend (the projection's own line names the
        // HTTP surface, which nothing hands a session a URL or token for).
        expect(text).toContain("price: privileged")
        expect(text).toContain('{"op":"remove","paths":[["<key>","<segment>"]]}')

        expect(asserted).toEqual([])
      }),
    )
  })

  it.live("an undeclared key is refused BY NAME, exactly as read and remove refuse one", () =>
    withTool(recording([]), ({ registry }) =>
      Effect.gen(function* () {
        const result = yield* call(registry, { op: "schema", keys: ["providerz"] })
        expect(result.type).toBe("error")
        expect(textOf(result)).toContain('"providerz"')
        expect(textOf(result)).toContain("providers") // the message lists the keys that DO exist
      }),
    ),
  )

  it.live("an empty or all-blank `keys` surveys everything rather than describing nothing", () =>
    withTool(recording([]), ({ registry }) =>
      Effect.gen(function* () {
        for (const keys of [[], ["", "   "]]) {
          const text = textOf(yield* call(registry, { op: "schema", keys }))
          // The survey line, not a key rendering: a header promising fields over zero lines would be
          // a report that describes itself falsely.
          expect(text).toContain("configuration schema")
          expect(text).toContain("shell [privileged]")
        }
      }),
    ),
  )

  it.live("depth is CLAMPED, not refused — and the clamp is visible in the reply", () =>
    withTool(recording([]), ({ registry }) =>
      Effect.gen(function* () {
        const at = (depth: number) => call(registry, { op: "schema", keys: ["providers"], depth })
        const shallow = textOf(yield* at(0))
        const deep = textOf(yield* at(40))
        // Depth 0 is the key alone; the clamped request expands children. If the clamp had produced a
        // `NaN` depth, `renderKey` would have rendered zero children and looked exactly like depth 0 —
        // which is why these are compared against each other rather than each asserted non-empty.
        expect(shallow).not.toContain('["providers","<key>","api"]')
        expect(deep).toContain('["providers","<key>","api"]')
        expect(deep.length).toBeGreaterThan(shallow.length)
        // …and 40 really was clamped rather than honoured: the ceiling is 4, so it must equal depth 4.
        expect(deep).toBe(textOf(yield* at(4)))
      }),
    ),
  )

  test("schemaDepth clamps every shape a model can send", () => {
    expect(ConfigureTool.schemaDepth(undefined)).toBe(1)
    expect(ConfigureTool.schemaDepth(2)).toBe(2)
    expect(ConfigureTool.schemaDepth(0)).toBe(0)
    // Out of range in both directions, and a fraction.
    expect(ConfigureTool.schemaDepth(40)).toBe(4)
    expect(ConfigureTool.schemaDepth(-3)).toBe(0)
    expect(ConfigureTool.schemaDepth(2.9)).toBe(2)
    // ⚠️ Measured, not assumed: `NaN <= 0` is FALSE and `NaN - 1` is `NaN`, so an unguarded `NaN`
    // never stops the descent at any level — `renderKey("providers", NaN)` renders 153 lines /
    // 12,398 chars against 8 lines at depth 1. It terminates (the AST is finite) and it ignores the
    // budget completely, which is the failure a clamp exists to prevent.
    // A non-finite value takes the DEFAULT rather than an end of the range — one rule, no special
    // case for the sign. JSON cannot carry any of these three, so this guards a non-JSON caller and
    // the `NaN` that a hand-built input would otherwise walk the whole schema with.
    expect(ConfigureTool.schemaDepth(Number.NaN)).toBe(1)
    expect(ConfigureTool.schemaDepth(Number.POSITIVE_INFINITY)).toBe(1)
    expect(ConfigureTool.schemaDepth(Number.NEGATIVE_INFINITY)).toBe(1)
  })
})

/**
 * ⭐ **THE DECODE.** AGENTS.md: *"a repair path is only real if someone has decoded it."* So this does
 * not compare the projection to itself. It asks the TOOL what `providers` is, copies the shape out of
 * the sentence the tool printed, performs that write through the same tool, and re-reads the store —
 * plus the negative arm, where the shape the reply explicitly refuses to license is refused by the
 * surface too. If the description were wrong in either direction, one of these two fails.
 */
describe("a repair the schema op describes actually lands", () => {
  it.live("describe providers → write exactly what it prescribes → read the store back", () =>
    withTool(recording([]), ({ registry, catalog }) =>
      Effect.gen(function* () {
        // ── 1. what the TOOL says, through the registry, exactly as a model receives it ──────────
        const described = textOf(yield* call(registry, { op: "schema", keys: ["providers"], depth: 3 }))
        expect(described).toContain('type="native" needs {type, settings}')
        expect(described).toContain('["providers","<key>","request"]')
        expect(described).toContain(
          "Send only the fields you are changing — every field is optional and objects merge.",
        )

        // ── 2. the write the sentence licenses: a COMPLETE `api` alternative including its `type` ──
        const created = yield* call(registry, {
          op: "set",
          config: {
            providers: {
              drill: {
                name: "Drill",
                api: { type: "native", url: "http://127.0.0.1:9/v1", settings: {} },
                models: { "holo3.1": { name: "Holo 3.1" } },
              },
            },
          },
        })
        expect(created.type).toBe("text")

        // ── 3. …and the `merge` sentence for `request`: only the field being changed, no spread ────
        const patched = yield* call(registry, {
          op: "set",
          config: {
            providers: {
              drill: {
                models: { "holo3.1": { request: { body: { chat_template_kwargs: { enable_thinking: false } } } } },
              },
            },
          },
        })
        expect(patched.type).toBe("text")

        // ── 4. read the STORE back, never the tool's success text ────────────────────────────────
        // ⚠️ `providers` is NOT in the settings store — the router sends it to `CatalogStore`, which
        // holds it as LAYERS. So the read goes two ways: the catalog for "it is really in that store",
        // and a fresh `read` op for the composed document, which is the same `ConfigStoreWrite.overlay`
        // call `GET /config` makes and is exactly what a repairing agent would do next.
        expect(Object.keys(yield* catalog.providers())).toContain("drill")
        const line = textOf(yield* call(registry, { op: "read", keys: ["providers"] }))
          .split("\n")
          .find((entry) => entry.startsWith("providers ["))!
        // A truncated value would make the parse below throw for the wrong reason.
        expect(line).not.toContain("truncated")
        const stored = JSON.parse(line.slice(line.indexOf("= ") + 2)) as Record<
          string,
          { name?: string; api?: { url?: string }; models: Record<string, { name?: string; request?: unknown }> }
        >
        const model = stored.drill!.models["holo3.1"]!
        expect(model.request).toEqual({ body: { chat_template_kwargs: { enable_thinking: false } } })
        // The fragment merged rather than replacing: the entry's own name and its provider's `api`
        // survived, which is the other half of what the `merge` sentence promised.
        expect(model.name).toBe("Holo 3.1")
        expect(stored.drill!.api!.url).toBe("http://127.0.0.1:9/v1")
      }),
    ),
  )

  it.live("…and the write the schema REFUSES to license is refused by the surface too", () =>
    withTool(recording([]), ({ registry, catalog }) =>
      Effect.gen(function* () {
        const described = textOf(yield* call(registry, { op: "schema", keys: ["providers"], depth: 3 }))
        // The reply never prints a bare `{url}` as a legal `api` patch — it prints the opposite.
        expect(described).toContain("a fragment without the `type` matches no branch and cannot decode at all")

        const result = yield* call(registry, {
          op: "set",
          config: { providers: { drill: { api: { url: "http://moved.example/v1" } } } },
        })
        expect(result.type).toBe("error")
        // NEGATIVE CONTROL for the whole pair: nothing was stored, so the accepted write in the test
        // above is a property of the SHAPE and not of a surface that accepts everything.
        //
        // ⚠️ Read the CATALOG, not the settings store. `settings.all().providers` is `undefined`
        // whether or not the write landed — the router sends `providers` elsewhere — so asserting on
        // it would have been the vacuous absence assertion this file keeps catching.
        expect(Object.keys(yield* catalog.providers())).not.toContain("drill")
      }),
    ),
  )
})

// ═══ 5. the pure halves ═══════════════════════════════════════════════════════════════════════

describe("redactSecrets", () => {
  test("replaces credential-shaped STRINGS and header values, and nothing else", () => {
    expect(
      ConfigureTool.redactSecrets({
        server: { port: 4096, password: "hunter2", hostname: "0.0.0.0" },
        instances: [{ name: "spark", url: "http://x", token: "peer" }],
        providers: { spark: { name: "Spark", request: { headers: { Authorization: "Bearer sk-1" } } } },
      }),
    ).toEqual({
      server: { port: 4096, password: ConfigureTool.REDACTED, hostname: "0.0.0.0" },
      instances: [{ name: "spark", url: "http://x", token: ConfigureTool.REDACTED }],
      providers: { spark: { name: "Spark", request: { headers: { Authorization: ConfigureTool.REDACTED } } } },
    })
  })

  test("a record KEY spelled like a secret is not mistaken for one (negative control)", () => {
    // `providers.token` names a PROVIDER and holds an object. Only string values are replaced, which
    // is what keeps this from eating a whole subtree — the failure mode that would make the read op
    // useless while looking safe.
    expect(ConfigureTool.redactSecrets({ providers: { token: { name: "A provider called token" } } })).toEqual({
      providers: { token: { name: "A provider called token" } },
    })
    // …and a plain document passes through untouched, so the walk is not silently replacing values.
    expect(ConfigureTool.redactSecrets({ shell: "bash", tool_output: { max_lines: 5 } })).toEqual({
      shell: "bash",
      tool_output: { max_lines: 5 },
    })
  })
})

describe("formatWrite", () => {
  test("separates what was stored from what was accepted and discarded", () => {
    const message = ConfigureTool.formatWrite({
      requested: ["$schema", "shell"],
      consumed: new Set(["shell"]),
    })
    expect(message).toContain("Saved to this instance's configuration: shell")
    expect(message).toContain("DISCARDED")
    expect(message).toContain("$schema")
    // NEGATIVE CONTROL: with nothing discarded the line is absent, so its presence above is a
    // report of the router's answer rather than boilerplate printed either way.
    expect(ConfigureTool.formatWrite({ requested: ["shell"], consumed: new Set(["shell"]) })).not.toContain("DISCARDED")
    // And a write that stored nothing says so instead of claiming a save.
    expect(ConfigureTool.formatWrite({ requested: ["$schema"], consumed: new Set() })).toContain("Nothing was stored")
  })
})

// ═══ the `remove` op (v0.2.0 item 4.3) ════════════════════════════════════════════════════════
//
// Until 2026-08-07 this tool could not delete anything and its description said so — which made
// AGENTS.md's self-healing law true only for whoever could reach raw HTTP. These drive the op
// against the same real store the write tests use.

describe("configure remove — the agent's half of the deletion verb", () => {
  it.live("removes ONE mcp server and leaves its sibling, asking on the key's own tier", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry, settings }) =>
      Effect.gen(function* () {
        yield* settings.set("mcp", {
          servers: {
            filesystem: { type: "local", command: ["npx", "x"] },
            weather: { type: "remote", url: "https://example.invalid/mcp" },
          },
        })

        const result = yield* call(registry, { op: "remove", paths: [["mcp", "servers", "weather"]] })
        expect(textOf(result)).toContain("Removed")

        // Priced exactly like a WRITE to the same key — deleting `mcp` is not cheaper than editing it.
        expect(asserted).toHaveLength(1)
        expect(asserted[0]!.resources).toEqual(["mcp"])

        // Read the store the product reads, never the tool's success text.
        const stored = (yield* settings.all()).mcp as { servers: Record<string, unknown> }
        expect(Object.keys(stored.servers)).toEqual(["filesystem"])
      }),
    )
  })

  it.live("a path that names nothing removes NOTHING and says which path was wrong", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry, settings }) =>
      Effect.gen(function* () {
        yield* settings.set("mcp", { servers: { filesystem: { type: "local", command: ["npx", "x"] } } })

        const result = yield* call(registry, {
          op: "remove",
          paths: [
            ["mcp", "servers", "filesystem"],
            ["mcp", "servers", "ghost"],
          ],
        })
        expect(textOf(result)).toContain("Nothing was removed")
        expect(textOf(result)).toContain("ghost")

        // All-or-nothing: the GOOD path rolled back with the bad one. A model told "done" while one
        // of its two repairs silently did not happen is the loop ruling 2 exists to prevent.
        const stored = (yield* settings.all()).mcp as { servers: Record<string, unknown> }
        expect(Object.keys(stored.servers)).toEqual(["filesystem"])
      }),
    )
  })

  it.live("a refused consent card removes nothing at all", () =>
    withTool(denying, ({ registry, settings }) =>
      Effect.gen(function* () {
        yield* settings.set("mcp", { servers: { filesystem: { type: "local", command: ["npx", "x"] } } })
        const result = yield* call(registry, { op: "remove", paths: [["mcp", "servers", "filesystem"]] })
        expect(textOf(result)).toContain("Nothing was removed")
        const stored = (yield* settings.all()).mcp as { servers: Record<string, unknown> }
        expect(Object.keys(stored.servers)).toEqual(["filesystem"])
      }),
    ),
  )

  it.live("an unknown top-level key is refused by name, before any card is raised", () => {
    const asserted: Asserted[] = []
    return withTool(recording(asserted), ({ registry }) =>
      Effect.gen(function* () {
        const result = yield* call(registry, { op: "remove", paths: [["provider_preset", "x"]] })
        expect(textOf(result)).toContain("not a configuration key")
        // NEGATIVE CONTROL for the ordering claim: asking the user to approve a write that cannot
        // happen is consent spent on nothing.
        expect(asserted).toEqual([])
      }),
    )
  })

  it.live("an empty path list is refused rather than reported as a successful no-op", () =>
    withTool(recording([]), ({ registry }) =>
      Effect.gen(function* () {
        const result = yield* call(registry, { op: "remove", paths: [] })
        expect(textOf(result)).toContain("Nothing was removed")
      }),
    ),
  )
})
