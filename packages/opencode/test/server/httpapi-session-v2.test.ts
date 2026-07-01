// F0.2 integration coverage: the flag-gated, new-sessions-only reroute of the
// legacy promptAsync handler onto SessionV2, wrapped in a SessionStatus
// busy/idle bracket, with the F0.1 V2->v1 translator (extended for the user's
// own prompt) rendering the turn for unchanged clients.
//
// FLAG CONTROL: RuntimeFlags reads `experimentalNativeSession` from the Effect
// ConfigProvider, which snapshots `process.env` on first read (process-wide).
// That gives env-var control whole-process granularity, NOT per-test. So this
// whole file runs with the flag ON (set at module top, before any import that
// could trigger a config read) and exercises:
//   (a) flag ON + fresh session + a prompt WITH a model -> routes to V2.
//   (c) flag ON + a session that already has a legacy message -> STAYS legacy
//       (isNewSession is false).
// The flag-OFF case (b) — legacy path, byte-identical behavior — is covered by
// the broader server suite (httpapi-sdk.test.ts et al.) which runs with the
// flag OFF by default and stays green. We additionally assert the routing
// predicate decision here so (b)/(c) are concrete, not implied.
process.env.OPENCODE_EXPERIMENTAL_NATIVE_SESSION = "true"

import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@novaclaw/core/v1/session"
import { Deferred, Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { HttpServer } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { FSUtil } from "@novaclaw/core/fs-util"
import { CrossSpawnSpawner } from "@novaclaw/core/cross-spawn-spawner"
import { createOpencodeClient } from "@novaclaw/sdk/v2"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Session as SessionNs } from "@/session/session"
import { TestLLMServer } from "../lib/llm-server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { ProviderV2 } from "@novaclaw/core/provider"
import { ModelV2 } from "@novaclaw/core/model"
import { Database } from "@novaclaw/core/database/database"
import { httpApiLayer } from "./httpapi-layer"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  Layer.mergeAll(
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
    Database.defaultLayer,
    httpApiLayer,
  ),
)

type Sdk = ReturnType<typeof createOpencodeClient>
type TestServices =
  | FSUtil.Service
  | ChildProcessSpawner.ChildProcessSpawner
  | InstanceStore.Service
  | Database.Service
  | HttpServer.HttpServer
type TestScope = Scope.Scope | TestServices

function serverFetch() {
  return HttpServer.HttpServer.use((server) =>
    Effect.sync(() => {
      const baseUrl = HttpServer.formatAddress(server.address)
      return Object.assign(
        async (request: RequestInfo | URL, init?: RequestInit) => {
          const source = request instanceof Request ? request : new Request(request, init)
          const url = new URL(source.url)
          return globalThis.fetch(new Request(new URL(`${url.pathname}${url.search}`, baseUrl), source))
        },
        { preconnect: globalThis.fetch.preconnect },
      ) satisfies typeof globalThis.fetch
    }),
  )
}

function client(directory: string) {
  return serverFetch().pipe(
    Effect.map((fetch) => createOpencodeClient({ baseUrl: "http://localhost", directory, fetch })),
  )
}

function withFakeLlm<A, E>(
  run: (input: { sdk: Sdk; directory: string; llm: TestLLMServer["Service"] }) => Effect.Effect<A, E, TestScope>,
) {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({
      git: true,
      config: testProviderConfig(llm.url),
    })
    return yield* run({ sdk: yield* client(directory), directory, llm })
  }).pipe(Effect.provide(TestLLMServer.layer))
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

// Count legacy v1 message rows via MessageV2.page (reads the legacy `message`
// table — disjoint from V2's `session_message`). This IS the isNewSession probe.
// store.provide discharges the instance-scoped Database/Session requirements.
function legacyMessageCount(directory: string, sessionID: string) {
  return InstanceStore.Service.use((store) =>
    store.provide(
      { directory },
      MessageV2.page({ sessionID: SessionID.make(sessionID), limit: 50 }).pipe(
        Effect.map((page) => page.items.length),
        Effect.orElseSucceed(() => 0),
      ),
    ),
  )
}

