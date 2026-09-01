import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { ConfigAnnotation } from "@novaclaw/schema/config-annotation"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { Config } from "@novaclaw/core/config"
import { ConfigComputer } from "@novaclaw/core/config/computer"
import { ConfigProviderConnection } from "@novaclaw/core/config/provider-connection"
import { ConfigProjection } from "@novaclaw/core/config-projection"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { ConfigureTool } from "@novaclaw/core/tool/configure"
import { it } from "./lib/effect"

/**
 * The agent-readable projection of the settings schema — v0.2.0 item 4.1 / A13.5.
 *
 * What is pinned here, and why each would otherwise be a claim in a comment (ruling 1):
 *
 *  1. **The write shape is MEASURED, not asserted.** Every node the projection calls partially
 *     patchable has an empty fragment decoded at its path through the same `Config.Info` decode the
 *     write path runs; every node it calls whole-only has that fragment REFUSED. AGENTS.md's own
 *     correction is the reason: *a repair path is only real if someone has decoded it*, and a
 *     projection that says a field is settable when a partial patch cannot decode is worse than none.
 *  2. **The secret marker is the single source of truth, and it beats the name test in BOTH
 *     directions.** The heuristic it replaces is imported and run side by side on one document, so
 *     "we fixed the redaction" is a measurement of two functions rather than a claim about one.
 *  3. **It carries no second copy of anything.** Tier, removability, storage and liveness are joined
 *     from `KEY_TIERS` / `REMOVE_REFUSED_KEYS` / `NOT_ROUTED_KEYS` / `RESTART_REQUIRED_KEYS`, and the
 *     test compares against those tables rather than against a list written here.
 *  4. **Every authored `depends` resolves, and every declared default IS the compiled constant** —
 *     the two annotations a rename would silently orphan.
 *  5. **A described write actually lands.** The last suite reads the projection for a real key, sends
 *     exactly the patch it prescribes through `ConfigStoreWrite.apply` — the same call `PATCH /config`
 *     and the `configure` tool both make — and re-reads the store.
 */

// ── probing the real decode ───────────────────────────────────────────────────────────────────

/** The options `tool/configure.ts` decodes a model's patch with (strict about unknown FIELDS). */
const STRICT = { errors: "all", onExcessProperty: "error", propertyOrder: "original" } as const
/** What `PATCH /config` uses. An empty fragment carries no excess property, so the two must agree. */
const LENIENT = { errors: "all" } as const

const PROBE_ID = "probe-id"

/** A document with `leaf` at `path`. Open record keys become a concrete id, as a caller would send. */
const documentAt = (path: readonly string[], leaf: unknown): Record<string, unknown> => {
  const segments = path.map((segment) => (segment === "<key>" ? PROBE_ID : segment))
  let value: unknown = leaf
  for (let index = segments.length - 1; index >= 1; index -= 1) value = { [segments[index]!]: value }
  return { [segments[0]!]: value }
}

const decodes = (document: unknown, options: typeof STRICT | typeof LENIENT = STRICT) =>
  Exit.isSuccess(Schema.decodeUnknownExit(Config.Info)(document, options))

const failureText = (document: unknown) => {
  const exit = Schema.decodeUnknownExit(Config.Info)(document, STRICT)
  return Exit.isFailure(exit) ? String(exit.cause) : ""
}

/**
 * Every node reachable by descending ONLY through partially-patchable parents — which is exactly the
 * set for which a fragment at that path is a meaningful thing to send. Descending through a `variant`
 * or an array would build a document whose failure says nothing about the child.
 */
const patchableNodes = (depth = 5): ConfigProjection.Field[] => {
  const out: ConfigProjection.Field[] = []
  const visit = (field: ConfigProjection.Field, remaining: number) => {
    out.push(field)
    if (remaining <= 0 || field.write.kind !== "merge") return
    for (const child of ConfigProjection.describe(field.path, 1)?.children ?? []) visit(child, remaining - 1)
  }
  for (const name of ConfigProjection.keys()) {
    const key = ConfigProjection.describe([name], 1)
    if (key !== undefined) visit(key, depth)
  }
  return out
}

// ═══ 1. the write shape, decoded rather than asserted ══════════════════════════════════════════

