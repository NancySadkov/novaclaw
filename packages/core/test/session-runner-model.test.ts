import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { LLM } from "@novaclaw/llm"
import { LLMClient } from "@novaclaw/llm/route"
import { DateTime, Effect } from "effect"
import { Headers } from "effect/unstable/http"
import { Credential } from "@novaclaw/core/credential"
import { Integration } from "@novaclaw/core/integration"
import { LocalModelManager } from "@novaclaw/core/local-model-manager"
import { ModelV2 } from "@novaclaw/core/model"
import { ProbeWindow } from "@novaclaw/core/probe-window"
import { ProviderV2 } from "@novaclaw/core/provider"
import { ProjectV2 } from "@novaclaw/core/project"
import { DeviceRegistry } from "@novaclaw/core/session/device-registry"
import { SessionRunnerModel } from "@novaclaw/core/session/runner/model"
import { healthyAlternative, usableFallback } from "@novaclaw/core/session/runner/model"
import { SessionV2 } from "@novaclaw/core/session"
import { AbsolutePath } from "@novaclaw/core/schema"
import { it } from "./lib/effect"
import { stripComments } from "./lib/source-scan"

type Api =
  | {
      readonly type: "aisdk"
      readonly package: string
      readonly url?: string
      readonly settings?: Record<string, unknown>
    }
  | { readonly type: "native"; readonly url?: string; readonly settings: Record<string, unknown> }

const model = (api: Api, variants: ModelV2.Info["variants"] = []) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test-provider"),
    name: "Test model",
    api: { id: ModelV2.ID.make("api-test-model"), ...api },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: {
      headers: { "x-test": "header" },
      body: { apiKey: "secret", custom_extension: { enabled: true } },
    },
    variants,
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 100, output: 20 },
  })

