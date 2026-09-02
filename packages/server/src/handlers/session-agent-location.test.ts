// WHERE A COLLEAGUE'S NEW CHAT LANDS — the join from an agent's configured folder to the session row.
//
// 🔴 The rule (owner, 2026-08-21): *"the folder an agent works on is now part of its configuration,
// defaulting to that agent's scratch"*. So `session.create` with NO location must file the chat in
// the colleague's own project — and the prompt area never has to ask which folder.
//
// **This chain was built, reviewed and never OBSERVED.** Three modules have to agree for it to
// work — the payload's optional `location`, the handler's `?? agentLocation(...)` fallback, and
// `AgentWorkspace.folderFor` — and each of the three has its own unit test that passes while the
// JOIN is broken. `agent-workspace.test.ts` proves `folderFor` picks the right string; nothing
// proved that string reaches a session row.
//
// ⚠️ **THE PAIR IS THE PROOF, not either half of it.** A handler that ignored the roster entirely
// and always answered "the request's directory" passes a single positive case as easily as the
// correct one does; so does a handler that always answers the scratch path. Every claim below is
// therefore stated over TWO colleagues that must land in DIFFERENT folders, neither of them the
// folder the request itself named.
//
// ⚠️ **Precedence is pinned deliberately, not incidentally.** An explicit payload `location` still
// wins over the colleague's folder, and one shipped caller depends on that
// (`packages/novaclaw/src/cli/cmd/run.ts` — `novaclaw run` in a project directory works THERE, not
// in the colleague's scratch). The other side of that coin is that any client which sends a
// location it did not have to send silently discards the colleague's folder, which is why the last
// case states the precedence out loud rather than leaving it to be rediscovered.
//
// ── Layering (same as `./session-create-features.test.ts`, and for the same reasons) ─────────────
//
// A JSON body goes through the REAL protocol payload schema, into the REAL registered handler
// function, into a REAL kernel on an in-memory database. Nothing here is a fixture of the thing
// under test: the roster is the real `AgentV2` state, the resolution is the real `agentLocation`,
// and the row is read back out of the real store.
//
// ⚠️ The store layers are built against `Database.layerFromPath(":memory:")`, never `Database.node`
// — the global node resolves its path from `Flag.NOVACLAW_DB` at module load and `packages/server`
// has no test preload pinning it, so a node-based test would open the developer's real database.
//
// ⚠️ `Location.Service` is provided per call rather than through the graph. In production it comes
// from `locationMiddleware`, which this file fakes as a pass-through (it makes no claim about
// transport); the handler resolves the service inside `agentLocation`, so the request's own
// directory has to be handed in at the call, and handing it in explicitly is also what lets a case
// say "and NOT the folder the caller was standing in".

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// ⚠️ Set before any test runs, and read by `Scratch.root()` on EVERY call rather than captured at
// import — a colleague with no configured folder must resolve under a throwaway root, because
// `agentLocation` creates that folder for real (`Scratch.ensureForAgent`).
//
// ⚠️ **And put back afterwards, because `process.env` is the whole PROCESS.** The gate runs a unit's
// files in one bun process, so a variable set at module scope and left there stops being this file's
// isolation and becomes every later file's environment.
const PREVIOUS_SCRATCH_ROOT = process.env["NOVACLAW_SCRATCH_ROOT"]
const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-agent-location-"))
process.env["NOVACLAW_SCRATCH_ROOT"] = SCRATCH_ROOT
afterAll(() => {
  if (PREVIOUS_SCRATCH_ROOT === undefined) delete process.env["NOVACLAW_SCRATCH_ROOT"]
  else process.env["NOVACLAW_SCRATCH_ROOT"] = PREVIOUS_SCRATCH_ROOT
})