describe("the write shape is a measurement", () => {
  test("every node the projection calls partially patchable ACCEPTS a fragment; every whole-only node refuses one", () => {
    const nodes = patchableNodes()
    // Non-vacuity: an empty sweep would make every expectation below trivially true.
    expect(nodes.length).toBeGreaterThan(80)

    const merge = nodes.filter((node) => node.write.kind === "merge")
    const whole = nodes.filter((node) => node.write.kind === "whole")
    const variant = nodes.filter((node) => node.write.kind === "variant")
    const replace = nodes.filter((node) => node.write.kind === "replace")
    // Each arm has something to measure. Without this, a bug that made everything one kind would
    // leave three of the four loops empty and still pass.
    expect(merge.length).toBeGreaterThan(20)
    expect(whole.length).toBeGreaterThan(0)
    expect(variant.length).toBeGreaterThan(0)
    expect(replace.length).toBeGreaterThan(5)

    const wrong = {
      mergeRefused: merge.filter((node) => !decodes(documentAt(node.path, {}))).map((node) => node.path.join(".")),
      wholeAccepted: whole.filter((node) => decodes(documentAt(node.path, {}))).map((node) => node.path.join(".")),
      variantAccepted: variant.filter((node) => decodes(documentAt(node.path, {}))).map((node) => node.path.join(".")),
      replaceAccepted: replace.filter((node) => decodes(documentAt(node.path, {}))).map((node) => node.path.join(".")),
    }
    expect(wrong).toEqual({ mergeRefused: [], wholeAccepted: [], variantAccepted: [], replaceAccepted: [] })
  })

  test("the strict and lenient decoders agree about an empty fragment, so one projection serves both surfaces", () => {
    const nodes = patchableNodes()
    expect(nodes.length).toBeGreaterThan(80)
    const disagree = nodes
      .filter((node) => decodes(documentAt(node.path, {}), STRICT) !== decodes(documentAt(node.path, {}), LENIENT))
      .map((node) => node.path.join("."))
    expect(disagree).toEqual([])
  })

  test("a whole-only node refuses a fragment with a MISSING KEY, which is the sentence the projection prints", () => {
    const whole = patchableNodes().filter((node) => node.write.kind === "whole")
    expect(whole.length).toBeGreaterThan(0)
    for (const node of whole) {
      const required = (node.write as { kind: "whole"; required: readonly string[] }).required
      expect(required.length).toBeGreaterThan(0)
      // The projection tells the caller which keys are required; the decoder must complain about
      // one of exactly those, or the sentence is pointing at the wrong field.
      const text = failureText(documentAt(node.path, {}))
      expect(required.some((name) => text.includes(name))).toBe(true)
    }
  })
})

// ═══ 2. AGENTS.md's two documented biters, re-measured ═════════════════════════════════════════

