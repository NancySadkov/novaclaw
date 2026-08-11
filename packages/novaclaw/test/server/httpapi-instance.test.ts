import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Flag } from "@novaclaw/core/flag/flag"
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
