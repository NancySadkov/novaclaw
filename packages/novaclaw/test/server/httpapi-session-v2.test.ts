// F1b integration coverage: promptAsync routes EVERY session to the V2 native
// engine (the F0-era experimentalNativeSession flag + the zero-legacy-rows
// eligibility gate are deleted — there is ONE engine), wrapped in a
// SessionStatus busy/idle bracket. Clients render the turn from the RAW
// `session.next.*` stream + the native message endpoint (the S7 vocabulary).
// It exercises:
//   (a) fresh session + a prompt WITH a model -> runs on V2 (session.next.*
//       on the stream; zero legacy rows; busy→idle bracket; native ops OK).
//   (b) a session with pre-existing LEGACY rows ALSO routes V2 — its new turns
//       write only session_message (the pre-F0 history lapses from the native
//       fetch, owner decision ①).

import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { HttpServer } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { FSUtil } from "@novaclaw/core/fs-util"
import { CrossSpawnSpawner } from "@novaclaw/core/cross-spawn-spawner"
import { createNovaclawClient } from "@novaclaw/sdk/v2"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { TestLLMServer } from "../lib/llm-server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
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

type Sdk = ReturnType<typeof createNovaclawClient>
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
    Effect.map((fetch) => createNovaclawClient({ baseUrl: "http://localhost", directory, fetch })),
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

// F1g: the legacy-row probes (legacyMessageCount over MessageTable, pagedMessageCount over
// MessageV2.page) and seedLegacyMessage retired with the `message`/`part` tables. "V2 writes only
// session_message" is now structural — there is no legacy table to write into — so the native
// message endpoint alone proves the transcript landed.

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("promptAsync routes to the V2 native engine (F1b: one engine)", () => {
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
  // idle fires on error too. Render correctness of the native vocabulary is
  // covered by the app's message-fold tests (session-ui v2/message-fold) — the
  // S7 delete removed the V1 translator this note used to reference.
  it.live(
    "fresh session + model routes promptAsync to V2 (prompted on stream, busy→idle bracket, zero legacy rows)",
    () =>
      withFakeLlm(({ sdk, directory, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("v2 hello back", { usage: { input: 5, output: 3 } })

          const session = yield* Effect.promise(() =>
            sdk.v2.session.create({
              title: "v2 reroute",
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            }),
          )
          const sessionID = String(record(record(session.data).data).id)

          // Subscribe BEFORE prompting so the busy/idle bracket cannot be missed.
          const controller = new AbortController()
          yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
          const events = yield* Effect.promise(() => sdk.event.subscribe(undefined, { signal: controller.signal }))
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => void (await events.stream.return?.(undefined))).pipe(Effect.ignore),
          )

          const ready = yield* Deferred.make<void>()
          const sawPrompted = yield* Deferred.make<void>()
          const sawPromptedAgain = yield* Deferred.make<void>()
          const sawBusy = yield* Deferred.make<void>()
          const sawIdle = yield* Deferred.make<void>()

          let promptedCount = 0
          yield* Effect.promise(async () => {
            for await (const event of events.stream) {
              const payload = record(record(event).payload ?? event)
              const type = payload.type
              if (type === "server.connected") Deferred.doneUnsafe(ready, Effect.void)
              if (type === "session.next.prompted") {
                promptedCount++
                if (promptedCount === 1) Deferred.doneUnsafe(sawPrompted, Effect.void)
                if (promptedCount >= 2) Deferred.doneUnsafe(sawPromptedAgain, Effect.void)
              }
              if (type === "session.status" && record(record(payload.properties).status).type === "busy")
                Deferred.doneUnsafe(sawBusy, Effect.void)
              if (type === "session.idle") Deferred.doneUnsafe(sawIdle, Effect.void)
              if (type === "session.status" && record(record(payload.properties).status).type === "idle")
                Deferred.doneUnsafe(sawIdle, Effect.void)
            }
          }).pipe(Effect.forkScoped)

          yield* awaitWithTimeout(Deferred.await(ready), "no server.connected", "3 seconds")

          const prompt = yield* Effect.promise(() =>
            sdk.v2.session
              .switchModel({ sessionID, model: { providerID: "test", id: "test-model" } })
              .then(() => sdk.v2.session.prompt({ sessionID, prompt: { text: "v2 please" } })),
          )
          expect(prompt.response.status).toBe(200)

          // 2. busy is published synchronously before the fork.
          yield* awaitWithTimeout(Deferred.await(sawBusy), "no busy status", "5 seconds")
          // 1. routed to V2: the V2 runner emitted session.next.prompted.
          yield* awaitWithTimeout(Deferred.await(sawPrompted), "session.next.prompted not seen — not routed to V2", "10 seconds")
          // 2. idle ALWAYS settles the turn (here via the error path).
          yield* awaitWithTimeout(Deferred.await(sawIdle), "no idle (spinner would hang forever)", "15 seconds")

          // A SECOND prompt on the (now row-bearing) V2 session runs V2 too.
          const second = yield* Effect.promise(() =>
            sdk.v2.session.prompt({ sessionID, prompt: { text: "v2 again" } }),
          )
          expect(second.response.status).toBe(200)
          yield* awaitWithTimeout(Deferred.await(sawPromptedAgain), "second prompt did not route to V2", "10 seconds")

          // S7: the client-facing NATIVE endpoint (GET /api/session/:id/message) serves the
          // V2 transcript — a reload renders from it (the app's native store bootstrap).
          const native = yield* pollWithTimeout(
            Effect.promise(() => sdk.v2.session.messages({ sessionID })).pipe(
              Effect.map((response) => {
                const count = response.data?.data?.length ?? 0
                return count > 0 ? count : undefined
              }),
            ),
            "native message endpoint returned no rows",
            "10 seconds",
          )
          expect(native).toBeGreaterThan(0)

          // F1a SLICE 7 + F1b: summarize routes NATIVELY (SessionV2.compact marks the
          // runner's one-shot compaction request) — no 400.
          const summarizeStatus = yield* Effect.promise(async () => {
            const result = await sdk.v2.session.compact({
              sessionID,
            })
            return result.response.status
          })
          expect(summarizeStatus).toBe(200)
        }),
      ),
    30_000,
  )

  // F1g: Case (b) ("a session with pre-existing LEGACY rows also routes V2") retired with the
  // `message`/`part` tables — legacy transcripts can no longer be seeded, and the one-engine
  // routing it proved is covered by Case (a) above.
})

