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
import { SessionV1 } from "@novaclaw/core/v1/session"
import { Deferred, Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { HttpServer } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { FSUtil } from "@novaclaw/core/fs-util"
import { CrossSpawnSpawner } from "@novaclaw/core/cross-spawn-spawner"
import { createNovaclawClient } from "@novaclaw/sdk/v2"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { Session as SessionNs } from "@/session/session"
import { TestLLMServer } from "../lib/llm-server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { ProviderV2 } from "@novaclaw/core/provider"
import { ModelV2 } from "@novaclaw/core/model"
import { Database } from "@novaclaw/core/database/database"
import { MessageTable } from "@novaclaw/core/session/sql"
import { eq } from "drizzle-orm"
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

// Count legacy v1 `message` rows DIRECTLY (drizzle over MessageTable). Since the
// F0 history merge, MessageV2.page also returns projected `session_message` rows,
// so it can no longer serve as the legacy-row probe — the routing gate itself
// moved to MessageV2.hasLegacyRows for the same reason.
// store.provide discharges the instance-scoped Database requirement.
function legacyMessageCount(directory: string, sessionID: string) {
  return InstanceStore.Service.use((store) =>
    store.provide(
      { directory },
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const rows = yield* db
          .select({ id: MessageTable.id })
          .from(MessageTable)
          .where(eq(MessageTable.session_id, SessionID.make(sessionID)))
          .all()
        return rows.length
      }).pipe(Effect.orElseSucceed(() => 0)),
    ),
  )
}

// S7: the legacy WithParts page serves V1 Message/Part rows ONLY — the F0-era merge of
// projected V2-native rows retired with the V1 render vocab. A V2-native session's transcript
// is fetched from the native `GET /api/session/{id}/message` instead.
function pagedMessageCount(directory: string, sessionID: string) {
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

          // A SECOND prompt on the (now row-bearing) V2 session runs V2 too —
          // V2 writes only session_message, never legacy rows.
          const second = yield* Effect.promise(() =>
            sdk.session.promptAsync({
              sessionID,
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "v2 again" }],
            }),
          )
          expect(second.response.status).toBe(204)
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
          // ...while the LEGACY WithParts page stays EMPTY for a native session (S7 dropped
          // the F0-era read-side merge) and the legacy table stays empty too.
          expect(yield* pagedMessageCount(directory, sessionID)).toBe(0)
          expect(yield* legacyMessageCount(directory, sessionID)).toBe(0)

          // F1a SLICE 7 + F1b: summarize routes NATIVELY (SessionV2.compact marks the
          // runner's one-shot compaction request) — no 400, and no legacy rows ever.
          const summarizeStatus = yield* Effect.promise(async () => {
            const result = await sdk.session.summarize({
              sessionID,
              providerID: "test",
              modelID: "test-model",
            })
            return result.response.status
          })
          expect(summarizeStatus).toBe(200)
          expect(yield* legacyMessageCount(directory, sessionID)).toBe(0)
        }),
      ),
    30_000,
  )

  // Case (b): a session that already has LEGACY rows (a pre-F0 transcript) also
  // routes V2 — the eligibility gate is gone. The V2 turn writes ONLY
  // session_message: the legacy count stays at the seed, and the native
  // endpoint serves the new turn.
  it.live("session with a pre-existing legacy message routes to V2 too", () =>
    withFakeLlm(({ sdk, directory, llm }) =>
      Effect.gen(function* () {
        yield* llm.text("native hello back", { usage: { input: 5, output: 3 } })

        const session = yield* Effect.promise(() =>
          sdk.session.create({
            title: "legacy seeds route V2",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        )
        const sessionID = String(record(session.data).id)
        yield* seedLegacyMessage(directory, sessionID)
        expect(yield* legacyMessageCount(directory, sessionID)).toBe(1)

        const prompt = yield* Effect.promise(() =>
          sdk.session.promptAsync({
            sessionID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "run native" }],
          }),
        )
        expect(prompt.response.status).toBe(204)

        // The turn lands in session_message (native endpoint gains rows)...
        const native = yield* pollWithTimeout(
          Effect.promise(() => sdk.v2.session.messages({ sessionID })).pipe(
            Effect.map((response) => {
              const count = response.data?.data?.length ?? 0
              return count > 0 ? count : undefined
            }),
          ),
          "native message endpoint returned no rows for the legacy-seeded session",
          "15 seconds",
        )
        expect(native).toBeGreaterThan(0)
        // ...and the legacy table NEVER grows past the seed (no V1 writes remain).
        expect(yield* legacyMessageCount(directory, sessionID)).toBe(1)
      }),
    ),
  )
})
