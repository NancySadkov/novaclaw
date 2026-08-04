import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { Config } from "@novaclaw/core/config"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { PermissionV2 } from "@novaclaw/core/permission"
import { SessionV2 } from "@novaclaw/core/session"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { ConfigureTool } from "@novaclaw/core/tool/configure"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { it } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

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
 *     one: without this, moving `plugins` to `operational` would be a one-word diff that no check
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

/**
 * ⚠️ Fails SYNCHRONOUSLY with the module's own `RejectedError` rather than answering `ask`. An `ask`
 * with nobody to answer it parks on a `Deferred` forever and no test timeout reaps it — the trap
 * recorded in todo.md against the `rootSessionType` work.
 */
const denying = Layer.mock(PermissionV2.Service, {
  assert: () => Effect.fail(new PermissionV2.RejectedError()),
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
          [PermissionV2.node, permission],
          [Config.node, configStub],
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

    // Seven operational keys, and the shortness is the measurement rather than an oversight: the config
    // surface really is mostly execution surfaces, prompt text and endpoint URLs (review finding S2).
    expect(of("operational")).toEqual([
      "$schema",
      "attachments",
      "compaction",
      "context",
      "folder_bookmarks",
      "provider_connection",
      "tool_output",
    ])

    expect(of("consequential")).toEqual([
      "affective",
      "disabled_providers",
      "enabled_providers",
      "expertise",
      "model",
      "provider_presets",
      "resource_pressure",
      "snapshots",
      "strict",
      "tool_routing",
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
      "autoupdate",
      "commands",
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
      "offline",
      "permissions",
      "persona",
      "plugins",
      "providers",
      "quality",
      "references",
      "server",
      "shell",
      "skills",
      "telemetry",
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
            plugins: ["team-plugin@1.0.0"],
          },
        })
        expect(result.type).toBe("text")
        for (const key of ["providers", "agents", "commands", "references", "skills", "plugins"])
          expect(textOf(result)).toContain(key)
        expect(textOf(result)).not.toContain("DISCARDED")

        // Read one of them back through its own store, so "it committed" is not the tool's opinion.
        expect(Object.keys(yield* catalog.providers())).toContain("spark")
        // All six are privileged, so exactly one card, carrying all six.
        expect(asserted).toHaveLength(1)
        expect(asserted[0]!.action).toBe("configure_privileged")
        expect([...asserted[0]!.resources].sort()).toEqual([
          "agents",
          "commands",
          "plugins",
          "providers",
          "references",
          "skills",
        ])
      }),
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
        expect(textOf(result)).toContain("The user declined permission for this action")

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
    return withTool(recording(asserted), ({ registry }) =>
      Effect.gen(function* () {
        // Both are privileged WRITES and both are allowed here — the point is the read side.
        yield* call(registry, { op: "set", config: { server: { port: 4096, password: "hunter2" } } })
        yield* call(registry, {
          op: "set",
          config: { instances: [{ name: "spark", url: "http://10.0.0.5:4096", token: "peer-secret" }] },
        })

        const read = yield* call(registry, { op: "read", keys: ["server", "instances"] })
        const text = textOf(read)
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
