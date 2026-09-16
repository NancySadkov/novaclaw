import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { Catalog } from "@novaclaw/core/catalog"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { ConfigProvider } from "@novaclaw/core/config/provider"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionMessage } from "@novaclaw/core/session/message"
import { FileAttachment } from "@novaclaw/core/session/prompt"
import { ModelHealth } from "@novaclaw/core/session/runner/model-health"
import { SessionRunnerModel } from "@novaclaw/core/session/runner/model"
import { ProviderRecovery } from "@novaclaw/core/session/runner/provider-recovery"
import { unreadableTurnAttachments } from "@novaclaw/core/session/runner/to-llm-message"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { ApplicationTools } from "../src/tool/application-tools"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { Reference } from "../src/reference"
import { SettingsConfigStore } from "../src/settings-config-store"

/**
 * 🔴 THE TURN'S MODEL FACTS MUST DESCRIBE THE MODEL THE TURN RAN ON.
 *
 * `SessionRunnerModel.resolve` owns two fallbacks — a configured model the catalog cannot serve, and
 * one `ModelHealth` says is failing — and both used to reassign a LOCAL that nothing downstream
 * could see. Every other fact about "this turn's model" (`taxonomy`, `prePrompt`, `retryAttempts`,
 * `capabilities`, `imageLimit`, `ref`, `device`) re-entered `select()`, which applies NEITHER
 * fallback, so a demoted session held two models at once: the substitute served the request while
 * the facts described the sick original.
 *
 * **The failure that makes it a P1 rather than a tidiness item is the one asserted below.** A
 * colleague on a vision model whose endpoint dies runs turn 3 on the text-only default, and
 * `capabilities` still answered `input: ["text","image"]` — so `unreadableTurnAttachments` passed
 * the user's screenshot straight into a text-only request, producing exactly the provider
 * media-type 400 the capability gate exists to prevent. The mirror is silent and worse: a text-only
 * selection falling back to a vision model replaces every image with *"was NOT sent to you"* and
 * instructs a model that can see the picture to say it has not.
 *
 * ⚠️ **Driven against the REAL `locationLayer`, never a seam.** The whole defect lives in the split
 * between `resolve()`'s fallbacks and `select()`, and `SessionRunnerModel.layerWith` has neither —
 * a test on it would assert the harness rather than the code. The rig is `location-layer.test.ts`'s
 * location service map, with the two providers written straight into the catalog: config plumbing
 * is a different subsystem's claim, and routing this one through it would let a config regression
 * report itself as this bug.
 */

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ApplicationTools.node,
      CatalogStore.node,
      Database.node,
      EventV2.node,
      SettingsConfigStore.node,
      LocationServiceMap.node,
    ]),
  ),
)

const SEER = ProviderV2.ID.make("seer")
const VISION = ModelV2.ID.make("vision")
const SCRIBE = ProviderV2.ID.make("scribe")
const TEXT = ModelV2.ID.make("text")
const ECHO = ProviderV2.ID.make("echo")
const CLOSE = ModelV2.ID.make("close")

/** The health tracker's key for the model this session is configured on. */
const SICK = { providerID: String(SEER), id: String(VISION) }

const screenshot = SessionMessage.User.make({
  id: SessionMessage.ID.make("msg_shot"),
  type: "user",
  text: "What is on my screen?",
  files: [
    FileAttachment.make({
      uri: "data:image/png;base64,aGVsbG8=",
      mime: "image/png",
      name: "screenshot.png",
    }),
  ],
  time: { created: DateTime.makeUnsafe(0) },
})

const sessionOn = (location: Location.Ref) =>
  SessionV2.Info.make({
    id: SessionV2.ID.make("ses_model_ran"),
    slug: "test",
    version: "test",
    title: "test",
    model: { id: VISION, providerID: SEER },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location,
  })

const defaultSessionOn = (location: Location.Ref) => SessionV2.Info.make({ ...sessionOn(location), model: undefined })

const named = (model: ModelV2.Info | ModelV2.Ref | undefined) =>
  model === undefined ? undefined : `${model.providerID}/${model.id}`