describe("the repairs AGENTS.md records as impossible — and what the projection says instead", () => {
  const apiPath = ["providers", "spark-holo", "api"]

  test("providers.<id>.api is a VARIANT, and the projection names the discriminant and both branches", () => {
    const api = ConfigProjection.describe(apiPath, 0)!
    expect(api.write.kind).toBe("variant")
    const write = api.write as { kind: "variant"; discriminant: string; variants: readonly ConfigProjection.Variant[] }
    expect(write.discriminant).toBe("type")
    expect(write.variants.map((variant) => variant.tag).sort()).toEqual(['"aisdk"', '"native"'])
    // AGENTS.md: "Adding `type: native` is not enough either — it then fails Missing key."
    // The projection has to say WHICH key, or it repeats the doc's own dead end.
    expect(write.variants.find((variant) => variant.tag === '"native"')!.required).toEqual(["settings"])
  })

  test("…and the decoder agrees at every step: bare url refused, type alone refused, complete branch accepted", () => {
    expect(decodes(documentAt(apiPath, { url: "http://192.168.178.40:8010/v1" }))).toBe(false)
    expect(decodes(documentAt(apiPath, { type: "native", url: "http://192.168.178.40:8010/v1" }))).toBe(false)
    expect(decodes(documentAt(apiPath, { type: "native", url: "http://192.168.178.40:8010/v1", settings: {} }))).toBe(
      true,
    )
    // The other branch, so "complete alternative" is proven for the union rather than for one member.
    expect(decodes(documentAt(apiPath, { type: "aisdk", package: "@ai-sdk/openai" }))).toBe(true)
    expect(decodes(documentAt(apiPath, { package: "@ai-sdk/openai" }))).toBe(false)
  })

  test("a union's merged children describe EVERY branch, not whichever one happens to be first", () => {
    // The first bug this file had: deduplicating by name and keeping `Provider.AISDK`'s node made
    // `api.type` read as `"aisdk"` with legal values `["aisdk"]` — a value the other branch rejects,
    // handed to an agent as fact.
    const children = ConfigProjection.describe(apiPath, 1)!.children
    const type = children.find((child) => child.path.at(-1) === "type")!
    expect(type.values).toEqual(['"aisdk"', '"native"'])
    expect(type.optional).toBe(false)
    // A field only one branch carries says which, and is omittable overall.
    const pkg = children.find((child) => child.path.at(-1) === "package")!
    expect(pkg.inVariants).toEqual(['"aisdk"'])
    expect(pkg.optional).toBe(true)
    // …and a field both carry says nothing about branches.
    expect(children.find((child) => child.path.at(-1) === "url")!.inVariants).toBeUndefined()
  })

  test("🔴 providers.<id>.models.<id>.request IS partially patchable — AGENTS.md's Missing-key caveat is about a DIFFERENT schema", () => {
    // AGENTS.md (2026-08-07) and `tests/apply-holo-thinking-off.ts` both state that `Model.request`
    // needs the complete entry because "`Provider.Request` declares headers and body as REQUIRED".
    // That is true of `packages/schema/src/provider.ts`'s RUNTIME `Provider.Request` and false of the
    // authoring schema a config patch decodes through: `config/provider.ts`'s `ConfigV2.Provider.
    // Request` has both optional. Measured here so the projection's answer is the decoder's answer.
    const path = ["providers", "spark-holo", "models", "holo3.1", "request"]
    expect(ConfigProjection.describe(path, 0)!.write.kind).toBe("merge")
    expect(decodes(documentAt(path, { body: { chat_template_kwargs: { enable_thinking: false } } }))).toBe(true)
    expect(decodes(documentAt(["providers", "spark-holo", "models", "holo3.1"], { name: "Holo" }))).toBe(true)
  })
})

// ═══ 3. the secret marker, against the name test it replaces ═══════════════════════════════════

/**
 * One document carrying a credential in every slot the schema declares as one, plus the two shapes
 * that break a name test: an MCP server a user NAMED `headers`, and a `request.body` whose `apiKey`
 * is a credential while its neighbour is the repair target AGENTS.md's decoded example writes.
 */
const CREDENTIALS = {
  serverPassword: "instance-incoming-token",
  peerToken: "peer-account-equivalent",
  remoteHeader: "Bearer remote-mcp",
  clientSecret: "oauth-client-secret",
  localEnv: "ghp_local_mcp_env",
  formatterEnv: "npm_formatter_env",
  providerHeader: "Bearer provider",
  bodyKey: "sk-in-request-body",
  settingsKey: "sk-in-api-settings",
  variantHeader: "Bearer model-variant",
  agentHeader: "Bearer agent",
} as const

const probeDocument = () => ({
  server: { port: 4096, password: CREDENTIALS.serverPassword },
  instances: [{ name: "neo", url: "http://127.0.0.1:4097", token: CREDENTIALS.peerToken }],
  mcp: {
    servers: {
      weather: {
        type: "remote",
        url: "https://weather.example/mcp",
        headers: { Authorization: CREDENTIALS.remoteHeader },
        oauth: { client_id: "public-id", client_secret: CREDENTIALS.clientSecret },
      },
      files: {
        type: "local",
        command: ["node", "server.js"],
        environment: { PATH: "/usr/bin", SERVICE_TOKEN: CREDENTIALS.localEnv },
      },
      // A server a user called `headers`. Nothing about it is secret.
      headers: { type: "remote", url: "https://named-headers.example/mcp" },
    },
  },
  formatter: { prettier: { command: ["prettier"], environment: { NPM_TOKEN: CREDENTIALS.formatterEnv } } },
  providers: {
    "spark-holo": {
      name: "Spark Holo",
      api: {
        type: "native",
        url: "http://192.168.178.40:8010/v1",
        settings: { apiKey: CREDENTIALS.settingsKey, baseURL: "http://192.168.178.40:8010/v1" },
      },
      request: {
        headers: { Authorization: CREDENTIALS.providerHeader },
        body: { apiKey: CREDENTIALS.bodyKey, chat_template_kwargs: { enable_thinking: false } },
      },
      models: {
        // Inside an ARRAY inside a record inside a record — the shape a survey-depth walk misses.
        "holo3.1": { variants: [{ id: "long", headers: { Authorization: CREDENTIALS.variantHeader } }] },
      },
    },
  },
  agents: { build: { request: { headers: { Authorization: CREDENTIALS.agentHeader } } } },
})