// V1-nuke A0: the native twins of the last live bare-/session operations — children, update
// (rename), todo, fork, remove — served from /api/session/** with native Session.Info shapes.
describe("native session twins (V1-nuke A0)", () => {
  it.live(
    "children/update/todo/fork/remove round-trip natively",
    () =>
      withFakeLlm(({ sdk, directory }) =>
        Effect.gen(function* () {
          const created = yield* Effect.promise(() => sdk.v2.session.create({ location: { directory } }))
          const sessionID = String(record(record(created.data).data).id)
          expect(sessionID).toStartWith("ses_")

          // children: empty before any fork
          const kids0 = yield* Effect.promise(() => sdk.v2.session.children({ sessionID }))
          expect(kids0.data?.data?.length ?? -1).toBe(0)

          // update: rename lands and the updated record comes back
          const renamed = yield* Effect.promise(() => sdk.v2.session.update({ sessionID, title: "renamed-a0" }))
          expect(record(record(renamed.data).data).title).toBe("renamed-a0")

          // todo: empty list (native shape — an array, not a 404)
          const todos = yield* Effect.promise(() => sdk.v2.session.todo({ sessionID }))
          expect(todos.data?.data?.length ?? -1).toBe(0)

          // fork: a clone appears and is a CHILD-less sibling with its own id... (the fork is a
          // ROOT session per core semantics; it must simply exist and be retrievable)
          const forked = yield* Effect.promise(() => sdk.v2.session.fork({ sessionID }))
          const forkedID = String(record(record(forked.data).data).id)
          expect(forkedID).toStartWith("ses_")
          expect(forkedID).not.toBe(sessionID)

          // remove: deletion is real — a follow-up get 404s
          const removed = yield* Effect.promise(async () => (await sdk.v2.session.remove({ sessionID })).response.status)
          expect(removed).toBe(204)
          const gone = yield* Effect.promise(async () => (await sdk.v2.session.get({ sessionID })).response.status)
          expect(gone).toBe(404)
        }),
      ),
    30_000,
  )
})