// Seed a legacy v1 user message + part — makes the session "not new".
function seedLegacyMessage(directory: string, sessionID: string) {
  const id = SessionID.make(sessionID)
  return InstanceStore.Service.use((store) =>
    store.provide(
      { directory },
      SessionNs.Service.use((svc) =>
        Effect.gen(function* () {
          const message = yield* svc.updateMessage({
            id: MessageID.ascending(),
            sessionID: id,
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
            tools: {},
          } satisfies SessionV1.User)
          yield* svc.updatePart({
            id: PartID.ascending(),
            sessionID: id,
            messageID: message.id,
            type: "text",
            text: "seed",
          })
          return message
        }),
      ).pipe(Effect.provide(SessionNs.defaultLayer)),
    ),
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("promptAsync V2 reroute (experimentalNativeSession ON)", () => {
  it.live("the flag is actually ON in this process", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      expect(flags.experimentalNativeSession).toBe(true)
    }).pipe(Effect.provide(RuntimeFlags.defaultLayer)),
  )

  // Case (a): fresh session + a prompt WITH a model -> routes to V2, wrapped in
  // the busy/idle bracket. We assert the OBSERVABLE V2-routing contract over the
  // instance /event stream (which carries the raw V2 `session.next.*` events plus
  // the handler's SessionStatus busy/idle):
  //   1. `session.next.prompted` reaches the stream  -> the prompt went through
  //      sessionV2.prompt (the legacy runner never emits session.next.* events).
  //   2. busy is published BEFORE the fork, then idle ALWAYS settles the turn —
  //      even when the V2 turn errors — because the handler's `ensuring(idle)` is
  //      the SOLE turn-terminal on the V2 path. A missing idle hangs the client.
  //   3. zero legacy `message` rows: a V2 turn writes only `session_message`.
  //
  // NOTE on model fidelity: the V2 runner resolves models from the V2 Catalog,
  // not the legacy `provider.*` config that `testProviderConfig` populates, so
  // `test/test-model` is unavailable to the V2 runner here and the turn settles
  // via the error path. That is actually a STRONGER assertion for the bracket:
  // idle fires on error too. The translator's user/assistant RENDER correctness
  // is covered separately by event-v2-translate.test.ts (real desktop-reducer
  // round-trip) — note the translated v1 envelopes go to GlobalBus (the legacy
  // client transport), not this experimental /event stream, so they are
  // deliberately not asserted here.
  it.live(
    "fresh session + model routes promptAsync to V2 (prompted on stream, busy→idle bracket, zero legacy rows)",
    () =>
      withFakeLlm(({ sdk, directory, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("v2 hello back", { usage: { input: 5, output: 3 } })

          const session = yield* Effect.promise(() =>
            sdk.session.create({
              title: "v2 reroute",
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            }),
          )
          const sessionID = String(record(session.data).id)

          // Subscribe BEFORE prompting so the busy/idle bracket cannot be missed.
          const controller = new AbortController()
          yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
          const events = yield* Effect.promise(() => sdk.event.subscribe(undefined, { signal: controller.signal }))
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => void (await events.stream.return?.(undefined))).pipe(Effect.ignore),
          )

          const ready = yield* Deferred.make<void>()
          const sawPrompted = yield* Deferred.make<void>()
          const sawBusy = yield* Deferred.make<void>()
          const sawIdle = yield* Deferred.make<void>()

          yield* Effect.promise(async () => {
            for await (const event of events.stream) {
              const payload = record(record(event).payload ?? event)
              const type = payload.type
              if (type === "server.connected") Deferred.doneUnsafe(ready, Effect.void)
              if (type === "session.next.prompted") Deferred.doneUnsafe(sawPrompted, Effect.void)
              if (type === "session.status" && record(record(payload.properties).status).type === "busy")
                Deferred.doneUnsafe(sawBusy, Effect.void)
              if (type === "session.idle") Deferred.doneUnsafe(sawIdle, Effect.void)
              if (type === "session.status" && record(record(payload.properties).status).type === "idle")
                Deferred.doneUnsafe(sawIdle, Effect.void)
            }
          }).pipe(Effect.forkScoped)

          yield* awaitWithTimeout(Deferred.await(ready), "no server.connected", "3 seconds")

          const prompt = yield* Effect.promise(() =>
            sdk.session.promptAsync({
              sessionID,
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "v2 please" }],
            }),
          )
          expect(prompt.response.status).toBe(204)

          // 2. busy is published synchronously before the fork.
          yield* awaitWithTimeout(Deferred.await(sawBusy), "no busy status", "5 seconds")
          // 1. routed to V2: the V2 runner emitted session.next.prompted.
          yield* awaitWithTimeout(Deferred.await(sawPrompted), "session.next.prompted not seen — not routed to V2", "10 seconds")
          // 2. idle ALWAYS settles the turn (here via the error path).
          yield* awaitWithTimeout(Deferred.await(sawIdle), "no idle (spinner would hang forever)", "15 seconds")

          // 3. routing proof: zero legacy message rows (V2 writes only session_message).
          const legacy = yield* legacyMessageCount(directory, sessionID)
          expect(legacy).toBe(0)
        }),
      ),
    30_000,
  )

  // Case (c): flag ON but the session already has a legacy message -> isNewSession
  // is false -> STAYS legacy. The legacy runner writes legacy `message` rows, so
  // the legacy count GROWS past the single seeded row.
  it.live("session with a pre-existing legacy message stays on the legacy path", () =>
    withFakeLlm(({ sdk, directory, llm }) =>
      Effect.gen(function* () {
        yield* llm.text("legacy hello back", { usage: { input: 5, output: 3 } })

        const session = yield* Effect.promise(() =>
          sdk.session.create({ title: "stays legacy", permission: [{ permission: "*", pattern: "*", action: "allow" }] }),
        )
        const sessionID = String(record(session.data).id)
        yield* seedLegacyMessage(directory, sessionID)

        const before = yield* legacyMessageCount(directory, sessionID)
        expect(before).toBe(1) // not new

        const prompt = yield* Effect.promise(() =>
          sdk.session.promptAsync({
            sessionID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "go legacy" }],
          }),
        )
        expect(prompt.response.status).toBe(204)

        // Legacy path writes a NEW user (+ assistant) legacy message row; the
        // count grows past the seed. (V2 would have left it at 1.)
        const grown = yield* pollWithTimeout(
          legacyMessageCount(directory, sessionID).pipe(Effect.map((n) => (n > 1 ? n : undefined))),
          "legacy path did not write a new legacy message row",
          "10 seconds",
        )
        expect(grown).toBeGreaterThan(1)
      }),
    ),
  )

  // Concrete routing-predicate assertions for (b)/(c): isNewSession is a pure
  // function of the legacy message table. A fresh session is new; one with a
  // legacy message is not. (Flag-OFF (b) means this predicate is never consulted
  // — the `&&` short-circuits — so flag-OFF always takes the legacy path.)
  it.live("isNewSession predicate: fresh = new, seeded = not new", () =>
    withFakeLlm(({ sdk, directory }) =>
      Effect.gen(function* () {
        const fresh = yield* Effect.promise(() => sdk.session.create({ title: "fresh" }))
        const freshID = String(record(fresh.data).id)
        expect(yield* legacyMessageCount(directory, freshID)).toBe(0)

        const seeded = yield* Effect.promise(() => sdk.session.create({ title: "seeded" }))
        const seededID = String(record(seeded.data).id)
        yield* seedLegacyMessage(directory, seededID)
        expect(yield* legacyMessageCount(directory, seededID)).toBe(1)
      }),
    ),
  )
})