/** Every primitive leaf of a value, as `path -> value`. Walks the PARSED object, never a JSON string:
 *  `JSON.stringify` escapes `\` to `\\`, so `expect(wire).not.toContain(windowsPath)` can never fire —
 *  the vacuous assertion that shipped on 2026-08-07 and was caught only by mutation. */
const leaves = (value: unknown, path: string[] = [], into = new Map<string, unknown>()) => {
  if (value === null || typeof value !== "object") into.set(path.join("."), value)
  else for (const [name, entry] of Object.entries(value)) leaves(entry, [...path, name], into)
  return into
}

const survivors = (redacted: unknown) => {
  const values = new Set([...leaves(redacted).values()].map((value) => String(value)))
  return Object.entries(CREDENTIALS)
    .filter(([, secret]) => values.has(secret))
    .map(([name]) => name)
    .sort()
}

describe("the secret marker is the single source of truth", () => {
  test("the probe document really does carry every credential — otherwise the redaction assertions are vacuous", () => {
    // An absence assertion is only worth what its presence control is worth.
    expect(survivors(probeDocument()).length).toBe(Object.keys(CREDENTIALS).length)
    expect(survivors(probeDocument())).toEqual(Object.keys(CREDENTIALS).sort())
  })

  test("the marker hides every one of them", () => {
    expect(survivors(ConfigProjection.redact(probeDocument()))).toEqual([])
  })

  test("the name test it replaces LEAKS three of them — measured, not asserted", () => {
    // `tool/configure.ts`'s `SECRET_FIELDS` matches five exact key names plus any object CALLED
    // `headers`. These three are credentials whose key is in neither set, so they read back in the
    // clear today: an OAuth `client_secret` (the brief's `credential`-shaped miss, exactly), and the
    // values of two `environment` maps. Ours does not fail on `monkey` — it is an exact-name test,
    // not a substring one — so the measured failure is this, and not the one the source has.
    expect(survivors(ConfigureTool.redactSecrets(probeDocument()))).toEqual([
      "clientSecret",
      "formatterEnv",
      "localEnv",
    ])
  })

  test("…and OVER-redacts a server a user named `headers`, which the marker leaves alone", () => {
    const named = (document: unknown) =>
      (document as { mcp: { servers: { headers: { type: string; url: string } } } }).mcp.servers.headers
    // The name test replaces every string field of anything called `headers`, so the server's own
    // `type` and `url` come back as the redaction sentence — and the repair becomes unmakeable.
    expect(named(ConfigureTool.redactSecrets(probeDocument())).url).toBe(ConfigureTool.REDACTED)
    expect(named(ConfigProjection.redact(probeDocument())).url).toBe("https://named-headers.example/mcp")
    expect(named(ConfigProjection.redact(probeDocument())).type).toBe("remote")
  })

  test("a named-entry marker hides the credential and KEEPS the repair target beside it", () => {
    const body = (
      ConfigProjection.redact(probeDocument()) as {
        providers: { "spark-holo": { request: { body: Record<string, unknown> } } }
      }
    ).providers["spark-holo"].request.body
    expect(body.apiKey).toBe(ConfigProjection.REDACTED)
    // AGENTS.md's decoded repair writes exactly here. Blanking the whole record to hide one key
    // would have destroyed the one repair the self-healing law cites as proof it works.
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  test("environment KEYS survive so 'which variables are set' is still answerable", () => {
    const environment = (
      ConfigProjection.redact(probeDocument()) as {
        mcp: { servers: { files: { environment: Record<string, unknown> } } }
      }
    ).mcp.servers.files.environment
    expect(Object.keys(environment).sort()).toEqual(["PATH", "SERVICE_TOKEN"])
    expect(environment.SERVICE_TOKEN).toBe(ConfigProjection.REDACTED)
  })

  test("the marker resolves whether it is applied inside or outside the optional wrapper", () => {
    // The trap: annotations do not resolve from a union member up to the union, so
    // `secret(X).pipe(Schema.optional)` would be a marker that silently does nothing.
    class Both extends Schema.Class<Both>("probe.Both")({
      outside: ConfigAnnotation.secret(Schema.String.pipe(Schema.optional)),
      inside: ConfigAnnotation.secret(Schema.String).pipe(Schema.optional),
      plain: Schema.String.pipe(Schema.optional),
    }) {}
    const fields = Both.fields
    // The raw predicate sees only the outer form — which is why the projection has its own walker.
    expect(ConfigAnnotation.isSecret(fields.outside.ast)).toBe(true)
    expect(ConfigAnnotation.isSecret(fields.inside.ast)).toBe(false)
    expect(ConfigAnnotation.isSecret(fields.plain.ast)).toBe(false)
  })

  test("every marked path in Config.Info is pinned BY NAME, so adding or dropping a marker is a visible decision", () => {
    // A13.5's other consumer: `adoption.md` A3's operator view is only honest if this list is the
    // whole list. It is walked off the schema exhaustively — see `secretPaths`.
    expect(ConfigProjection.secretPaths()).toEqual([
      "agents.<key>.request.body.apiKey",
      "agents.<key>.request.headers",
      "formatter.<key>.environment",
      "instances.[].token",
      "mcp.servers.<key>.environment",
      "mcp.servers.<key>.headers",
      "mcp.servers.<key>.oauth.client_secret",
      "models.<key>.api.settings.apiKey",
      "models.<key>.request.body.apiKey",
      "models.<key>.request.headers",
      "models.<key>.variants.[].body.apiKey",
      "models.<key>.variants.[].headers",
      "providers.<key>.api.settings.apiKey",
      "providers.<key>.models.<key>.api.settings.apiKey",
      "providers.<key>.models.<key>.request.body.apiKey",
      "providers.<key>.models.<key>.request.headers",
      "providers.<key>.models.<key>.variants.[].body.apiKey",
      "providers.<key>.models.<key>.variants.[].headers",
      "providers.<key>.request.body.apiKey",
      "providers.<key>.request.headers",
      "server.password",
    ])
  })

  test("no name is a credential in one union branch and a setting in another", () => {
    // `redact` searches a union's branches in order and takes the first that declares the name. That
    // is correct exactly while this list is empty — so the list IS the guard, and a schema change
    // that breaks it fails here rather than leaking quietly.
    expect(ConfigProjection.ambiguousSecretNames()).toEqual([])

    // ⚠️ The positive control, without which the line above is self-referential: `[]` is also what a
    // detector that always returns `[]` says. A schema that DOES have the ambiguity must come back
    // named, or the empty answer over `Config.Info` means nothing.
    const Safe = Schema.Struct({ kind: Schema.Literal("safe"), value: Schema.String.pipe(Schema.optional) })
    const Risky = Schema.Struct({
      kind: Schema.Literal("risky"),
      value: ConfigAnnotation.secret(Schema.String.pipe(Schema.optional)),
    })
    expect(ConfigProjection.ambiguousSecretNames({ probe: Schema.Union([Safe, Risky]) })).toEqual(["value"])
    // …and the same pair with the marker removed is NOT reported, so it is measuring secrecy rather
    // than merely "this name appears twice".
    expect(ConfigProjection.ambiguousSecretNames({ probe: Schema.Union([Safe, Safe]) })).toEqual([])
  })

  test("the enumeration and the redactor agree — a marker nothing can walk to is a marker that does nothing", () => {
    // The failure this catches is silent by construction: a marked field the redactor's walk cannot
    // reach reads back in the clear while the ledger above still lists it as covered.
    const document = probeDocument()
    const before = leaves(document)
    const after = leaves(ConfigProjection.redact(document))
    const changed = [...before.keys()].filter((path) => before.get(path) !== after.get(path))
    expect(changed.sort()).toEqual([
      "agents.build.request.headers.Authorization",
      "formatter.prettier.environment.NPM_TOKEN",
      "instances.0.token",
      "mcp.servers.files.environment.PATH",
      "mcp.servers.files.environment.SERVICE_TOKEN",
      "mcp.servers.weather.headers.Authorization",
      "mcp.servers.weather.oauth.client_secret",
      "providers.spark-holo.api.settings.apiKey",
      "providers.spark-holo.models.holo3.1.variants.0.headers.Authorization",
      "providers.spark-holo.request.body.apiKey",
      "providers.spark-holo.request.headers.Authorization",
      "server.password",
    ])
  })
})

// ═══ 4. no second copy of any existing table ═══════════════════════════════════════════════════

describe("the projection joins the existing tables rather than restating them", () => {
  test("every Config.Info key is projected, and its price comes from KEY_TIERS", () => {
    const projected = ConfigProjection.overview()
    expect(projected.length).toBe(Object.keys(Config.Info.fields).length)
    expect(projected.length).toBeGreaterThan(40)
    const wrong = projected
      .filter((key) => key.tier !== ConfigureTool.tierOf(key.path[0]!))
      .map((key) => key.path.join("."))
    expect(wrong).toEqual([])
    // The join has to be non-trivial: if every key priced the same, agreeing would prove nothing.
    expect(new Set(projected.map((key) => key.tier)).size).toBe(3)
  })

  test("storage, removability and liveness are read from the ledgers that own them", () => {
    for (const key of ConfigProjection.overview()) {
      const name = key.path[0]!
      expect(key.stored.kind === "discarded").toBe(ConfigStoreWrite.NOT_ROUTED_KEYS.has(name))
      expect(key.removable.kind === "no").toBe(ConfigStoreWrite.REMOVE_REFUSED_KEYS.has(name))
      expect(key.live.kind === "restart").toBe(ConfigStoreWrite.RESTART_REQUIRED_KEYS.has(name))
    }
    // Non-vacuity: these two ledgers are non-empty today, so both branches above are actually taken.
    expect(ConfigStoreWrite.NOT_ROUTED_KEYS.size).toBeGreaterThan(0)
    expect(ConfigStoreWrite.REMOVE_REFUSED_KEYS.size).toBeGreaterThan(0)
    // ⚠️ **The third ledger is EMPTY, so its branch is UNREACHABLE and this file says so rather than
    // pretending otherwise.** `RESTART_REQUIRED_KEYS` held exactly one key, `plugins`, and ruling 5 /
    // step 17 deleted it — there is no longer a config write this instance cannot make live. The loop
    // above therefore proves nothing about `live.kind === "restart"`, and asserting `size > 0` here
    // would just be a red test demanding a defect exist. What IS still checked: the ledger is empty
    // (so no key silently acquired a restart requirement without a reason), every projected key
    // agrees, and the mechanism itself is negative-controlled over a SYNTHETIC ledger in
    // `config-reload-order-ledger.test.ts`. Refill this ledger and the loop above covers it again.
    expect(ConfigStoreWrite.RESTART_REQUIRED_KEYS.size).toBe(0)
    expect(ConfigProjection.overview().filter((key) => key.live.kind === "restart")).toEqual([])
  })

  test("the rendered key states the removal verb in the shape that verb accepts", () => {
    // Ruling 2 and item 4.3: a dotted string names nothing, because `holo3.1` splits into two
    // segments. The projection must never print one.
    const rendered = ConfigProjection.renderKey("providers", 2)
    expect(rendered).toContain('{"paths":[["providers"]]}')
    expect(rendered).not.toContain('"providers.')
    // `models` is deletable only through `providers`, and the projection passes that reason through.
    expect(ConfigProjection.renderKey("models", 0)).toContain('["providers", "<providerID>", "models", "<modelID>"]')
  })
})

// ═══ 5. depends and defaults — the two annotations a rename would orphan ═══════════════════════

describe("authored annotations cannot drift", () => {
  const authored = () => {
    const out: { field: ConfigProjection.Field; dependency: ConfigAnnotation.Dependency }[] = []
    const visit = (field: ConfigProjection.Field, depth: number) => {
      for (const dependency of field.depends ?? []) out.push({ field, dependency })
      if (depth <= 0) return
      for (const child of ConfigProjection.describe(field.path, 1)?.children ?? []) visit(child, depth - 1)
    }
    for (const name of ConfigProjection.keys()) {
      const key = ConfigProjection.describe([name], 1)
      if (key !== undefined) visit(key, 4)
    }
    return out
  }

  test("every `depends` target resolves to a real node", () => {
    const entries = authored()
    expect(entries.length).toBeGreaterThanOrEqual(6)
    const dangling = entries
      .filter(({ dependency }) => ConfigProjection.describe(dependency.path, 0) === undefined)
      .map(({ dependency }) => dependency.path.join("."))
    expect(dangling).toEqual([])
    // A dependency with no cited source is an opinion; the annotation type cannot enforce non-empty.
    expect(entries.filter(({ dependency }) => dependency.source.trim().length === 0)).toEqual([])
  })

  test("`depends` is pinned by name, because adding one is a claim about another file", () => {
    expect(
      authored()
        .map(({ field, dependency }) => `${field.path.join(".")} -> ${dependency.path.join(".")} (${dependency.when})`)
        .sort(),
    ).toEqual([
      "computer.screenshotPath -> computer.display (set)",
      "memory.embedding -> memory.enabled (set)",
      "memory.embedding.model -> memory.embedding.url (set)",
      "memory.rerank -> memory.enabled (set)",
      "server.mdnsDomain -> server.mdns (set)",
      "telemetry.enabled -> offline (unset)",
      "web_search.disabledEngines -> web_search.searxngUrl (unset)",
    ])
  })

  test("every declared default IS the compiled constant, not a copy of it", () => {
    expect(ConfigProjection.describe(["provider_connection", "stall_timeout_ms"], 0)!.default).toEqual({
      value: ConfigProviderConnection.DEFAULT_STALL_TIMEOUT_MS,
      source: "config/provider-connection.ts DEFAULT_STALL_TIMEOUT_MS",
    })
    expect(ConfigProjection.describe(["computer", "screenshotPath"], 0)!.default).toEqual({
      value: ConfigComputer.DEFAULT_SCREENSHOT_PATH,
      source: "config/computer.ts DEFAULT_SCREENSHOT_PATH",
    })
    // A field with no declaration reports nothing rather than guessing — `strict.wallMinutes` says
    // "(default: 45)" in its PROSE and the projection deliberately does not parse that.
    expect(ConfigProjection.describe(["strict", "wallMinutes"], 0)!.default).toBeUndefined()
    // ⚠️ Asserted per LINE, not with `not.toContain`: `strict.wallMinutes`'s own DESCRIPTION says
    // "(default: 45)", so a substring check would have failed for the wrong reason and then been
    // "fixed" by deleting the claim. The claim is that the projection emits no `default:` LINE.
    const emitted = ConfigProjection.renderKey("strict", 1)
      .split("\n")
      .filter((line) => line.trim().startsWith("default:"))
    expect(emitted).toEqual([])
    expect(
      ConfigProjection.renderKey("provider_connection", 1)
        .split("\n")
        .filter((line) => line.trim().startsWith("default:")),
    ).toEqual([
      "    default: 300000 (from config/provider-connection.ts DEFAULT_STALL_TIMEOUT_MS)",
      "    default: 5000 (from config/provider-connection.ts DEFAULT_DISCOVERY_TIMEOUT_MS)",
      "    default: 45000 (from config/provider-connection.ts DEFAULT_COMPLETION_TIMEOUT_MS)",
      "    default: 120000 (from config/provider-connection.ts DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS)",
      "    default: 512 (from config/provider-connection.ts DEFAULT_CAPABILITY_PROBE_MAX_TOKENS)",
    ])
  })

  test("legal values and constraints come off the schema's own checks", () => {
    expect(ConfigProjection.describe(["expertise"], 0)!.values).toEqual(['"normal"', '"advanced"', '"developer"'])
    expect(ConfigProjection.describe(["provider_connection", "stall_timeout_ms"], 0)!.constraints).toEqual([
      "integer",
      "between 30000 and 1800000",
    ])
    // A union of struct branches is NOT a closed value set, and reporting one would be a lie a
    // caller could act on.
    expect(ConfigProjection.describe(["mcp", "servers", "<key>"], 0)!.values).toBeUndefined()
  })
})

// ═══ 6. THE DECODE: a described write, made through the real surface ═══════════════════════════

/** Every store `ConfigStoreWrite.apply`/`overlay` resolve, over the `:memory:` database `test/preload.ts`
 *  gives each test file. This is the graph the `configure` tool builds — not a mock of it. */
const stores = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    SettingsConfigStore.node,
    CatalogStore.node,
    AgentConfigStore.node,
    CommandConfigStore.node,
    ReferenceConfigStore.node,
    SkillConfigStore.node,
  ]),
  [],
) as Layer.Layer<
  | Database.Service
  | SettingsConfigStore.Service
  | CatalogStore.Service
  | AgentConfigStore.Service
  | CommandConfigStore.Service
  | ReferenceConfigStore.Service
  | SkillConfigStore.Service
