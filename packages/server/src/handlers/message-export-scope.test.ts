// 🔴 **NC-SEC-017 — `session.exportMarkdown` was a general "create directories and replace one
// chosen `.md`" primitive over every path the NovaClaw account can write.**
//
// The typed payload took an unconstrained string documented as *"Absolute folder to write the .md
// into"*. The handler fetched the session and its transcript, reduced the FILENAME to a basename —
// which stops filename traversal and says nothing about the directory that owns the write — then
// `mkdir -p`'d the caller's path and called `writeFile`, which truncates. Nothing compared that path
// to the session's location, the instance home or temp.
//
// The standing filesystem law permits NovaClaw's own writes in exactly three places (instance home,
// OS temp, the session's working folder) and names drive roots, system locations and Documents as
// read-only, with no fourth location. On a headless or remote runtime the payload path is not even
// on the caller's machine.
//
// ⚠️ **This file drives the REAL registered handler through the REAL payload schema**, in the shape
// `session-create-features.test.ts` established, because the defect lived in the seam between the
// two: the schema said "absolute", the handler believed it, and each was individually consistent.
//
// ⚠️ **The store layers are built against `Database.layerFromPath(":memory:")`, never
// `Database.node`** — the global node resolves its path from `Flag.NOVACLAW_DB` at module load and
// `packages/server` has no test preload pinning it, so a node-based test would open the developer's
// real database. (Same reasoning as `config-remove.test.ts` in this directory.)

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Authorization } from "@novaclaw/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@novaclaw/protocol/middleware/schema-error"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { ProjectV2 } from "@novaclaw/core/project"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { FSUtil } from "@novaclaw/core/fs-util"
import { ProjectFileCache } from "@novaclaw/core/project-file-cache"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionV2 } from "@novaclaw/core/session"
import { SESSION_HANDLER_NODES } from "./session-nodes"
import { Api } from "../api"
import { LocationMiddleware } from "../location"
import { SessionLocationMiddleware } from "../middleware/session-location"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { MessageHandler } from "./message"

let ROOT = ""
let PROJECT = ""
let OUTSIDE = ""

beforeAll(async () => {
  ROOT = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nc-sec-017-")))
  PROJECT = path.join(ROOT, "project")
  OUTSIDE = path.join(ROOT, "outside")
  await fs.mkdir(PROJECT, { recursive: true })
  await fs.mkdir(OUTSIDE, { recursive: true })
})

afterAll(async () => {
  if (ROOT) await fs.rm(ROOT, { recursive: true, force: true })
})

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({ resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }) }),
)

const kernel = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    SessionProjector.node,
    SessionStore.node,
    ...SESSION_HANDLER_NODES,
    FSUtil.node,
    ProjectFileCache.node,
  ]),
  [
    [Database.node, Database.layerFromPath(":memory:")],
    [ProjectV2.node, projects],
    [SessionExecution.node, SessionExecution.noopLayer],
  ],
)

// Middleware is faked because this file makes no claim about transport — it makes a claim about the
// payload → handler → disk path — but it has to EXIST, because building a group layer runs
// `handlerToRoute`, which resolves every declared middleware out of the ambient context.
const middleware = Layer.mergeAll(
  Layer.succeed(
    LocationMiddleware,
    LocationMiddleware.of((effect) => effect as never),
  ),
  Layer.succeed(
    SessionLocationMiddleware,
    SessionLocationMiddleware.of((effect) => effect as never),
  ),
  Layer.succeed(
    WorkspaceRoutingMiddleware,
    WorkspaceRoutingMiddleware.of((effect) => effect as never),
  ),
  Layer.succeed(
    Authorization,
    Authorization.of((effect) => effect as never),
  ),
  Layer.succeed(
    SchemaErrorMiddleware,
    SchemaErrorMiddleware.of((effect) => effect as never),
  ),
)

const environment = Layer.mergeAll(middleware, kernel)

/**
 * The `session.exportMarkdown` endpoint as `packages/protocol` declares it — payload schema included.
 *
 * ⚠️ `endpoint.payload` is a Map keyed by content type, not a schema, and each entry holds an
 * `encoding` plus a `schemas` ARRAY. Reaching in is deliberate and guarded: if effect changes that
 * shape, this fails with a named message instead of silently testing nothing.
 */
const exportEndpoint = () => {
  const groups = Api.groups as unknown as Record<
    string,
    {
      readonly key: string
      readonly endpoints: Record<
        string,
        { readonly name: string; readonly payload?: Map<string, { readonly schemas?: readonly unknown[] }> }
      >
    }
  >
  const group = groups["server.message"]
  expect(group, "the api no longer declares a `server.message` group — re-aim this file").toBeDefined()
  const endpoint = Object.values(group!.endpoints).find((item) => item.name === "session.exportMarkdown")
  expect(endpoint, "`session.exportMarkdown` is no longer declared — re-aim this file").toBeDefined()
  const json = endpoint!.payload?.get("application/json")
  expect(json?.schemas?.[0], "`session.exportMarkdown` declares no application/json payload schema").toBeDefined()
  return { key: group!.key, payload: json!.schemas![0] as never }
}