describe("SessionRunnerModel", () => {
  it.effect("asks the managed runtime to prepare the selected model before the provider request", () =>
    Effect.gen(function* () {
      const calls: LocalModelManager.ModelRequest[] = []
      const manager: LocalModelManager.Interface = {
        status: () => Effect.die("unused"),
        install: () => Effect.die("unused"),
        stop: () => Effect.die("unused"),
        ensure: (request) => Effect.sync(() => calls.push(request)),
      }
      const selected = model({
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "http://127.0.0.1:11343/v1",
      })

      yield* SessionRunnerModel.ensureManagedModel(manager, selected)

      expect(calls).toEqual([
        {
          providerID: "test-provider",
          modelID: "test-model",
          apiModelID: "api-test-model",
          baseURL: "http://127.0.0.1:11343/v1",
          context: 100,
        },
      ])
    }),
  )

  it.effect("maps catalog OpenAI AI SDK models into native Responses routes", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )

      expect(resolved).toMatchObject({ id: "api-test-model", provider: "test-provider" })
      expect(resolved.route).toMatchObject({
        id: "openai-responses",
        endpoint: { baseURL: "https://openai.example/v1" },
        defaults: {
          headers: { "x-test": "header" },
          limits: { context: 100, output: 20 },
          http: { body: { custom_extension: { enabled: true } } },
        },
      })
    }),
  )

  // ── THE TOOL CHANNEL, and the precedence it resolves by ────────────────────────────────────────
  //
  // Three layers can have an opinion about how a model is offered tools, and the order is the whole
  // point (AGENTS.md's self-healing law: "defaults ship in code, but a store override always wins"):
  //
  //     the protocol's native default  <  what the probe MEASURED  <  what the OPERATOR configured
  //
  // Get it backwards and a re-test silently undoes a deliberate decision, with no way to make one
  // stick.

  it.effect("nothing measured and nothing configured leaves the model on its native channel", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )
      expect(resolved.compatibility?.toolChannel).toBeUndefined()
    }),
  )

  it.effect("a measurement selects the channel when the operator has said nothing", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
        undefined,
        "prompted",
      )
      expect(resolved.compatibility?.toolChannel).toBe("prompted")
    }),
  )

  it.effect("🔴 the OPERATOR's configured channel beats the measurement", () =>
    Effect.gen(function* () {
      const configured = ModelV2.Info.make({
        ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
        request: { headers: {}, body: { toolChannel: "native" } },
      })
      const resolved = yield* SessionRunnerModel.fromCatalogModel(configured, undefined, "prompted")
      expect(resolved.compatibility?.toolChannel).toBe("native")
    }),
  )

  it.effect("🔴 the knob never reaches the wire as a provider parameter", () =>
    Effect.gen(function* () {
      // It is a harness-side statement about the endpoint, like `thinkingBudget`. Left in the body
      // it would be sent to a server that has no such parameter, and a strict one rejects the whole
      // request — turning a repair into a dead model.
      const configured = ModelV2.Info.make({
        ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
        request: { headers: {}, body: { toolChannel: "prompted", custom_extension: { enabled: true } } },
      })
      const resolved = yield* SessionRunnerModel.fromCatalogModel(configured)
      expect(resolved.route.defaults.http?.body).toEqual({ custom_extension: { enabled: true } })
    }),
  )

  it.effect("prefers a live probed window over the catalog context limit", () =>
    Effect.gen(function* () {
      ProbeWindow.clear()
      ProbeWindow.remember("test-provider", "test-model", 32768)
      const probed = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )
      expect(probed.route.defaults.limits).toMatchObject({ context: 32768, output: 20 })

      // A window remembered for a DIFFERENT provider's model must not leak over.
      ProbeWindow.clear()
      ProbeWindow.remember("other-provider", "test-model", 4096)
      const fallback = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )
      expect(fallback.route.defaults.limits).toMatchObject({ context: 100, output: 20 })
      ProbeWindow.clear()
    }),
  )

  it.effect("keeps catalog apiKey credentials out of provider JSON", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(JSON.stringify(prepared.body)).not.toContain("apiKey")
      expect(JSON.stringify(prepared.body)).not.toContain("secret")
    }),
  )

  it.effect("uses merged API settings for OpenAI-compatible auth and request defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://compatible.example/v1",
            settings: { apiKey: "settings-secret", compatibility: "strict" },
          }),
          request: { headers: {}, body: {} },
        }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://compatible.example/v1/chat/completions",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer settings-secret")
      // The openai-compatible route carries the unattended repetition FLOOR (repetition-floor.ts):
      // a model that sets no `repetition_penalty` gets 1.05 so small local models don't loop. The
      // plain OpenAI/Anthropic routes reject the param and must never receive it.
      expect(resolved.route.defaults.http?.body).toEqual({ repetition_penalty: 1.05 })
    }),
  )

  it.effect("overlays selected OpenAI Session variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }, [
        {
          id: ModelV2.VariantID.make("high"),
          headers: { "x-variant": "high" },
          body: {
            store: false,
            service_tier: "priority",
            temperature: 0.2,
            reasoning: { effort: "high" },
          },
        },
      ])
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_model_variant"),
        slug: "test",
        version: "test",
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: ModelV2.VariantID.make("high"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)

      expect(resolved.route.defaults.headers).toMatchObject({ "x-test": "header", "x-variant": "high" })
      // Protocol-owned sampling (temperature) is routed to the canonical generation options,
      // not the http.body overlay — the native transport rejects those keys in an overlay.
      // See session/runner/sampling-split.ts.
      expect(resolved.route.defaults.generation).toMatchObject({ temperature: 0.2 })
      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        store: false,
        service_tier: "priority",
        reasoning: { effort: "high" },
      })
    }),
  )

  it.effect("overlays selected OpenAI-compatible Session variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model(
        { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compatible.example/v1" },
        [
          {
            id: ModelV2.VariantID.make("high"),
            headers: {},
            body: { store: false, reasoning_effort: "high" },
          },
        ],
      )
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_compatible_variant"),
        slug: "test",
        version: "test",
        title: "test",
        model: { id: catalog.id, providerID: catalog.providerID, variant: ModelV2.VariantID.make("high") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)

      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        store: false,
        reasoning_effort: "high",
        // openai-compatible → the unattended repetition floor applies (see above).
        repetition_penalty: 1.05,
      })
    }),
  )

  // THE FALLBACK DECISIONS — the branches that had no test at any level, and shipped two bugs in one
  // day because of it. Pure now (`usableFallback` / `healthyAlternative`), so the rule is checkable
  // without a catalog, a settings store and a local-model manager.
  describe("choosing a model when the chosen one cannot serve", () => {
    const m = (id: string) => ({ providerID: "p", id })
    const all = (m: { id: string }) => true
    const same = (a: { id: string }, b: { id: string }) => a.id === b.id

    test("unavailable: the instance default is preferred when it can serve", () => {
      expect(usableFallback({ fallback: m("default"), available: [m("other")], supported: all })).toEqual(m("default"))
    })

    test("unavailable: an UNSUPPORTED default is skipped for one that works", () => {
      // The default can be a model this session cannot use — a vision-only chat on a text model, say.
      // Falling back onto it would swap one refusal for another.
      const supported = (x: { id: string }) => x.id !== "default"
      expect(usableFallback({ fallback: m("default"), available: [m("ok")], supported })).toEqual(m("ok"))
    })

    test("unavailable: nothing usable answers undefined rather than a wrong model", () => {
      expect(usableFallback({ fallback: undefined, available: [], supported: all })).toBeUndefined()
    })

    test("unhealthy: routes to the default when it is healthy", () => {
      expect(
        healthyAlternative({
          selected: m("sick"),
          fallback: m("default"),
          available: [m("default")],
          supported: all,
          sick: (x) => x.id === "sick",
          same,
        }),
      ).toEqual(m("default"))
    })

    test("🔴 unhealthy: never routes onto a model that is ALSO sick", () => {
      // Two dead endpoints is not a recovery. It must fall through to a third, or to nothing.
      expect(
        healthyAlternative({
          selected: m("sick"),
          fallback: m("alsoSick"),
          available: [m("alsoSick"), m("good")],
          supported: all,
          sick: (x) => x.id.includes("ick"),
          same,
        }),
      ).toEqual(m("good"))
    })

    test("🔴 unhealthy: when the DEFAULT is the thing that is down, stay put", () => {
      // `undefined` = keep the selected model and report its real error. Anything else logs a
      // recovery that did not happen — the fault described falsely.
      expect(
        healthyAlternative({
          selected: m("sick"),
          fallback: m("sick"),
          available: [m("sick")],
          supported: all,
          sick: () => true,
          same,
        }),
      ).toBeUndefined()
    })

    test("🔴 unhealthy: never 'falls back' onto the selected model itself", () => {
      // The `same` guard. Without it a sick model that is also the instance default would be logged
      // as a fallback to itself, every single turn.
      expect(
        healthyAlternative({
          selected: m("only"),
          fallback: undefined,
          available: [m("only")],
          supported: all,
          sick: () => false,
          same,
        }),
      ).toBeUndefined()
    })
  })

  // 🔴 THE JOIN. The decisions above are pure; nothing in them says `resolve` asks. A source ledger
  // because the service needs a catalog, a capability store, a settings store, an integration
  // registry and a local-model manager to build — the same split `kb-scan-hydration.test.ts` uses.
  test("resolve asks BOTH fallback decisions, and the health one is not guarded on session.model", () => {
    const source = fs
      .readFileSync(path.join(import.meta.dir, "../src/session/runner/model.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
    const resolve = source.slice(source.indexOf('SessionRunnerModel.resolve"'))
    expect(resolve).toContain("usableFallback({")
    expect(resolve).toContain("healthyAlternative({")
    // 🔴 The bug that shipped: the health branch was written `if (selected && session.model)`, copied
    // from the unavailable branch above it. `session.model` is the session ROW, and a colleague's
    // model arrives through the AGENT fold — so the guard was false for every roster colleague and
    // the fallback never fired. The unavailable branch legitimately keeps it: it reports what was
    // asked for and has nothing else to name.
    const health = resolve.slice(resolve.indexOf("healthyAlternative({") - 600, resolve.indexOf("healthyAlternative({"))
    expect(health).not.toMatch(/if \(selected && session\.model\)/)
  })

  // 🔴 THE TWO IDENTITIES A MODEL HAS, and why health has to key on the catalog one.
  //
  // Measured 2026-08-22: holo3.1's endpoint went down, four turns failed with `Transport` in one
  // process, and the "model gives errors" fallback never fired. Two causes, both invisible to every
  // test that existed — this one pins the half that is a pure fact about the shapes.
  it.effect("a resolved model's `id` is the API id, NOT the catalog id", () =>
    Effect.gen(function* () {
      const catalogEntry = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" })
      const resolved = yield* SessionRunnerModel.fromCatalogModel(catalogEntry)
      // The catalog knows it as `test-model`; the wire carries `api-test-model`. Anything that
      // records a fact about a model from the RESOLVED object and looks it up from the CATALOG entry
      // is filing under one key and reading from another — exactly how `ModelHealth` counted
      // failures nobody ever read.
      expect(String(resolved.id)).toBe("api-test-model")
      expect(String(catalogEntry.id)).toBe("test-model")
      expect(String(resolved.id)).not.toBe(String(catalogEntry.id))
      // …and the PROVIDER does agree, which is why a half-correct key looks right at a glance.
      expect(String(resolved.provider)).toBe(String(catalogEntry.providerID))
    }),
  )

  it.effect("rejects an explicit unavailable Session variant during model resolution", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" })
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_model_variant_unavailable"),
        slug: "test",
        version: "test",
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: ModelV2.VariantID.make("unknown"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const failure = yield* SessionRunnerModel.resolve(session, catalog).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.VariantUnavailableError",
        providerID: "test-provider",
        modelID: "test-model",
        variant: "unknown",
      })
      expect(failure.message).toBe("Variant unavailable for test-provider/test-model: unknown")
    }),
  )

  it.effect("overlays selected Anthropic Session variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }, [
        {
          id: ModelV2.VariantID.make("high"),
          headers: {},
          body: { thinking: { type: "enabled", budget_tokens: 12000 } },
        },
      ])
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_anthropic_variant"),
        slug: "test",
        version: "test",
        title: "test",
        model: { id: catalog.id, providerID: catalog.providerID, variant: ModelV2.VariantID.make("high") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)

      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        thinking: { type: "enabled", budget_tokens: 12000 },
      })
    }),
  )

  it.effect("maps catalog Anthropic AI SDK models into native routes", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }),
      )

      expect(resolved.route).toMatchObject({
        id: "anthropic-messages",
        endpoint: { baseURL: "https://anthropic.example/v1" },
      })
    }),
  )

  it.effect("uses resolved credentials for bearer auth", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: {} },
        }),
        Credential.Key.make({ type: "key", key: "secret" }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer secret")
    }),
  )

  it.effect("prefers stored credentials over configured auth", () =>
    Effect.gen(function* () {
      const credential = Credential.Key.make({ type: "key", key: "stored-secret", metadata: { tenant: "work" } })
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: { apiKey: "configured-secret" } },
        }),
        credential,
      )
      const headers = yield* resolved.route.auth.apply({
        request: LLM.request({ model: resolved, prompt: "Hello" }),
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer stored-secret")
      expect(resolved.route.defaults.http?.body).toEqual({ tenant: "work" })
    }),
  )

  it.effect("does not project OAuth account metadata into the request body", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: {} },
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("device"),
          access: "secret",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          metadata: { server: "https://console.example", orgID: "org_123" },
        }),
      )

      expect(resolved.route.defaults.http?.body).toEqual({})
    }),
  )

  it.effect("rejects catalog APIs without a native route", () =>
    Effect.gen(function* () {
      const failure = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1" }),
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.UnsupportedApiError",
        providerID: "test-provider",
        modelID: "test-model",
        api: "aisdk:@ai-sdk/google",
      })
      expect(failure.message).toBe("Unsupported API for test-provider/test-model: aisdk:@ai-sdk/google")
    }),
  )

  it.effect("reports whether a catalog model has a supported native route", () =>
    Effect.sync(() => {
      expect(
        SessionRunnerModel.supported(
          model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
        ),
      ).toBe(true)
      expect(
        SessionRunnerModel.supported(
          model({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1" }),
        ),
      ).toBe(false)
      expect(SessionRunnerModel.supported(model({ type: "native", settings: {} }))).toBe(false)
    }),
  )
})