import { Effect, Layer, Schema } from "effect"
import { Authorization } from "@novaclaw/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@novaclaw/protocol/middleware/schema-error"
import { AgentV2 } from "@novaclaw/core/agent"
import { AgentWorkspace } from "@novaclaw/core/agent/workspace"
import { Scratch } from "@novaclaw/core/scratch"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { ProjectV2 } from "@novaclaw/core/project"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { FSUtil } from "@novaclaw/core/fs-util"
import { ProjectFileCache } from "@novaclaw/core/project-file-cache"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionStore } from "@novaclaw/core/session/store"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SESSION_HANDLER_NODES } from "./session-nodes"
import { Api } from "../api"
import { LocationMiddleware } from "../location"
import { SessionLocationMiddleware } from "../middleware/session-location"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { SessionHandler } from "./session"

/**
 * Every comparison below goes through this.
 *
 * ⚠️ **A session's directory comes back PLATFORM-NATIVE, and it did not go in that way.**
 * `database/path.ts`'s `directoryColumn` stores a Windows path slash-normalized (`C:/…`) and hands
 * it back with the platform's separator (`C:\…`), deliberately, so the column has one storage form
 * and every reader gets a path it can pass to `fs`. Comparing raw strings here would make this file
 * a test of that column's spelling rather than of where the chat landed — and it would pass on
 * Linux and fail on Windows for a reason that has nothing to do with colleagues.
 */
const norm = (directory: string) => path.resolve(directory)

/** Where the CALLER is standing. Every colleague below must land somewhere that is not this. */
const REQUEST_DIRECTORY = "C:/tmp/session-agent-location/caller"

/** The project the user assigned to one colleague, through the agent-config dialog's folder picker. */
const ASSIGNED_PROJECT = "C:/tmp/session-agent-location/books"

/** The colleague the user pointed at a project. */
const ASSIGNED = "daedalus"
/** The colleague nobody has pointed anywhere — the ordinary state of a fresh hire. */
const UNASSIGNED = "myron"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The environment. Identical to `session-create-features.test.ts` except for `AgentV2.node`: that
// file only ever creates for the `build` POSTURE, which `agentLocation` answers before it touches
// the roster, so the agent service was never resolved there.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

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
    AgentV2.node,
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

type CreateHandler = (request: {
  readonly payload: unknown
}) => Effect.Effect<{ readonly data: SessionSchema.Info }, unknown, any>

/**
 * The `session.create` endpoint as `packages/protocol` declares it — payload schema included.
 *
 * Reaching into `endpoint.payload` is guarded: if effect changes that shape this fails with a named
 * message rather than silently testing nothing.
 */
const createEndpoint = () => {
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
  const group = groups["server.session.catalog"]
  expect(group, "the api no longer declares a `server.session.catalog` group — re-aim this file").toBeDefined()
  const endpoint = Object.values(group!.endpoints).find((item) => item.name === "session.create")
  expect(endpoint, "`session.create` is no longer declared — re-aim this file").toBeDefined()
  const json = endpoint!.payload?.get("application/json")
  expect(json?.schemas?.[0], "`session.create` declares no application/json payload schema").toBeDefined()
  return { key: group!.key, payload: json!.schemas![0] as never }
}

const decodeCreatePayload = (body: Record<string, unknown>) =>
  Schema.decodeUnknownSync(createEndpoint().payload)(body) as Record<string, unknown>

/** The request's own location, as `locationMiddleware` would have derived it from the caller. */
const callerAt = (directory: string) =>
  Location.Service.of({
    directory: AbsolutePath.make(directory),
    root: AbsolutePath.make(directory),
    origin: "global",
  })

/**
 * Seed the roster the way the agent-config dialog's Save does — one colleague pointed at a project,
 * one left alone. Real `AgentV2` state, not a stub service: a stub would be this file agreeing with
 * itself about what a roster row looks like.
 */
const seedRoster = Effect.gen(function* () {
  const agents = yield* AgentV2.Service
  yield* agents.transform((editor) => {
    editor.update(AgentV2.ID.make(ASSIGNED), (agent) => {
      agent.name = "Daedalus"
      agent.mode = "primary"
      agent.directory = ASSIGNED_PROJECT
    })
    editor.update(AgentV2.ID.make(UNASSIGNED), (agent) => {
      agent.name = "Myron"
      agent.mode = "primary"
    })
  })
})

/**
 * Build the group layer, pull the REAL registered `session.create` out of it, and run `body` inside
 * the SAME scope — the in-memory database lives in that scope, so reading a session back after it
 * closed would prove nothing.
 */
