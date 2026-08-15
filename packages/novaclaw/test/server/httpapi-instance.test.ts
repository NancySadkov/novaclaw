import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Flag } from "@novaclaw/core/flag/flag"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { describe, expect } from "bun:test"
import { Config, Context, Effect, FileSystem, Layer, Path } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { WorkspaceV2 } from "@novaclaw/core/workspace"
import { ControlPaths } from "../../src/server/routes/instance/httpapi/groups/control"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { TelemetryPaths } from "@novaclaw/protocol/groups/telemetry"
import { QuestionID } from "../../src/question/schema"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { HEADER as FenceHeader } from "../../src/server/shared/fence"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Flip the experimental workspaces flag so EventV2.run actually writes to
// EventSequenceTable (the source of truth the fence middleware reads). Reset
// the database around the test so per-instance state does not leak between
// runs. resetDatabase() already calls disposeAllInstances(), so we don't
// repeat it.
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const originalWorkspaces = Flag.NOVACLAW_EXPERIMENTAL_WORKSPACES
    Flag.NOVACLAW_EXPERIMENTAL_WORKSPACES = true
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        Flag.NOVACLAW_EXPERIMENTAL_WORKSPACES = originalWorkspaces
        await resetDatabase()
      }),
    )
  }),
)

// Mount the production HttpApi route tree on a real Node HTTP server bound to
// 127.0.0.1:0 and a fetch-based HttpClient that prepends the server URL. This
// keeps the test wired directly through the same route layer production uses.
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const httpApiServerLayer = servedRoutes.pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

const it = testEffect(Layer.mergeAll(testStateLayer, httpApiServerLayer))
const handlerContext = Context.empty() as Context.Context<unknown>

const directoryHeader = (dir: string) => HttpClientRequest.setHeader("x-novaclaw-directory", dir)