/** Decode a JSON body exactly as the HTTP layer would. */
const decodePayload = (body: Record<string, unknown>) =>
  Schema.decodeUnknownSync(exportEndpoint().payload)(body) as Record<string, unknown>

type ExportHandler = (request: {
  readonly params: { readonly sessionID: string }
  readonly payload: unknown
}) => Effect.Effect<{ readonly path: string; readonly messageCount: number }, unknown, any>

/**
 * Create a session rooted at `PROJECT`, then run the REAL registered export handler against `body`
 * inside the SAME scope — the in-memory database lives in that scope.
 */
const exportWith = (body: Record<string, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { key } = exportEndpoint()
      const session = yield* SessionV2.Service
      const created = yield* session.create({
        location: { directory: PROJECT } as never,
        agent: "build" as never,
        title: "export me",
      })
      const context = yield* Layer.build(MessageHandler as unknown as Layer.Layer<never, never, never>)
      const built = context.mapUnsafe.get(key) as {
        readonly handlers: Map<string, { readonly handler: ExportHandler }>
      }
      const item = built.handlers.get("session.exportMarkdown")
      expect(
        item,
        'server.message registered no handler for "session.exportMarkdown" — the route would 404',
      ).toBeDefined()
      return yield* item!.handler({ params: { sessionID: created.id }, payload: decodePayload(body) }).pipe(
        Effect.map((ok) => ({ ok: true as const, ...ok })),
        Effect.catchCause((cause) => Effect.succeed({ ok: false as const, error: String(cause) })),
      )
    }).pipe(Effect.scoped, Effect.provide(environment)) as Effect.Effect<
      { ok: true; path: string } | { ok: false; error: string }
    >,
  )

const listing = (dir: string) => fs.readdir(dir).then((names) => names.sort())

describe("session.exportMarkdown writes inside the session's own project folder", () => {
  test("🔴 an absolute destination is refused and nothing is created outside the project", async () => {
    const before = await listing(OUTSIDE)
    const result = await exportWith({ directory: OUTSIDE })
    expect(result.ok, "an absolute server path was accepted as an export destination").toBe(false)
    expect(await listing(OUTSIDE)).toEqual(before)
  })

  test("🔴 a relative `..` destination is refused and nothing is created outside the project", async () => {
    const before = await listing(OUTSIDE)
    const result = await exportWith({ directory: path.join("..", "outside") })
    expect(result.ok).toBe(false)
    expect(await listing(OUTSIDE)).toEqual(before)
  })

  test("🔴 an existing file is never truncated — the export lands beside it", async () => {
    // The old handler called plain `writeFile`, which truncates: an export could destroy an
    // unrelated `.md` with no warning, no backup, no permission decision and no Trash entry.
    const notes = path.join(PROJECT, "keep.md")
    await fs.writeFile(notes, "PRECIOUS", "utf8")

    const first = await exportWith({ filename: "keep.md" })
    expect(first.ok).toBe(true)
    expect(await fs.readFile(notes, "utf8"), "the export replaced an existing file").toBe("PRECIOUS")
    if (!first.ok) throw new Error("unreachable")
    expect(path.basename(first.path)).toBe("keep (2).md")
    // …and the response names where the bytes ACTUALLY went, so nothing has to be guessed.
    expect(await fs.readFile(first.path, "utf8")).toContain("export me")
  })

  /**
   * ⚠️ **The negative half, and it is what separates a boundary from a wall.** Every assertion above
   * is satisfied by a handler that refuses everything.
   */
  test("an ordinary relative export, and an omitted destination, both succeed inside the project", async () => {
    const nested = await exportWith({ directory: path.join("exports", "chats"), filename: "nested" })
    expect(nested.ok, "a legitimate project-relative export was refused").toBe(true)
    if (!nested.ok) throw new Error("unreachable")
    expect(FSUtil.containsCanonical(PROJECT, nested.path)).toBe(true)
    expect(path.basename(nested.path)).toBe("nested.md")
    expect(await fs.readFile(nested.path, "utf8")).toContain("export me")

    const rooted = await exportWith({ filename: "at-the-root" })
    expect(rooted.ok, "an export with no destination was refused").toBe(true)
    if (!rooted.ok) throw new Error("unreachable")
    expect(path.dirname(rooted.path)).toBe(PROJECT)
  })
})