const withCreate = <A>(body: (create: CreateHandler) => Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { key } = createEndpoint()
      const context = yield* Layer.build(SessionHandler as unknown as Layer.Layer<never, never, never>)
      const built = context.mapUnsafe.get(key) as {
        readonly handlers: Map<string, { readonly handler: CreateHandler }>
      }
      const item = built.handlers.get("session.create")
      expect(
        item,
        'server.session.catalog registered no handler for "session.create" — the route would 404',
      ).toBeDefined()
      yield* seedRoster
      return yield* body(item!.handler)
    }).pipe(Effect.scoped, Effect.provide(environment)) as Effect.Effect<A>,
  )

/**
 * POST a body from `REQUEST_DIRECTORY` and read the session back out of the store.
 *
 * The ROW, not the response echo — and then both, because the UI renders the new chat from the echo
 * and a row that carries the right folder behind an echo that does not is still a chat the client
 * files in the wrong place.
 */
const createFrom = (create: CreateHandler, body: Record<string, unknown>, from = REQUEST_DIRECTORY) =>
  Effect.gen(function* () {
    const response = yield* create({ payload: decodeCreatePayload(body) }).pipe(
      Effect.provideService(Location.Service, callerAt(from)),
    )
    const store = yield* SessionStore.Service
    const reloaded = yield* store.get(response.data.id)
    expect(reloaded, "the handler returned a session that is not in the store").toBeDefined()
    return {
      id: response.data.id,
      echoed: response.data.location.directory as string,
      stored: (reloaded as unknown as { readonly location: { readonly directory: string } }).location.directory,
    }
  })