describe("instance HttpApi", () => {
  it.live("observes optional capabilities without starting them and rejects unknown retries", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const list = yield* HttpClient.get(`/api/capability?directory=${encodeURIComponent(dir)}`)

      expect(list.status).toBe(200)
      expect(yield* list.json).toEqual(
        expect.arrayContaining([
          { name: "local-model", status: { state: "idle" } },
          { name: "memory", status: { state: "idle" } },
          { name: "messenger-login", status: { state: "idle" } },
          expect.objectContaining({ name: "calendar-scheduler" }),
          expect.objectContaining({ name: "messenger" }),
        ]),
      )

      const accounts = yield* HttpClient.get("/api/messenger/account")
      expect(accounts.status).toBe(200)
      expect(yield* accounts.json).toEqual([])

      const retry = yield* HttpClientRequest.post(
        `/api/capability/not-declared/retry?directory=${encodeURIComponent(dir)}`,
      ).pipe(HttpClient.execute)
      expect(retry.status).toBe(400)
      expect(yield* retry.json).toMatchObject({ message: "Unknown capability: not-declared" })
    }),
  )

  it.live("🔴 health reports the VERIFIABLE identity, not just the claimable one", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/global/health")
      expect(response.status).toBe(200)
      const body = (yield* response.json) as { instanceID: string; networkID: string }

      // `instanceID` is a random ULID: it recognises one install across mDNS name, LAN IP and
      // tunnel, and a stranger can claim the same string. `networkID` is the public key, which is
      // the half a peer can actually verify and the string a user shares to be added as a contact.
      expect(body.instanceID).toStartWith("ins_")
      expect(body.networkID).toStartWith("nid_")

      // ⚠️ Asserted over the WIRE, not the handler's return: a field missing from the response
      // schema is dropped silently however correct the handler is.
      expect(InstanceIdentityStore.parseNetworkID(body.networkID)).toHaveLength(32)

      // And the SECRET never crosses this wire, in any encoding.
      const raw = JSON.stringify(body)
      expect(raw).not.toContain("secret")
      expect(raw.length).toBeLessThan(500)
    }),
  )

  it.live("🔴 the identity backup carries the secret, and only this endpoint does", () =>
    Effect.gen(function* () {
      const health = (yield* (yield* HttpClient.get("/global/health")).json) as { networkID: string }
      const response = yield* HttpClientRequest.post("/api/identity/backup").pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const backup = (yield* response.json) as { version: number; networkID: string; secretKey: string }

      // It must be the SAME instance, or a restore would install a different peer than the one the
      // user thought they were backing up.
      expect(backup.networkID).toBe(health.networkID)
      expect(backup.version).toBe(1)

      // The secret is a real 32-byte key — the point of the whole endpoint. A backup that carried
      // only public material would restore an instance that cannot sign, and the failure would not
      // surface until the day it was needed.
      expect(Buffer.from(backup.secretKey, "base64url")).toHaveLength(32)

      // ⚠️ And the ordinary, frequently-polled endpoint still leaks nothing: a secret that also
      // appeared on /global/health would be handed to every client that ever checked liveness.
      const raw = JSON.stringify(yield* (yield* HttpClient.get("/global/health")).json)
      expect(raw).not.toContain(backup.secretKey)
    }),
  )

  it.live("🔴 the community surface answers — a missing node compiles green and 500s", () =>
    Effect.gen(function* () {
      // This is the failure mode the group could not be trusted to avoid on types alone: the API
      // composes, the handler typechecks, and every call returns 500 because the services were never
      // put in the instance-global graph.
      const empty = yield* HttpClient.get("/api/community/contact")
      expect(empty.status).toBe(200)
      expect(yield* empty.json).toEqual([])

      // A contact whose id is not a public key is refused by the STORE's rule, surfaced as a 400
      // rather than re-decided in the handler.
      const bogus = yield* HttpClientRequest.post("/api/community/contact").pipe(
        HttpClientRequest.bodyJson({ networkID: "alice" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(bogus.status).toBe(400)

      const peer = `nid_${Buffer.alloc(32, 4).toString("base64url")}`
      const added = yield* HttpClientRequest.post("/api/community/contact").pipe(
        HttpClientRequest.bodyJson({ networkID: peer, petname: "spark", routes: ["/ip4/10.0.0.1/udp/1/quic-v1"] }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(added.status).toBe(200)
      expect(yield* added.json).toMatchObject({ networkID: peer, petname: "spark", blocked: false })

      // Channels: joining is subscribing to a hashed name nobody owns, and history is empty until a
      // transport delivers something — which is honest, not broken.
      const joined = yield* HttpClientRequest.post("/api/community/channel").pipe(
        HttpClientRequest.bodyJson({ name: "#NovaClaw" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(joined.status).toBe(200)
      expect(yield* joined.json).toEqual([{ name: "#NovaClaw", muted: false }])

      const history = yield* HttpClient.get(`/api/community/channel/${encodeURIComponent("#NovaClaw")}/history`)
      expect(history.status).toBe(200)
      expect(yield* history.json).toEqual([])

      // The transport reports OFF with a REASON, so the screen can say something true rather than
      // "disconnected" — which would read as broken on every fresh install. `no-peers`, not `none`:
      // the transport is real now, this instance simply knows nobody with an address to dial.
      const transport = yield* HttpClient.get("/api/community/transport")
      expect(transport.status).toBe(200)
      expect(yield* transport.json).toEqual({ kind: "off", reason: "no-peers" })

      /**
       * 🔴 The P2P door, and the one route here with NO auth — checked from the same surface as
       * everything else precisely because "unauthenticated" is a claim that has to keep being true.
       * A forged message is answered exactly like a good one and stored like neither.
       */
      const inbound = yield* HttpClientRequest.post("/api/community/inbound").pipe(
        HttpClientRequest.bodyJson({
          topic: "not-a-real-topic",
          message: { channel: "#NovaClaw", author: "nid_forged", at: 1, body: "hi", signature: "AAAA", nonce: 0 },
        }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(inbound.status).toBe(200)
      // Uniform: reporting the verdict would tell a stranger they are blocked, or let them map our
      // channels by probing topics.
      expect(yield* inbound.json).toEqual({ received: true })

      const afterForgery = yield* HttpClient.get(`/api/community/channel/${encodeURIComponent("#NovaClaw")}/history`)
      expect(yield* afterForgery.json).toEqual([])
    }),
  )

  it.live("🔴 the community tool is REGISTERED, not merely written", () =>
    Effect.gen(function* () {
      // A tool can compile, be listed in builtins, and still never reach an agent if its node fails
      // to construct — the same class as an HttpApi group whose services are missing. Registration
      // is the only thing that proves the dependency graph actually resolved.
      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* HttpClient.get(`/experimental/tool/ids?directory=${encodeURIComponent(dir)}`)
      expect(response.status).toBe(200)
      const ids = (yield* response.json) as string[]
      expect(ids).toContain("community")
    }),
    // ⚠️ An EXPLICIT limit, because this endpoint materialises the WHOLE tool catalogue — every
    // tool's location node is constructed to answer it — which costs 5-8 s here, either side of
    // bun's 5 s default. Measured: it times out at the default and passes in 7.8 s with room.
    // Declaring the real cost is honest; leaving it to flip with machine load is not, and raising a
    // limit to hide a REGRESSION would be different again — nothing here changed in cost, the test
    // was simply written without checking what it was asking for.
    30_000,
  )

  it.live("serves the OpenAPI document", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/doc")

      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toContain("application/json")
      expect(yield* response.json).toMatchObject({
        openapi: expect.any(String),
        info: expect.any(Object),
        paths: expect.objectContaining({
          "/global/health": expect.any(Object),
          "/api/session": expect.any(Object),
        }),
      })
    }),
  )

  it.live("emits a sync fence header for fixed-workspace mutations", () =>
    Effect.gen(function* () {
      const originalWorkspaceID = Flag.NOVACLAW_WORKSPACE_ID
      Flag.NOVACLAW_WORKSPACE_ID = WorkspaceV2.ID.ascending()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Flag.NOVACLAW_WORKSPACE_ID = originalWorkspaceID
        }),
      )

      const dir = yield* tmpdirScoped({ git: true })
      // 🔴 **The route must WRITE AN EVENT, not merely mutate.** This test used `POST /app` under the
      // note "any mutating instance route carries the fence header — app registration is the
      // simplest", and that premise is false: `middleware/fence.ts` emits the header only when
      // `Fence.diff` over `EventSequenceTable` is non-empty, so a mutation that advances no aggregate
      // sequence carries nothing. App registration is exactly such a mutation.
      //
      // ⚠️ Two defects were stacked here, and the first hid the second for the whole life of the pin:
      // the body was `{id, title}` while `AppRegisterPayload` requires `open`, so the request 400'd and
      // the fence assertion was never reached. Fixing the payload got a 200 and *then* showed the
      // header was absent. A route that 400s cannot tell you anything about the behaviour under test.
      //
      // Session creation is the natural subject: it publishes `session.created`, and `/api/session` is
      // served by this same router (the OpenAPI test above asserts it is in `paths`).
      const response = yield* HttpClientRequest.post("/api/session").pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ location: { directory: dir } }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(response.status).toBe(200)
      expect(JSON.parse(response.headers[FenceHeader] ?? "{}")).not.toEqual({})
    }),
  )

  it.live("does not emit sync fence headers for fixed-workspace reads or no-op mutations", () =>
    Effect.gen(function* () {
      const originalWorkspaceID = Flag.NOVACLAW_WORKSPACE_ID
      Flag.NOVACLAW_WORKSPACE_ID = WorkspaceV2.ID.ascending()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Flag.NOVACLAW_WORKSPACE_ID = originalWorkspaceID
        }),
      )

      const dir = yield* tmpdirScoped({ git: true })
      const read = yield* HttpClientRequest.get(InstancePaths.path).pipe(directoryHeader(dir), HttpClient.execute)
      const log = yield* HttpClientRequest.post(ControlPaths.log).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ service: "fence-test", level: "info", message: "noop" }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(read.status).toBe(200)
      expect(read.headers[FenceHeader]).toBeUndefined()
      expect(log.status).toBe(200)
      expect(log.headers[FenceHeader]).toBeUndefined()
    }),
  )

  // The V1 `/permission/:requestID/reply` legs of this test and the next one went with the V1
  // permission ROUTES (v0.2.0-prep Wave 4 §5) — those routes served the V1 engine's asks only, and
  // the V1 engine is gone. The equivalent V2 guarantees are asserted on the native route in
  // `packages/server`'s handler tests + `httpapi-public-openapi.test.ts`; what is left here is the
  // question surface, which is still legacy.
  it.live("rejects malformed question request ids", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const request = (path: string, init?: RequestInit) =>
        Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${path}`, {
              ...init,
              headers: { "x-novaclaw-directory": dir, "content-type": "application/json", ...init?.headers },
            }),
            handlerContext,
          ),
        )
      const [questionReply, questionReject] = yield* Effect.all(
        [
          request("/question/invalid-question-id/reply", {
            method: "POST",
            body: JSON.stringify({ answers: [["Yes"]] }),
          }),
          request("/question/invalid-question-id/reject", { method: "POST" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(questionReply.status).toBe(400)
      expect(questionReject.status).toBe(400)
    }),
  )

  it.live("returns typed not found bodies for missing question requests", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const request = (path: string, init?: RequestInit) =>
        Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${path}`, {
              ...init,
              headers: { "x-novaclaw-directory": dir, "content-type": "application/json", ...init?.headers },
            }),
            handlerContext,
          ),
        )
      const questionReplyID = QuestionID.ascending()
      const questionRejectID = QuestionID.ascending()
      const [questionReply, questionReject] = yield* Effect.all(
        [
          request(`/question/${questionReplyID}/reply`, {
            method: "POST",
            body: JSON.stringify({ answers: [["Yes"]] }),
          }),
          request(`/question/${questionRejectID}/reject`, { method: "POST" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(questionReply.status).toBe(404)
      expect(yield* Effect.promise(() => questionReply.json())).toEqual({
        _tag: "QuestionNotFoundError",
        requestID: questionReplyID,
        message: `Question request not found: ${questionReplyID}`,
      })
      expect(questionReject.status).toBe(404)
      expect(yield* Effect.promise(() => questionReject.json())).toEqual({
        _tag: "QuestionNotFoundError",
        requestID: questionRejectID,
        message: `Question request not found: ${questionRejectID}`,
      })
    }),
  )

  // `returns typed not found bodies for missing projects` lived here until 2026-08-06. It PATCHed
  // `/project/{id}` — a route the T2/T3 project-entity kill removed — so it got the router's generic
  // 404 with an EMPTY body and died in `.json()`. ⚠️ Its `expect(status).toBe(404)` passed the whole
  // time, for the wrong reason: a missing route and a typed not-found are the same status code.
  // `ProjectNotFoundError` went with it — the test was the last reference to a class no endpoint
  // could produce.

  it.live("serves path and VCS read endpoints", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(path.join(dir, "changed.txt"), "hello")

      const [paths, vcs, diff] = yield* Effect.all(
        [
          HttpClientRequest.get(InstancePaths.path).pipe(directoryHeader(dir), HttpClient.execute),
          HttpClientRequest.get(InstancePaths.vcs).pipe(directoryHeader(dir), HttpClient.execute),
          HttpClientRequest.get(InstancePaths.vcsDiff).pipe(
            HttpClientRequest.setUrlParam("mode", "git"),
            directoryHeader(dir),
            HttpClient.execute,
          ),
        ],
        { concurrency: "unbounded" },
      )

      expect(paths.status).toBe(200)
      expect(yield* paths.json).toMatchObject({ directory: dir, worktree: dir })

      expect(vcs.status).toBe(200)
      expect(yield* vcs.json).toMatchObject({ branch: expect.any(String) })

      expect(diff.status).toBe(200)
      expect(yield* diff.json).toContainEqual(
        expect.objectContaining({ file: "changed.txt", additions: 1, status: "added" }),
      )
    }),
  )

  it.live("serves ordinary-user crash-reporting status from the sender's own preview path", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* HttpClientRequest.get(TelemetryPaths.status).pipe(
        directoryHeader(dir),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      const body = (yield* response.json) as {
        gate: { consent: boolean; airgap: boolean }
        endpointConfigured: boolean
        refusals: string[]
        payloadPreview?: { signature: Record<string, unknown>; attributes: Record<string, unknown> }
        disclosure: Array<{ field: string; meaning: string; condition: string }>
      }
      expect(body.gate).toEqual({ consent: true, airgap: false })
      expect(body.endpointConfigured).toBe(false)
      expect(body.refusals).toEqual(["no_endpoint"])
      expect(body.payloadPreview?.signature).toMatchObject({
        plane: "server",
        kind: "TelemetryPreview",
        uptime: 0,
      })
      expect(body.payloadPreview?.attributes).toEqual({})
      expect(body.disclosure.length).toBeGreaterThanOrEqual(10)
      expect(body.disclosure.every((row) => row.meaning.length > 0 && row.condition.length > 0)).toBe(true)
    }),
  )

  /**
   * Nova Health. The composition is unit-tested in core; what only a LIVE request can show is that
   * the readings survive the wire — every row is gathered from a real service against a real
   * database, and the schema accepts what the handler actually produces.
   */
  it.live("diagnoses the instance without contacting anything outside it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* HttpClientRequest.get(InstancePaths.diagnosis).pipe(
        directoryHeader(dir),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)

      const body = (yield* response.json) as {
        overall: string
        headline: string
        signals: { id: string; label: string; status: string; detail?: string; action?: string }[]
      }

      // The four readings always available at instance scope. A provider row joins them only when a
      // default model names one, so this asserts the four are PRESENT rather than pinning the exact
      // set — pinning it would fail the moment a fixture configures a model, for no real reason.
      for (const id of ["database", "scheduler", "storage", "updates"]) {
        expect(body.signals.map((signal) => signal.id), `missing the ${id} row`).toContain(id)
      }

      // ⚠️ Opening the board must not contact anyone. Reachability is the ONE reading that costs
      // egress, so without ?probe=provider a provider row may exist but must never carry a probed
      // verdict — a health screen that phones out because someone glanced at it is not local-first.
      for (const signal of body.signals.filter((row) => row.id.startsWith("provider:"))) {
        expect(signal.status, "a provider row was PROBED on plain open").not.toBe("ok")
      }

      // ⚠️ THE rule this endpoint exists to keep: `unknown` is never dressed as healthy. The updater
      // flag lives in the desktop main process, so a served board genuinely cannot read it — and the
      // verdict must carry that ignorance upward rather than quietly answering "ok".
      const updates = body.signals.find((signal) => signal.id === "updates")!
      expect(updates.status).toBe("unknown")
      expect(body.overall).not.toBe("ok")
      expect(body.headline).not.toMatch(/all good|healthy/i)

      // Every non-ok row is actionable or explains itself; none is a bare status a person cannot use.
      for (const signal of body.signals) {
        if (signal.status === "ok") continue
        expect(signal.detail ?? signal.action, `${signal.id} says nothing a person can act on`).toBeTruthy()
      }
    }),
  )

})