>

describe("a repair the projection describes actually lands", () => {
  it.effect("a complete capability service declaration persists through the PATCH /config write path", () =>
    Effect.gen(function* () {
      const declaration = {
        capabilities: ["document.parse.native"],
        transport: {
          type: "streamable-http" as const,
          url: "http://127.0.0.1:9010/mcp",
          audience: "novaclaw-local",
        },
        locality: "local" as const,
        protocol_revision: "2025-06-18",
        types: ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
        limits: { input_bytes: 16_777_216, handle_bytes: 33_554_432 },
        resources: { estimated_resident_bytes: 1_073_741_824, estimated_peak_bytes: 1_610_612_736 },
        warmup_timeout_ms: 120_000,
        idle_timeout_ms: 300_000,
        health: { interval_ms: 30_000, timeout_ms: 5_000 },
        device: "spark-services",
      }
      const consumed = yield* ConfigStoreWrite.apply(
        Schema.decodeUnknownSync(Config.Info)({ capability_services: { anydoc: declaration } }),
      )
      expect([...consumed]).toEqual(["capability_services"])
      const stored = (yield* ConfigStoreWrite.overlay({})) as {
        capability_services: Record<string, typeof declaration>
      }
      expect(stored.capability_services.anydoc).toEqual(declaration)
    }).pipe(Effect.provide(stores)),
  )

  it.effect(
    "read the projection for providers.<id>.models.<id>.request, send exactly what it prescribes, read the store back",
    () =>
      Effect.gen(function* () {
        const path = ["providers", "spark-holo", "models", "holo3.1", "request"]

        // ── 1. what the projection SAYS ──────────────────────────────────────────────────────
        const request = ConfigProjection.describe(path, 1)!
        expect(request.write.kind).toBe("merge")
        const body = request.children.find((child) => child.path.at(-1) === "body")!
        expect(body.write.kind).toBe("merge")
        expect(body.secret).toBe(false)
        expect(body.secretEntries).toEqual(["apiKey"])

        // ── 2. seed a provider the way an instance holds one, then do the write it prescribes ──
        const seed = {
          providers: {
            "spark-holo": {
              name: "Spark Holo",
              api: { type: "native", url: "http://192.168.178.40:8010/v1", settings: {} },
              models: { "holo3.1": { name: "Holo 3.1" } },
            },
          },
        }
        yield* ConfigStoreWrite.apply(Schema.decodeUnknownSync(Config.Info)(seed))

        // Exactly the fragment the projection's `merge` sentence licenses — only the field being
        // changed, no spread of the entry, no `headers`. If the projection is wrong, this fails.
        const patch = documentAt(path, { body: { chat_template_kwargs: { enable_thinking: false } } })
        const consumed = yield* ConfigStoreWrite.apply(Schema.decodeUnknownSync(Config.Info)(patch))
        expect([...consumed]).toEqual(["providers"])

        // ── 3. read the STORE back, not the value we sent ─────────────────────────────────────
        const stored = (yield* ConfigStoreWrite.overlay({})) as {
          providers: Record<string, { name?: string; api?: unknown; models: Record<string, { request?: unknown }> }>
        }
        const model = stored.providers["spark-holo"]!.models["holo3.1"]!
        expect(model.request).toEqual({ body: { chat_template_kwargs: { enable_thinking: false } } })
        // The merge did not eat the entry's siblings — which is the other half of "objects merge".
        expect(stored.providers["spark-holo"]!.name).toBe("Spark Holo")
        expect(stored.providers["spark-holo"]!.api).toEqual({
          type: "native",
          url: "http://192.168.178.40:8010/v1",
          settings: {},
        })
      }).pipe(Effect.provide(stores)),
  )

  it.effect("…and the write the projection REFUSES to license is refused by the surface too", () =>
    Effect.gen(function* () {
      // `providers.<id>.api` is a variant, so the projection never tells a caller to send `{url}`.
      // The surface agrees: the decode fails before `apply` is reached, which is why this is the
      // repair AGENTS.md records as never having been expressible.
      const fragment = documentAt(["providers", "spark-holo", "api"], { url: "http://moved.example/v1" })
      expect(decodes(fragment)).toBe(false)

      // The alternative the projection DOES license lands.
      const complete = documentAt(["providers", "spark-holo", "api"], {
        type: "native",
        url: "http://moved.example/v1",
        settings: {},
      })
      yield* ConfigStoreWrite.apply(Schema.decodeUnknownSync(Config.Info)(complete))
      const stored = (yield* ConfigStoreWrite.overlay({})) as {
        providers: Record<string, { api?: { url?: string } }>
      }
      expect(stored.providers["spark-holo"]!.api!.url).toBe("http://moved.example/v1")
    }).pipe(Effect.provide(stores)),
  )
})