describe("a new chat lands in the colleague's own folder", () => {
  /**
   * 🔴 THE PAIR. Two colleagues, one create each, NO location on either body — and they must land
   * in two different folders, neither of which is the one the caller was standing in.
   *
   * Any of the three plausible broken handlers passes a single case and fails this one: "always the
   * request's directory" (what the code did before `agentLocation`), "always the scratch path" (a
   * `folderFor` that ignores its `directory` argument), and "always the configured folder" (one that
   * ignores the absence of it).
   */
  test("🔴 assigned → the project; unassigned → its OWN scratch; and neither is the caller's folder", async () => {
    const { assigned, unassigned } = await withCreate((create) =>
      Effect.gen(function* () {
        const assigned = yield* createFrom(create, { agent: ASSIGNED })
        const unassigned = yield* createFrom(create, { agent: UNASSIGNED })
        return { assigned, unassigned }
      }),
    )

    expect(
      norm(assigned.stored),
      "a colleague with a configured folder got a chat somewhere else — the create ignored `agents.<id>.directory`, which is the whole of what the folder picker writes",
    ).toBe(norm(ASSIGNED_PROJECT))
    expect(
      norm(unassigned.stored),
      "a colleague with no configured folder did not get its OWN scratch — a roster sharing one scratch dir is a filing cabinet with no drawers",
    ).toBe(norm(Scratch.forAgent(UNASSIGNED)))

    // The negative half, and the reason the pair is stated as one claim: a handler that answers the
    // same thing for everybody satisfies either line above on its own.
    expect(
      norm(assigned.stored),
      "both colleagues landed in the same folder — the resolution is not keyed on the agent",
    ).not.toBe(norm(unassigned.stored))
    for (const [who, landed] of [
      [ASSIGNED, assigned.stored],
      [UNASSIGNED, unassigned.stored],
    ] as const)
      expect(
        norm(landed),
        `${who}'s chat was filed in the CALLER's directory — the request's location was used where the colleague's folder should have been`,
      ).not.toBe(norm(REQUEST_DIRECTORY))

    // The echo is what the client files the new chat under; a row and an echo that disagree put the
    // route and the store on two different folders.
    expect(norm(assigned.echoed), "the create response echoed a folder the row does not carry").toBe(
      norm(assigned.stored),
    )
    expect(norm(unassigned.echoed), "the create response echoed a folder the row does not carry").toBe(
      norm(unassigned.stored),
    )
  })

  /**
   * The rule the row is supposed to be an instance of, asserted against the rule itself rather than
   * against a path this file typed out. `folderFor` is the ONE definition of where a colleague works
   * (the client deliberately does not own a second copy — see the handler's comment), so a row that
   * disagrees with it means the wire grew its own answer.
   *
   * ⚠️ **It is a DIVERGENCE ratchet and nothing more, deliberately.** Measured: poisoning `folderFor`
   * to ignore its `directory` argument leaves this case GREEN, because both sides of the comparison
   * move together — the row follows the rule wherever the rule goes. That is exactly what it is for,
   * and it is why the case above states the two folders as literals instead. Read them as a pair:
   * one pins the answer, this one pins that there is only one place the answer comes from.
   */
  test("the folder on the row is exactly what `AgentWorkspace.folderFor` says it is", async () => {
    const landed = await withCreate((create) =>
      Effect.gen(function* () {
        const assigned = yield* createFrom(create, { agent: ASSIGNED })
        const unassigned = yield* createFrom(create, { agent: UNASSIGNED })
        return { assigned: assigned.stored, unassigned: unassigned.stored }
      }),
    )

    expect(norm(landed.assigned)).toBe(norm(AgentWorkspace.folderFor({ agentID: ASSIGNED, directory: ASSIGNED_PROJECT })))
    expect(norm(landed.unassigned)).toBe(norm(AgentWorkspace.folderFor({ agentID: UNASSIGNED, directory: undefined })))
  })

  /**
   * "Every agent always has a real folder" has to be true, not aspirational: a first chat for a
   * newly hired officer is the ordinary case, and a working directory that does not exist is a tool
   * call that fails for a reason the model cannot see.
   */
  test("the unassigned colleague's scratch folder EXISTS on disk after the create", async () => {
    await withCreate((create) => createFrom(create, { agent: UNASSIGNED }))
    expect(
      fs.existsSync(Scratch.forAgent(UNASSIGNED)),
      "the colleague's own workspace was named on the row and never created — the first tool call lands in a folder that is not there",
    ).toBe(true)
  })

  /**
   * ⚠️ A POSTURE has no folder of its own. `build` and `plan` say HOW a chat runs, not WHOSE it is,
   * so there is no project or scratch this could mean — and without the guard every create that did
   * not carry a location would land in `…/scratch/build` instead of where the request came from.
   *
   * It is also the third arm of the control: the handler does not merely ignore the request's
   * location, it uses it exactly when there is no colleague to ask.
   */
  test("a posture is not a colleague — the request's own folder is used, and no `scratch/build` appears", async () => {
    const landed = await withCreate((create) => createFrom(create, { agent: "build" }))
    expect(
      norm(landed.stored),
      "a `build` chat was filed in a posture's scratch folder — a posture has no workspace to be filed in",
    ).toBe(norm(REQUEST_DIRECTORY))
    expect(fs.existsSync(Scratch.forAgent("build"))).toBe(false)
  })

  /**
   * 🔴 PRECEDENCE, stated out loud. An explicit `location` on the payload WINS over the colleague's
   * folder — deliberately, and one shipped caller needs it: `novaclaw run` creates a chat for the
   * default colleague and must run in the directory the user invoked it from, not in that
   * colleague's project.
   *
   * ⚠️ The cost of that rule is the thing to remember: **a client that sends a location it did not
   * have to send silently discards the colleague's folder.** The UI's doors are written so they
   * cannot — the composer's create body has no `location` member at all, and the home launcher's
   * body is a ternary where a colleague and a folder are mutually exclusive — and this case exists
   * so that anyone adding a third door reads the consequence before adding one.
   */
  test("an explicit location still wins — and that is exactly how a colleague's folder gets discarded", async () => {
    const elsewhere = "C:/tmp/session-agent-location/elsewhere"
    const landed = await withCreate((create) =>
      createFrom(create, { agent: ASSIGNED, location: { directory: elsewhere } }),
    )
    expect(
      norm(landed.stored),
      "the payload's explicit location was overridden — `novaclaw run` in a project directory would start working in the colleague's folder instead",
    ).toBe(norm(elsewhere))
  })
})