describe("deviceKeyFor — a DEVICE is a backend, not a model", () => {
  const named = (id: string, providerID: string, url?: string) =>
    ModelV2.Info.make({
      ...model(
        url === undefined
          ? { type: "native", settings: {} }
          : { type: "aisdk", package: "@ai-sdk/openai-compatible", url },
      ),
      id: ModelV2.ID.make(id),
      providerID: ProviderV2.ID.make(providerID),
    })

  // ⭐ THE CLAIM THE CHANGE EXISTS FOR. Under the old `${provider}/${model}` key these two were
  // two devices, so the scheduler gave each its own MAX_BATCH and its own fairness ledger while
  // they shared one vLLM process. Anything weaker than this assertion does not test the fix.
  it.effect("two models on ONE vLLM backend are ONE device", () =>
    Effect.sync(() => {
      const a = SessionRunnerModel.deviceKeyFor(named("holo3.1", "spark-holo", "http://192.168.178.40:8010/v1"))
      const b = SessionRunnerModel.deviceKeyFor(named("qwen3.6-35b", "dgx-spark", "http://192.168.178.40:8010/v1"))
      expect(a).toBe(b)
    }),
  )

  it.effect("normalizes the three ways two catalog entries for one server differ", () =>
    Effect.sync(() => {
      const canonical = SessionRunnerModel.deviceKeyFor(named("m", "p", "http://192.168.178.40:8010/v1"))
      for (const url of [
        "http://192.168.178.40:8010/v1/",
        "http://192.168.178.40:8010",
        "HTTP://192.168.178.40:8010/V1",
        "http://192.168.178.40:8010/v1/chat/completions",
      ])
        expect(SessionRunnerModel.deviceKeyFor(named("m", "p", url))).toBe(canonical)
    }),
  )

  // The control. Grouping must not become "everything is one device": a different PORT is a
  // different serving process, and a different host is a different machine.
  it.effect("a different port or host stays a different device", () =>
    Effect.sync(() => {
      const base = SessionRunnerModel.deviceKeyFor(named("m", "p", "http://192.168.178.40:8010/v1"))
      expect(SessionRunnerModel.deviceKeyFor(named("m", "p", "http://192.168.178.40:8011/v1"))).not.toBe(base)
      expect(SessionRunnerModel.deviceKeyFor(named("m", "p", "http://192.168.178.41:8010/v1"))).not.toBe(base)
      expect(SessionRunnerModel.deviceKeyFor(named("m", "p", "https://192.168.178.40:8010/v1"))).not.toBe(base)
    }),
  )

  // The deliberate carve-out (see `deviceKeyFor`): no endpoint means no shared local capacity to
  // protect, so those models keep a per-model key rather than being collapsed onto one gate.
  it.effect("models with no endpoint keep a per-model key", () =>
    Effect.sync(() => {
      expect(SessionRunnerModel.deviceKeyFor(named("a", "openai"))).toBe("openai/a")
      expect(SessionRunnerModel.deviceKeyFor(named("b", "openai"))).toBe("openai/b")
    }),
  )

  // A catalog defect must not fail a turn, and the fallback must be the SAFE direction: a
  // per-model key can only over-partition (waste capacity), never over-share (oversubscribe).
  it.effect("a malformed endpoint falls back to the per-model key instead of throwing", () =>
    Effect.sync(() => {
      expect(SessionRunnerModel.deviceKeyFor(named("m", "p", "not a url"))).toBe("p/m")
    }),
  )

  // ── B2: `deviceKey = resolvedDevice`. Both overrides land in this ONE function. ──────────────
  const spark: DeviceRegistry.EndpointMap = DeviceRegistry.endpointMap({
    spark: { endpoints: ["http://192.168.178.40:8010", "http://192.168.178.40:8011"] },
  })

  // ⭐ THE CLAIM THE REGISTRY EXISTS FOR, and the half `e5c4e4ec6` could not derive: two SERVING
  // PROCESSES on one box are two origins and one GPU. Under the derived key alone these are two
  // devices, so the gate hands out MAX_BATCH twice for capacity that exists once.
  it.effect("two PROCESSES on one registered device are ONE device", () =>
    Effect.sync(() => {
      const vllm = SessionRunnerModel.deviceKeyFor(named("holo3.1", "spark-holo", "http://192.168.178.40:8010/v1"), {
        endpoints: spark,
      })
      const llama = SessionRunnerModel.deviceKeyFor(named("gemma", "spark-gguf", "http://192.168.178.40:8011/v1"), {
        endpoints: spark,
      })
      expect(vllm).toBe("spark")
      expect(llama).toBe("spark")
      // …and without the registry they are still two, so this measures the registry and not the URL.
      expect(SessionRunnerModel.deviceKeyFor(named("gemma", "spark-gguf", "http://192.168.178.40:8011/v1"))).not.toBe(
        SessionRunnerModel.deviceKeyFor(named("holo3.1", "spark-holo", "http://192.168.178.40:8010/v1")),
      )
    }),
  )

  it.effect("an origin no device claims keeps its own derived key", () =>
    Effect.sync(() => {
      expect(
        SessionRunnerModel.deviceKeyFor(named("m", "p", "http://192.168.178.41:8010/v1"), { endpoints: spark }),
      ).toBe("http://192.168.178.41:8010")
    }),
  )

  it.effect("an unknown pin cannot mint a scheduler capacity namespace", () =>
    Effect.sync(() => {
      const model = named("holo3.1", "spark-holo", "http://192.168.178.40:8010/v1")
      expect(
        SessionRunnerModel.resolveDevicePlacement({
          selected: model,
          available: [model],
          declared: "never-registered",
          endpoints: spark,
        }),
      ).toEqual({ _tag: "refused", reason: "unknown" })
    }),
  )

  it.effect("a known Device refuses a model it cannot serve", () =>
    Effect.sync(() => {
      const model = named("holo3.1", "spark-holo", "http://192.168.178.41:8010/v1")
      expect(
        SessionRunnerModel.resolveDevicePlacement({
          selected: model,
          available: [model],
          declared: "spark",
          declaredKnown: true,
          endpoints: spark,
        }),
      ).toEqual({ _tag: "refused", reason: "incompatible" })
    }),
  )

  it.effect("a valid pin selects the same model on that Device and derives the real key", () =>
    Effect.sync(() => {
      const laptop = named("holo3.1", "laptop-holo", "http://192.168.178.41:8010/v1")
      const onSpark = named("holo3.1", "spark-holo", "http://192.168.178.40:8010/v1")
      const placement = SessionRunnerModel.resolveDevicePlacement({
        selected: laptop,
        available: [laptop, onSpark],
        declared: "spark",
        declaredKnown: true,
        endpoints: spark,
      })
      expect(placement).toMatchObject({ _tag: "placed", model: onSpark, key: "spark" })
    }),
  )

  it.effect("an empty declaration uses automatic endpoint placement", () =>
    Effect.sync(() => {
      const model = named("m", "p", "http://192.168.178.40:8010/v1")
      expect(
        SessionRunnerModel.resolveDevicePlacement({ selected: model, available: [model], declared: "" }),
      ).toMatchObject({ _tag: "placed", key: "http://192.168.178.40:8010" })
    }),
  )
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A SOURCE ratchet, because the CALL SITE is invisible to behaviour.
//
// `deviceKeyFor` above is fully tested and still worth nothing if the runner never calls it: the
// scheduler key is not observable in any assertion the drain harness can make, so a `deviceKeyFor`
// that nothing consumes would ship inert and every test on this page would stay green. That is the
// "a guard's SITE is invisible to behaviour, so it needs a SOURCE ledger" lesson, applied before
// it costs anything.
//
// ⚠️ Comments are stripped first. This repo has produced three wrong numbers in one day from
// regexes that counted PROSE, twice inside guards that then reported the very thing they existed
// to prevent — and the call site here sits under an eight-line comment that quotes the old
// expression verbatim.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("the runner CONSULTS the device key (source ratchet)", () => {

  const runnerSource = () => {
    const file = path.resolve(import.meta.dir, "../src/session/runner/llm.ts")
    const raw = fs.readFileSync(file, "utf8")
    // Non-vacuity: an empty or moved file must FAIL rather than satisfy every "not present" check.
    expect(raw.length).toBeGreaterThan(10_000)
    const code = stripComments(raw)
    expect(code).toContain("scheduledDevice: resolvedModel.device")
    return code
  }

  const modelSource = () => {
    const file = path.resolve(import.meta.dir, "../src/session/runner/model.ts")
    const raw = fs.readFileSync(file, "utf8")
    expect(raw.length).toBeGreaterThan(10_000)
    return stripComments(raw)
  }

  it.effect("computes scheduling facts from SessionRunnerModel.device, not from the wire model id", () =>
    Effect.sync(() => {
      const code = runnerSource()
      const line = code.split("\n").find((text) => text.includes("models.resolveWithDevice("))
      expect(line).toBeDefined()
      expect(line).toContain("models.resolveWithDevice(")
    }),
  )

  it.effect("resolves and refuses a Device pin before provider dispatch can start", () =>
    Effect.sync(() => {
      const code = runnerSource()
      const placement = code.indexOf("models.resolveWithDevice(")
      const dispatch = code.indexOf("ProviderDispatch.runAndSettle(")
      expect(placement).toBeGreaterThan(0)
      expect(dispatch).toBeGreaterThan(placement)
    }),
  )

  it.effect("chooses a pinned catalog placement before resolving the automatic provider route", () =>
    Effect.sync(() => {
      const code = modelSource()
      const compound = code.indexOf('const resolveWithDevice: Interface["resolveWithDevice"]')
      const pin = code.indexOf('if (session.device !== undefined && session.device !== "")', compound)
      const automatic = code.indexOf("base.resolve(session, options)", compound)
      expect(compound).toBeGreaterThan(0)
      expect(pin).toBeGreaterThan(compound)
      expect(automatic).toBeGreaterThan(pin)
    }),
  )

  it.effect("has no scheduler-key fallback after the placement decision", () =>
    Effect.sync(() => {
      const code = runnerSource()
      expect(code).not.toContain("deviceKey: scheduledDevice?.key ??")
      expect(code).toContain("deviceKey: scheduledDevice.key")
    }),
  )

  it.effect("carries declared concurrency and locality into the scheduler slot", () =>
    Effect.sync(() => {
      const code = runnerSource()
      expect(code).toContain("scheduledDevice.concurrency")
      expect(code).toContain("scheduledDevice.locality")
    }),
  )

  // ⭐ THE INERT CASE, and it is the one this ratchet earns its keep on. `session.device` can have a
  // column, a migration, a descriptor entry, a wire field, a registry and a fully-tested
  // `deviceKeyFor` — and if the runner never hands the CHAIN-RESOLVED value to the service, the
  // whole chain ships doing nothing with every test on this page green. `models.device(session)`
  // reads `session.device` off the object it is given, and the object it is given is `modelSession`,
  // so the declaration reaches the key ONLY if `modelSession` overlays `config.device` the way it
  // already overlays `config.model`. Nothing observable to the drain harness says whether it does.
  it.effect("hands the CHAIN-RESOLVED device to the model service, not the raw row", () =>
    Effect.sync(() => {
      const code = runnerSource()
      const start = code.indexOf("const modelSession")
      expect(start).toBeGreaterThan(0)
      // The literal, from `const modelSession` to its closing brace — small enough that a match here
      // cannot be some other `device:` elsewhere in a 2,200-line file.
      const literal = code.slice(start, code.indexOf("\n      }", start))
      expect(literal).toContain("model: config.model")
      expect(literal).toContain("device: config.device")
    }),
  )
})

