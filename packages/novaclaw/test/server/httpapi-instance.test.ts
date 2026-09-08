import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Flag } from "@novaclaw/core/flag/flag"
import { CommunityReconcile } from "@novaclaw/core/community/reconcile"
import { CommunityTopic } from "@novaclaw/core/community/topic"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { describe, expect } from "bun:test"
import { Config, Context, Effect, FileSystem, Layer, Path } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { WorkspaceV2 } from "@novaclaw/core/workspace"
import { ControlPaths } from "../../src/server/routes/instance/httpapi/groups/control"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { TelemetryPaths } from "@novaclaw/protocol/groups/telemetry"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { HEADER as FenceHeader } from "../../src/server/shared/fence"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Reset the database around the test so per-instance state does not leak between runs.
// resetDatabase() already calls disposeAllInstances(), so we don't repeat it.
//
// ⚠️ This used to also set `Flag.NOVACLAW_EXPERIMENTAL_WORKSPACES = true`, under a comment saying it
// made `EventV2.run` write to `EventSequenceTable`. Both halves were false: that `Flag` entry had no
// reader anywhere in the tree (the live gate is `RuntimeFlags.experimentalWorkspaces`), and
// `EventV2` has no workspaces gate at all — `core/src/event.ts` writes the sequence row
// unconditionally. Removing it changes nothing this file asserts, which is the point.
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
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

  /**
   * 🔴 **The disclosure surface for third-party code, exercised against the real mounted API.**
   *
   * `Plugin.capabilities` was added so a person can be told what the code inside their instance says
   * it needs (12(d)). Until this route existed the declaration reached exactly one place — a log
   * line — and a declaration nobody can read is worth what an undeclared one is.
   *
   * ⚠️ It is DISCLOSURE, never enforcement: principle 13 is explicit that the plugin contract is not
   * a gate, since `import()` runs module scope before anything is validated. What this asserts is
   * that the claim survives the trip, not that anything is constrained by it.
   */
  it.live("lists loaded plugins with what each DECLARED", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const list = yield* HttpClient.get(`/api/plugin?directory=${encodeURIComponent(dir)}`)
      expect(list.status).toBe(200)

      const body = (yield* list.json) as ReadonlyArray<{
        id: string
        source: string
        capabilities?: readonly string[]
      }>
      // Non-vacuity: an empty list would make every assertion below pass forever, and this instance
      // demonstrably loads its built-ins.
      expect(body.length).toBeGreaterThan(5)

      // The declarations the core checker derives from source must be the ones served here — this is
      // the join between the two halves, and a join is exactly what nothing tests by accident.
      const byId = new Map(body.map((item) => [item.id, item]))
      expect(byId.get("config-skill")?.capabilities?.slice().sort()).toEqual([
        "config",
        "global",
        "location",
        "skillConfigStore",
      ])
      expect(byId.get("agent")?.capabilities).toEqual(["location"])
      // A plugin that genuinely needs nothing declares an EMPTY set, and that must not arrive as
      // `undefined` — "declared nothing" is a different statement and the surface renders it apart.
      expect(byId.get("variant")?.capabilities).toEqual([])

      // Every built-in is marked as such; `external` is reserved for code the config dir contributed.
      expect(body.every((item) => item.source === "internal")).toBe(true)
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

  it.live("serves the launcher pressure summary without the recursive usage payload", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/api/instance/pressure")
      expect(response.status).toBe(200)
      const body = (yield* response.json) as Record<string, unknown>
      expect(body).toEqual(
        expect.objectContaining({
          measuredAt: expect.any(Number),
          memory: expect.any(Object),
          level: expect.any(String),
          memoryLevel: expect.any(String),
        }),
      )
      expect(body.disk).toBeUndefined()
      expect(body.ram).toBeUndefined()
      expect(body.localModel).toBeUndefined()
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

  it.live("🔴 restore REFUSES without replace, and never echoes the secret back", () =>
    Effect.gen(function* () {
      const backup = (yield* (yield* HttpClientRequest.post("/api/identity/backup").pipe(HttpClient.execute)).json) as {
        version: number
        id: string
        networkID: string
        secretKey: string
      }

      /**
       * 🔴 The refusal IS the safety property. Restoring over an existing identity orphans every
       * contact and channel that knows this peer, and from outside it is indistinguishable from the
       * instance being taken over — so a caller that forgets the flag must be stopped, not helped.
       * A handler that defaulted `replace` to true would pass every other test in this file.
       */
      const refused = yield* HttpClientRequest.post("/api/identity/restore").pipe(
        HttpClientRequest.bodyJson({ backup }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(refused.status).toBe(400)
      expect(JSON.stringify(yield* refused.json)).toContain("confirmed explicitly")

      const accepted = yield* HttpClientRequest.post("/api/identity/restore").pipe(
        HttpClientRequest.bodyJson({ backup, replace: true }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(accepted.status).toBe(200)
      const body = yield* accepted.json

      // Same instance it started as: this restores the backup taken moments ago, so a DIFFERENT
      // networkID here would mean the endpoint installed something other than what it was handed.
      expect((body as { networkID: string }).networkID).toBe(backup.networkID)

      /**
       * ⚠️ Public halves ONLY. The secret goes IN; nothing about it comes back out. An endpoint that
       * echoed it would put the key in every proxy log and browser history that saw the response —
       * the exact reason backup is a POST rather than a GET, undone on the way home.
       */
      expect(JSON.stringify(body)).not.toContain(backup.secretKey)
      expect(JSON.stringify(body)).not.toContain("secret")
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
      // ⚠️ `listed: true` for the default channel and nothing else: every instance is in it, so
      // admitting it discloses nothing anyone did not assume.
      expect(yield* joined.json).toEqual([{ name: "#NovaClaw", muted: false, listed: true }])

      /**
       * 🔴 Being in a room is not public. Checked from the SAME surface a stranger would use, because
       * that is the only place the difference between "what we are in" and "what we admit to" is
       * visible — and the sync endpoints already refuse to leak it, so this door must not either.
       */
      const privateRoom = yield* HttpClientRequest.post("/api/community/channel").pipe(
        HttpClientRequest.bodyJson({ name: "#a-private-room" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(((yield* privateRoom.json) as { name: string }[]).map((entry) => entry.name)).toContain("#a-private-room")
      /**
       * 🔴 The peer door is SHUT until this instance has joined the community, so the check below
       * has to open it first — and asserting the closed state is the more valuable half.
       *
       * A fresh install serves strangers nothing: participation costs the user unmoderated content
       * and an IP address revealed to whoever they talk to, so it waits for them to accept that.
       * The owner's own screens above are unaffected, which is the distinction the gate exists to
       * make.
       */
      const beforeJoining = yield* HttpClient.get("/api/community/listed")
      expect(beforeJoining.status).toBe(503)

      const accepted = yield* HttpClientRequest.patch("/config").pipe(
        HttpClientRequest.bodyJson({ community: { consented: true } }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(accepted.status).toBe(200)

      const advertised = yield* HttpClient.get("/api/community/listed")
      expect(advertised.status).toBe(200)
      expect(yield* advertised.json).toEqual({ channels: ["#NovaClaw"] })

      const history = yield* HttpClient.get(`/api/community/channel/${encodeURIComponent("#NovaClaw")}/history`)
      expect(history.status).toBe(200)
      /**
       * ⚠️ `{messages, hidden, held}`, not a bare array, and asserted EXACTLY on purpose — this is a
       * contract test, and it earned that this session by catching `held` being added to the wire.
       *
       * `hidden` is what the reader's own filters removed, so a room that looks quiet because of a
       * forgotten rule is distinguishable from one nobody posts in. `held` is how many the room
       * stores: `messages` is ONE PAGE of at most 200, and retention keeps far more, so a caller
       * that reads the page as the whole log under-reports a busy room.
       */
      expect(yield* history.json).toEqual({ messages: [], hidden: 0, held: 0 })

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
      expect(yield* afterForgery.json).toEqual({ messages: [], hidden: 0, held: 0 })

      /**
       * 🔴 Reconciliation must not let a stranger MAP which rooms this instance is in.
       *
       * A joined-but-empty channel and a topic we never joined have to look identical, and the first
       * implementation failed exactly here — an unknown topic answered with a zero-length bucket list
       * while a real room answered with 64 empty digests, which a prober can tell apart at a glance.
       * A comment asserted they were indistinguishable; only probing the running server showed they
       * were not, so it is pinned from the outside where the difference was visible.
       */
      const summaryFor = (topic: string) =>
        HttpClientRequest.post("/api/community/sync/summary").pipe(
          HttpClientRequest.bodyJson({ topic }),
          Effect.flatMap(HttpClient.execute),
          Effect.flatMap((response) => response.json),
        )
      const joinedTopic = yield* summaryFor(CommunityTopic.topicOf("#NovaClaw"))
      const strangerTopic = yield* summaryFor(CommunityTopic.topicOf("#a-room-this-instance-never-joined"))
      expect(joinedTopic).toEqual(strangerTopic)
      expect((joinedTopic as { buckets: string[] }).buckets).toHaveLength(CommunityReconcile.BUCKETS)
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
        HttpClientRequest.bodyJson({ agent: "build", location: { directory: dir } }),
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

  it.live("serves path and VCS read endpoints", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(path.join(dir, "changed.txt"), "hello")

      const [paths, vcs, diff] = yield* Effect.all(
        [
          HttpClientRequest.get(InstancePaths.path).pipe(directoryHeader(dir), HttpClient.execute),
          // The contract routes, not `InstancePaths`: the VCS family moved to `/api/vcs*` on
          // 2026-09-03 and the five legacy paths went with it. Same header, same handler behaviour,
          // one envelope more — which is what the `.data` reads below check.
          HttpClientRequest.get("/api/vcs").pipe(directoryHeader(dir), HttpClient.execute),
          HttpClientRequest.get("/api/vcs/diff").pipe(
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
      expect(yield* vcs.json).toMatchObject({ data: { branch: expect.any(String) } })

      expect(diff.status).toBe(200)
      expect((yield* diff.json) as { data: unknown[] }).toMatchObject({
        data: expect.arrayContaining([expect.objectContaining({ file: "changed.txt", additions: 1, status: "added" })]),
      })
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
      expect(body.endpointConfigured).toBe(true)
      expect(body.refusals).toEqual([])
      expect(body.payloadPreview?.signature).toMatchObject({
        plane: "server",
        kind: "TelemetryPreview",
        uptime: 0,
      })
      expect(body.payloadPreview?.attributes).toEqual({})
      expect(body.disclosure.length).toBeGreaterThanOrEqual(10)
      expect(body.disclosure.every((row) => row.meaning.length > 0 && row.condition.length > 0)).toBe(true)
      const disabled = yield* HttpClientRequest.patch("/config").pipe(
        HttpClientRequest.bodyJson({ telemetry: { enabled: false } }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(disabled.status).toBe(200)
      const status = yield* HttpClient.get(TelemetryPaths.status)
      expect(yield* status.json).toMatchObject({
        gate: { consent: false, airgap: false },
        endpointConfigured: true,
        refusals: ["consent_off"],
      })
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
        expect(
          body.signals.map((signal) => signal.id),
          `missing the ${id} row`,
        ).toContain(id)
      }

      // 🔴 The config-document row rides the wire too. It is `ok` here because this fixture has
      // no unreadable file — what matters is that the row EXISTS, since a reading that only appears
      // when it has bad news is a reading nobody can tell apart from one that stopped running.
      const configRow = body.signals.find((signal) => signal.id === "config-document")
      expect(configRow, "the config-document row is missing from a live diagnosis").toBeDefined()
      expect(configRow!.status).toBe("ok")

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