const configuredProvider = (
  url: string,
  modelID: string,
  disabled = false,
  capabilities: { tools: boolean; input: string[]; output: string[] } = {
    tools: true,
    input: ["text", "image"],
    output: ["text"],
  },
) =>
  Schema.decodeUnknownSync(ConfigProvider.Info)({
    api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url, settings: {} },
    models: {
      [modelID]: {
        name: modelID,
        disabled,
        capabilities,
      },
    },
  })

/**
 * Two providers whose per-turn facts DIFFER in every field the runner reads. A shared value would
 * let an assertion pass on the wrong model, which is exactly the confusion under test.
 */
const seedCatalog = (catalog: Catalog.Interface) =>
  catalog.transform((editor) => {
    editor.provider.update(SEER, (provider) => {
      provider.name = "Seer"
      provider.api = {
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "http://127.0.0.1:9101/v1",
        settings: {},
      }
      provider.request.body.apiKey = "seer-key"
    })
    editor.model.update(SEER, VISION, (model) => {
      model.name = "Vision"
      model.capabilities = { tools: true, input: ["text", "image"], output: ["text"] }
      model.taxonomy = "smart"
      model.prePrompt = "SEER PRE-PROMPT"
      model.retry = { attempts: 7 }
      model.limit = { context: 4096, output: 512, images: 9 }
    })
    editor.provider.update(SCRIBE, (provider) => {
      provider.name = "Scribe"
      provider.api = {
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "http://127.0.0.1:9102/v1",
        settings: {},
      }
      provider.request.body.apiKey = "scribe-key"
    })
    editor.model.update(SCRIBE, TEXT, (model) => {
      model.name = "Text"
      // A fallback must cover the unavailable model's architectural capabilities. This substitute
      // retains vision while changing every other per-turn fact exercised below.
      model.capabilities = { tools: true, input: ["text", "image"], output: ["text"] }
      model.taxonomy = "fast"
      model.prePrompt = "SCRIBE PRE-PROMPT"
      model.retry = { attempts: 2 }
      model.limit = { context: 2048, output: 256, images: 3 }
    })
    // Pin the instance default, so WHICH model the fallback lands on is decided by the rule under
    // test rather than by whatever `available()` happens to list first.
    editor.model.default.set(SCRIBE, TEXT)
  })

describe("SessionRunnerModel — the per-turn facts follow the fallback", () => {
  it.live("a health demotion moves capabilities, class, pre-prompt, retry, image cap and ref onto the substitute", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = sessionOn(location)

          yield* Effect.gen(function* () {
            // Same order as `location-layer.test.ts`: touching `Reference` boots this location.
            yield* Reference.Service
            const catalog = yield* Catalog.Service
            const models = yield* SessionRunnerModel.Service
            const settings = yield* SettingsConfigStore.Service
            yield* seedCatalog(catalog)

            // Non-vacuity: both models really are in this location's catalog, so a later
            // "it resolved to scribe/text" cannot be an artefact of seer/vision having vanished.
            const available = (yield* catalog.model.available()).map(named)
            expect(available).toContain("seer/vision")
            expect(available).toContain("scribe/text")

            // ── CONTROL: healthy. The turn runs on the model the session chose. ──────────────────
            const healthy = yield* models.resolveWithDevice(session)
            expect(named(healthy.ran)).toBe("seer/vision")
            const healthyFacts = SessionRunnerModel.perTurnFacts(healthy.ran!)
            expect(healthyFacts.capabilities?.input).toEqual(["text", "image"])
            // A vision model may be shown the screenshot — the gate lets it through.
            expect(unreadableTurnAttachments([screenshot], healthyFacts.capabilities)).toEqual([])

            // ── The endpoint dies: its cross-worker reconnect circuit opens. ────────────────────
            const at = Date.now()
            yield* settings.update("provider_recovery", (current) =>
              ProviderRecovery.failed(ProviderRecovery.decode(current), SICK, at),
            )

            const demoted = yield* models.resolveWithDevice(session)
            expect(named(demoted.ran)).toBe("scribe/text")
            expect(named((yield* models.resolveWithDevice(session, { requested: true })).ran)).toBe("scribe/text")
            const facts = SessionRunnerModel.perTurnFacts(demoted.ran!)

            // The substitute matches the unavailable model's vision requirement, so rerouting does
            // not silently discard the user's screenshot.
            expect(unreadableTurnAttachments([screenshot], facts.capabilities)).toEqual([])

            // Every fact, each with a value only the SUBSTITUTE has.
            expect(facts.capabilities?.input).toEqual(["text", "image"])
            expect(facts.ref).toEqual({ providerID: SCRIBE, id: TEXT })
            expect(facts.taxonomy).toBe("fast")
            expect(facts.prePrompt).toBe("SCRIBE PRE-PROMPT")
            expect(facts.retryAttempts).toBe(2)
            expect(facts.imageLimit).toBe(3)
            expect(demoted.device.key).toBe("http://127.0.0.1:9102")

            // ── And the accessors AGREE with the resolution: one answer, not two. ───────────────
            expect(yield* models.capabilities(session)).toEqual(facts.capabilities!)
            expect(yield* models.ref(session)).toEqual(facts.ref)
            expect(yield* models.taxonomy(session)).toBe("fast")
            expect(yield* models.prePrompt(session)).toBe("SCRIBE PRE-PROMPT")
            expect(yield* models.retryAttempts(session)).toBe(2)
            expect(yield* models.imageLimit(session)).toBe(3)
            expect((yield* models.device(session))?.key).toBe(demoted.device.key)
          }).pipe(
            Effect.scoped,
            Effect.provide(LocationServiceMap.Service.get(location)),
            Effect.ensuring(Effect.sync(() => ModelHealth.reset())),
          )
        }),
      ),
    ),
  )
})