describe("SessionRunnerModel.resolveDefault", () => {
  /**
   * The entry point for work with NO conversation behind it — document ingestion is the case it
   * exists for. It is not a new resolution path: `select()` already resolves `catalog.model.default()`
   * when a session carries no model. This only gives that branch a door that does not demand a
   * session.
   */
  it.effect("the test seam refuses BY NAME rather than pretending to have a default", () =>
    Effect.gen(function* () {
      const layer = SessionRunnerModel.layerWith(() => Effect.die("resolve unused here"))
      const outcome = yield* Effect.gen(function* () {
        const models = yield* SessionRunnerModel.Service
        return yield* models.resolveDefault()
      }).pipe(Effect.provide(layer), Effect.flip)
      // ⚠️ In the file's own error VOCABULARY, not a global Error. `Error` there is a local union
      // type, so a `new Error(...)` here would not even typecheck — which is the point of having it.
      expect(outcome._tag).toBe("SessionRunnerModel.NoDefaultModelError")
      // Narrowed on the tag before reading the payload: `Error` here is the file's closed UNION, so
      // `reason` exists only on this member.
      if (outcome._tag !== "SessionRunnerModel.NoDefaultModelError") throw new Error("unreachable")
      expect(outcome.reason).toContain("seam")
    }),
  )

  it.effect("a seam that DOES supply one is used unchanged (negative control)", () =>
    Effect.gen(function* () {
      const stub = { modelID: "stub" } as never
      const layer = SessionRunnerModel.layerWith(
        () => Effect.die("resolve unused here"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => Effect.succeed(stub),
      )
      const got = yield* Effect.gen(function* () {
        const models = yield* SessionRunnerModel.Service
        return yield* models.resolveDefault()
      }).pipe(Effect.provide(layer))
      expect(got).toBe(stub)
    }),
  )

  test("the real resolver REUSES the session path rather than re-deriving it", () => {
    // ⚠️ A second copy of model selection is a second place to forget `ensureManagedModel`, and
    // forgetting it means a managed local model is never woken for this path while every symptom
    // points at the model. A source ledger because the sharing is invisible once it compiles.
    const src = fs.readFileSync(path.join(import.meta.dir, "../src/session/runner/model.ts"), "utf8")
    const start = src.indexOf('resolveDefault: Effect.fn("SessionRunnerModel.resolveDefault")')
    const end = src.indexOf("tier: Effect.fn(", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const body = src.slice(start, end)
    expect(body).toContain("yield* select(sessionless)")
    expect(body).toContain("ensureManagedModel(localModels, selected")
    // No fabricated session id reaches diagnostics: the error names the instance, not a session.
    expect(body).toContain("NoDefaultModelError")
    expect(body).not.toContain("ModelNotSelectedError")
  })
})

// AN EXPLICIT REQUEST IS NOT A SUGGESTION.
//
// 🔴 Found by the RELEASE gate, 2026-08-23. The fallback added for a colleague whose configured model
// is temporarily down had also started swallowing `--model does/not-exist`: `novaclaw run` exited 0
// having quietly run something else, defeating `run-process.test.ts`'s regression guard for #27371.
// Both rules are right; the resolver could not tell them apart, because an agent-declared model and a
// user-named one arrive on the same field. `requested` is the distinction, read from the RAW ROW.
describe("the fallback never substitutes for a model the user NAMED", () => {
  test("an explicit request that cannot be served is an error, not a substitution", () => {
    // The unavailable branch is guarded on `options.requested === true` BEFORE the fallback runs, so
    // ordering is the property: a `requested` model must never reach `usableFallback`.
    const source = fs
      .readFileSync(path.join(import.meta.dir, "../src/session/runner/model.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
    const guard = source.indexOf("options?.requested === true")
    const fallback = source.indexOf("usableFallback({")
    expect(guard).toBeGreaterThan(0)
    expect(fallback).toBeGreaterThan(guard)
  })

  test("the runner reads `requested` from the ROW, never from the resolved overlay", () => {
    // ⚠️ The overlay carries the colleague's configuration, so asking IT whether the user named a
    // model always answers yes — and the fallback would then never fire for the case it exists for.
    const runner = fs
      .readFileSync(path.join(import.meta.dir, "../src/session/runner/llm.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
    expect(runner).toMatch(/requested: session\.model !== undefined/)
  })
})