describe("SessionRunnerModel — a Settings switch outranks a worker's stale catalog", () => {
  it.live("immediately substitutes the enabled default when the former default is switched off", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const store = yield* CatalogStore.Service
          yield* store.setLayers(SEER, [configuredProvider("http://127.0.0.1:9101/v1", String(VISION))])
          yield* store.setLayers(SCRIBE, [configuredProvider("http://127.0.0.1:9102/v1", String(TEXT))])
          yield* store.setDefault(`${SEER}/${VISION}`)

          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = defaultSessionOn(location)
          yield* Effect.gen(function* () {
            yield* Reference.Service
            const catalog = yield* Catalog.Service
            const models = yield* SessionRunnerModel.Service

            expect(named((yield* models.resolveWithDevice(session)).ran)).toBe("seer/vision")

            // Simulate a host-process Settings write. This worker receives no process-local reload
            // callback, so its catalog remains observably stale until the model module reconciles it.
            yield* store.setLayers(SEER, [configuredProvider("http://127.0.0.1:9101/v1", String(VISION), true)])
            yield* store.setDefault(`${SCRIBE}/${TEXT}`)
            expect((yield* catalog.model.get(SEER, VISION))?.enabled).toBe(true)

            const switched = yield* models.resolveWithDevice(session)
            expect(named(switched.ran)).toBe("scribe/text")
            expect((yield* catalog.model.get(SEER, VISION))?.enabled).toBe(false)
            expect(yield* models.dispatchAllowed({ providerID: SEER, id: VISION })).toBe(false)
            expect(yield* models.dispatchAllowed({ providerID: SCRIBE, id: TEXT })).toBe(true)
            expect(
              yield* models.guardDispatch({ providerID: SCRIBE, id: TEXT }, Effect.succeed("contacted substitute")),
            ).toBe("contacted substitute")
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      ),
    ),
  )

  it.live("substitutes with the capability-CLOSEST model, not the instance default", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const store = yield* CatalogStore.Service
          // The assigned model asks for text only, and is switched off.
          yield* store.setLayers(SEER, [
            configuredProvider("http://127.0.0.1:9101/v1", String(VISION), true, {
              tools: true,
              input: ["text"],
              output: ["text"],
            }),
          ])
          // The instance default is CAPABLE but farther (it carries two extra modalities)…
          yield* store.setLayers(SCRIBE, [
            configuredProvider("http://127.0.0.1:9102/v1", String(TEXT), false, {
              tools: true,
              input: ["text", "image"],
              output: ["text", "image"],
            }),
          ])
          // …while this one matches the assigned model exactly.
          yield* store.setLayers(ECHO, [
            configuredProvider("http://127.0.0.1:9103/v1", String(CLOSE), false, {
              tools: true,
              input: ["text"],
              output: ["text"],
            }),
          ])
          yield* store.setDefault(`${SCRIBE}/${TEXT}`)

          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = sessionOn(location)
          yield* Effect.gen(function* () {
            yield* Reference.Service
            const catalog = yield* Catalog.Service
            const models = yield* SessionRunnerModel.Service
            // Both substitutes really are in this location's catalog, so "it landed on echo/close"
            // cannot be an artefact of the default having vanished.
            const available = (yield* catalog.model.available()).map(named)
            expect(available).toContain("scribe/text")
            expect(available).toContain("echo/close")

            // 🔴 `invariants.md`: *"if several available pick the one with closest matching
            // capability"*. The default is closer to nobody here — it is the far one.
            const resolved = yield* models.resolveWithDevice(session)
            expect(named(resolved.ran)).toBe("echo/close")
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      ),
    ),
  )

  // 🔴 THE QUESTION THIS RULE EXISTS TO ANSWER: *"as soon as the picked model gets turned on, does
  // the agent switch back to it?"* — YES, on the very next resolution. The pin was never cleared (the
  // picker deliberately keeps the officer's stored choice), the resolution re-reads the store every
  // turn, and `select()` reconciles its worker-local catalog against the shared one, so a stale
  // "disabled" snapshot cannot keep the substitute alive. Nothing writes a recovery row for a
  // switched-off model either: turning it off is not a failure, so no backoff waits it out.
  it.live("returns to the assigned model the moment the owner switches it back on", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const store = yield* CatalogStore.Service
          // The officer's OWN model is switched off…
          yield* store.setLayers(SEER, [configuredProvider("http://127.0.0.1:9101/v1", String(VISION), true)])
          // …and one substitute exists, which is also the instance default.
          yield* store.setLayers(SCRIBE, [configuredProvider("http://127.0.0.1:9102/v1", String(TEXT))])
          yield* store.setDefault(`${SCRIBE}/${TEXT}`)

          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = sessionOn(location)
          yield* Effect.gen(function* () {
            yield* Reference.Service
            const models = yield* SessionRunnerModel.Service

            // Switched off → the substitute, and the assignment is REPORTED as substituted.
            const off = yield* models.resolveWithDevice(session)
            expect(named(off.ran)).toBe("scribe/text")
            expect(off.substituted?.reason).toBe("disabled")
            expect(named(off.substituted?.requested)).toBe("seer/vision")

            // The owner switches the assigned model back on.
            yield* store.setLayers(SEER, [configuredProvider("http://127.0.0.1:9101/v1", String(VISION), false)])

            // The very next resolution is the assigned model, with no substitution reported.
            const back = yield* models.resolveWithDevice(session)
            expect(named(back.ran)).toBe("seer/vision")
            expect(back.substituted).toBeUndefined()
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      ),
    ),
  )

  it.live("refuses dispatch when the switched-off model has no enabled substitute", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const store = yield* CatalogStore.Service
          yield* store.setLayers(SEER, [configuredProvider("http://127.0.0.1:9101/v1", String(VISION))])
          yield* store.setDefault(`${SEER}/${VISION}`)

          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = defaultSessionOn(location)
          yield* Effect.gen(function* () {
            yield* Reference.Service
            const catalog = yield* Catalog.Service
            const models = yield* SessionRunnerModel.Service
            expect(named((yield* models.resolveWithDevice(session)).ran)).toBe("seer/vision")

            yield* store.setLayers(SEER, [configuredProvider("http://127.0.0.1:9101/v1", String(VISION), true)])
            expect((yield* catalog.model.get(SEER, VISION))?.enabled).toBe(true)
            let contacted = false
            const blocked = yield* Effect.flip(
              models.guardDispatch(
                { providerID: SEER, id: VISION },
                Effect.sync(() => {
                  contacted = true
                }),
              ),
            )
            expect(blocked._tag).toBe("SessionRunnerModel.ModelUnavailableError")
            expect(contacted).toBe(false)

            const error = yield* Effect.flip(models.resolveWithDevice(session))
            expect(error._tag).toBe("SessionRunnerModel.ModelNotSelectedError")
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      ),
    ),
  )
})
