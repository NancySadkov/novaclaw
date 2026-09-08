// THE RESOLVED-CONFIG ENDPOINT — what it claims, and what it may not silently stop claiming.
//
// Two questions, deliberately tested against different things:
//
//   1. **Is the wire still generated from the descriptor?** `packages/protocol` cannot import
//      `SESSION_CONFIG_FIELDS` (it depends on `@novaclaw/schema` and `effect` only), so the response
//      is an OPEN map and the field set is supplied at runtime by the handler. That is the correct
//      shape — a hand-written struct in the protocol package would be a second list of the same
//      fields, i.e. the exact defect ruling 8 came from. But an open map cannot be checked by the
//      type system, so the equivalence is checked HERE, in the one package that can see both ends.
//      Every case below iterates `SESSION_CONFIG_FIELD_KEYS`; none of them names a field.
//
//   2. **Is the provenance the same answer the runner would get?** The endpoint's value is that
//      `origin` explains a value. A wrong `origin` is worse than no endpoint: it is a confident
//      falsehood about where a setting came from, delivered by the thing you consult when you are
//      already confused. The narrowing case (`permissionMode`) is where a naive "deepest declarer
//      wins" rule breaks, so it is negative-controlled in both directions.
//
// ⚠️ The end-to-end case builds against `Database.layerFromPath(":memory:")`, never `Database.node` —
// the global node resolves its path from `Flag.NOVACLAW_DB` at module load and `packages/server` has
// no test preload pinning it, so a node-based test would open the developer's real database. (Same
// reasoning as `session-create-features.test.ts` and `config-remove.test.ts` in this directory.)

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Authorization } from "@novaclaw/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@novaclaw/protocol/middleware/schema-error"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { AbsolutePath } from "@novaclaw/core/schema"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { FSUtil } from "@novaclaw/core/fs-util"
import { ProjectFileCache } from "@novaclaw/core/project-file-cache"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { ProjectV2 } from "@novaclaw/core/project"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionStore } from "@novaclaw/core/session/store"
import {
  EFFECTIVE_CONFIG_DEFAULTS,
  resolveConfig,
  SESSION_CONFIG_FIELD_KEYS,
  SESSION_CONFIG_FIELDS,
  type SessionConfig,
} from "@novaclaw/core/session/config-resolve"
import { Api } from "../api"
import { LocationMiddleware } from "../location"
import { SessionLocationMiddleware } from "../middleware/session-location"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { SessionHandler } from "./session"
import { SESSION_HANDLER_NODES } from "./session-nodes"
import { resolvedConfigView } from "./session-config"

// ⚠️ Branded at the constant, not at each call site: `location.directory` is
// `string & Brand<"AbsolutePath">`, and a raw literal typechecks nowhere while passing every runtime
// assertion — this file was 40/40 green with `typecheck:server` red. Brand once, here.
const DIRECTORY = AbsolutePath.make("C:/tmp/session-config-resolve")

const ROOT = "ses_root" as SessionSchema.ID
const MIDDLE = "ses_middle" as SessionSchema.ID
const LEAF = "ses_leaf" as SessionSchema.ID

/** The pure half: a three-deep chain of explicit override layers, root-first. */
const view = (...layers: readonly SessionConfig[]) =>
  resolvedConfigView([ROOT, MIDDLE, LEAF][layers.length - 1]!, [ROOT, MIDDLE, LEAF].slice(0, layers.length), layers)

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1. THE DESCRIPTOR IS THE FIELD SET
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("the wire is generated from SESSION_CONFIG_FIELDS, never hand-listed", () => {
  test("every descriptor field appears, and nothing else does", () => {
    const result = view({}, {}, {})
    expect(
      Object.keys(result.fields).sort(),
      "the response's field set drifted from the descriptor. `session-config.ts` must enumerate SESSION_CONFIG_FIELD_KEYS — a field it stops reporting is a field nobody can observe, which is how the fork defect ruling 8 came from hid.",
    ).toEqual([...SESSION_CONFIG_FIELD_KEYS].map(String).sort())
  })

  test("each field reports the descriptor's own merge strategy", () => {
    const result = view({})
    const wrong = SESSION_CONFIG_FIELD_KEYS.filter(
      (key) => result.fields[key]?.merge !== SESSION_CONFIG_FIELDS[key].merge,
    )
    expect(wrong.join(", "), "a field reported a merge strategy the descriptor does not declare").toBe("")
  })

  test("`permissionMode` is the ONLY narrowing field — the premise the narrowing cases below rest on", () => {
    const narrowing = SESSION_CONFIG_FIELD_KEYS.filter((key) => SESSION_CONFIG_FIELDS[key].merge === "narrow")
    expect(
      narrowing.map(String),
      "the set of narrowing fields changed. The narrowing cases below are written about permissionMode specifically; a second narrowing field needs its own case, not an inherited assumption.",
    ).toEqual(["permissionMode"])
  })

  test("`resolved` and `fields[key].value` are the same answer", () => {
    // Two representations of one fold ride on this wire — `resolved` for reading, `fields` for
    // explaining. They are derived in one place, and this is what keeps that true.
    const result = view({ permissionMode: "ask", priority: 3 }, { agent: "reviewer" })
    const disagreed = SESSION_CONFIG_FIELD_KEYS.filter(
      (key) => !Object.is(result.resolved[key], result.fields[key]?.value),
    )
    expect(disagreed.join(", "), "`resolved` disagrees with `fields[key].value` — the wire carries two answers").toBe(
      "",
    )
  })

  test("the reported values ARE `resolveConfig`'s — the endpoint never re-implements the fold", () => {
    const chain: SessionConfig[] = [
      { permissionMode: "bypass", type: "goal-oriented", priority: 1 },
      { agent: "reviewer", safeMode: true },
      { permissionMode: "plan", priority: 9 },
    ]
    const expected = resolveConfig(EFFECTIVE_CONFIG_DEFAULTS, chain)
    const result = view(...chain)
    const wrong = SESSION_CONFIG_FIELD_KEYS.filter((key) => !Object.is(result.fields[key]?.value, expected[key]))
    expect(wrong.join(", "), "the endpoint's value disagrees with the keystone's own resolution").toBe("")
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2. PROVENANCE — the half that makes the endpoint worth having
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("origin says WHICH ancestor supplied each field", () => {
  test("a field nobody declared has no origin and falls to the defaults", () => {
    const field = view({}, {}, {}).fields["agent"]!
    expect(field.origin, "a field no layer declared claimed an origin").toBeUndefined()
    expect(field.declaredBy).toEqual([])
    expect(field.value).toBeUndefined()
  })

  test("a default-valued field still has no origin — the default is not an ancestor", () => {
    // `permissionMode` resolves to `bypass` with an empty chain because EFFECTIVE_CONFIG_DEFAULTS
    // says so. Attributing that to the root session would be a false answer of exactly the kind
    // this endpoint exists to prevent.
    const field = view({}, {}).fields["permissionMode"]!
    expect(field.value).toBe(EFFECTIVE_CONFIG_DEFAULTS.permissionMode)
    expect(field.origin, "the global default was attributed to a session").toBeUndefined()
    expect(view({}, {}).defaults["permissionMode"], "`defaults` must say what an absent origin means").toBe(
      EFFECTIVE_CONFIG_DEFAULTS.permissionMode,
    )
  })

  test("THE ITEM'S OWN CASE — the child ran under the INHERITED prompt, and you can see whose", () => {
    const result = view({ systemPromptOverride: "you are the parent" }, {})
    const field = result.fields["systemPromptOverride"]!
    expect(field.value, "the child did not inherit the parent's prompt").toBe("you are the parent")
    expect(field.origin, "the inherited prompt was not attributed to the ancestor that set it").toBe(ROOT)
    expect(field.declaredBy, "the child was reported as having declared a prompt it never set").toEqual([ROOT])
    expect(result.chain).toEqual([ROOT, MIDDLE])
  })

  test("an override moves the origin to the declaring layer, and both stay in declaredBy", () => {
    const field = view({ systemPromptOverride: "parent" }, { systemPromptOverride: "child" }).fields[
      "systemPromptOverride"
    ]!
    expect(field.value).toBe("child")
    expect(field.origin).toBe(MIDDLE)
    expect(field.declaredBy).toEqual([ROOT, MIDDLE])
  })

  test("the DEEPEST change wins, not the first — a grandchild restoring the root's value owns it", () => {
    const field = view({ agent: "a" }, { agent: "b" }, { agent: "a" }).fields["agent"]!
    expect(field.value).toBe("a")
    expect(
      field.origin,
      "a scan that stopped at the first change would answer the root here, and the leaf is what actually set the value",
    ).toBe(LEAF)
    expect(field.declaredBy).toEqual([ROOT, MIDDLE, LEAF])
  })

  // ── THE NARROWING KEYSTONE ──────────────────────────────────────────────────────────────────────
  // This is the pair that a "deepest declarer wins" rule gets wrong, and it is the reason provenance
  // is derived from `resolveConfig` over prefixes rather than from a second hand-written rule.

  test("a child asking for MORE capability loses, and origin still points at the ancestor that bound it", () => {
    const field = view({ permissionMode: "plan" }, { permissionMode: "yolo" }).fields["permissionMode"]!
    expect(field.value, "narrowing was not applied — a child escalated past its parent").toBe("plan")
    expect(
      field.origin,
      "the losing child was reported as the origin. `declaredBy` is where a losing declaration belongs; `origin` is what the session RUNS with.",
    ).toBe(ROOT)
    expect(
      field.declaredBy,
      "the child's declaration vanished — a reader could not tell it tried and was clamped",
    ).toEqual([ROOT, MIDDLE])
    expect(field.merge, "the field did not report the strategy that explains the clamp").toBe("narrow")
  })

  test("a child asking for LESS capability wins, and origin follows it", () => {
    // The negative control for the case above: same shape, opposite direction. If `origin` were
    // hard-wired to the root for narrowing fields, this is what would catch it.
    const field = view({ permissionMode: "yolo" }, { permissionMode: "plan" }).fields["permissionMode"]!
    expect(field.value).toBe("plan")
    expect(field.origin).toBe(MIDDLE)
    expect(field.declaredBy).toEqual([ROOT, MIDDLE])
  })

  test("the ROOT sets its mode freely — a root below the default is not clamped up to it", () => {
    const field = view({ permissionMode: "plan" }).fields["permissionMode"]!
    expect(field.value).toBe("plan")
    expect(field.origin).toBe(ROOT)
  })

  test("an explicit `false` is a stance with an origin, not an absence", () => {
    // The tri-state trap: `undefined` means inherit, `false` means the user chose OFF. A view that
    // treated falsiness as absence would erase a deliberate stance and report the ancestor's ON.
    const field = view({ safeMode: true }, { safeMode: false }).fields["safeMode"]!
    expect(field.value, "an explicit OFF was read as inherit").toBe(false)
    expect(field.origin).toBe(MIDDLE)
    expect(field.declaredBy).toEqual([ROOT, MIDDLE])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3. END TO END — the registered handler, a real kernel, a real parent and a real child
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
    // The session routes reach these out of the ambient context at BUILD time, so omitting one
    // fails every test here that drives a real HTTP request with `Service not found` rather than
    // anything about config resolution. Shared with the other test kernel and production
    // `routes.ts` — see `session-nodes.ts` for the three times a hand-kept copy went stale.
    ...SESSION_HANDLER_NODES,
    // The handler resolves the layer the TURN uses through this service — the folder's tune folded
    // in — so the view cannot disagree with the runner. `FSUtil` is how the cache reaches the disk.
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

type ConfigHandlerFn = (request: {
  readonly params: { readonly sessionID: SessionSchema.ID }
}) => Effect.Effect<{ readonly data: unknown }, unknown, never>

/**
 * The endpoint as `packages/protocol` declares it, plus its declared success schema.
 *
 * Reaching into the group is deliberate and guarded: a shape change in effect fails here with a
 * named message rather than silently testing nothing.
 */
const configEndpoint = () => {
  const groups = Api.groups as unknown as Record<
    string,
    {
      readonly key: string
      readonly endpoints: Record<string, { readonly name: string; readonly success?: Set<{ readonly ast?: unknown }> }>
    }
  >
  const group = groups["server.session.catalog"]
  expect(group, "the api no longer declares a `server.session.catalog` group — re-aim this file").toBeDefined()
  const endpoint = Object.values(group!.endpoints).find((item) => item.name === "session.config")
  expect(endpoint, "`session.config` is no longer declared — the route would 404").toBeDefined()
  // ⚠️ `endpoint.success` is a SET of schemas, not a schema. Reaching in is guarded: if effect
  // changes that shape this fails with a named message instead of quietly decoding nothing.
  const success = [...(endpoint!.success ?? [])].find((item) => item.ast !== undefined)
  expect(success, "`session.config` declares no success schema — nothing below would be checked").toBeDefined()
  return { key: group!.key, success: success! }
}

const withHandler = <A>(body: (call: ConfigHandlerFn) => Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { key } = configEndpoint()
      const context = yield* Layer.build(SessionHandler as unknown as Layer.Layer<never, never, never>)
      const built = context.mapUnsafe.get(key) as {
        readonly handlers: Map<string, { readonly handler: ConfigHandlerFn }>
      }
      const item = built.handlers.get("session.config")
      expect(
        item,
        'server.session.catalog registered no handler for "session.config" — the route would 404',
      ).toBeDefined()
      return yield* body(item!.handler)
    }).pipe(Effect.scoped, Effect.provide(environment)) as Effect.Effect<A>,
  )

type Row = Record<string, unknown>

describe("GET /api/session/:id/config over a real parent and child", () => {
  test("the child's inherited fields are visible AND attributed to the parent", async () => {
    const result = await withHandler((call) =>
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const parent = yield* sessions.create({
          location: { directory: DIRECTORY },
          agent: "build" as never,
          systemPromptOverride: "inherited from the parent",
          permissionMode: "ask",
          type: "goal-oriented",
        })
        const child = yield* sessions.create({
          location: { directory: DIRECTORY },
          parentID: parent.id,
          // Declares exactly ONE field of its own, and asks for MORE capability than the parent
          // allows — so this single session exercises inheritance, override and narrowing at once.
          agent: AgentV2.ID.make("child-agent"),
          permissionMode: "yolo",
        })
        const stored = yield* sessions.get(child.id)
        const response = yield* call({ params: { sessionID: child.id } })
        return { parent, child, stored: stored as unknown as Row, data: response.data as Row }
      }),
    )

    const fields = result.data["fields"] as Record<string, Row>
    const resolved = result.data["resolved"] as Row

    // The premise: `session.get` genuinely cannot answer this. The child's own ROW carries no
    // prompt, so the raw record is silent about what the session actually runs with — which is the
    // gap this endpoint closes, and it is asserted rather than asserted-about.
    expect(
      result.stored["systemPromptOverride"],
      "the child's raw row carries a prompt, so this test is no longer about inheritance — re-aim it",
    ).toBeUndefined()

    expect(result.data["chain"], "the chain is not [root … session], root-first").toEqual([
      result.parent.id,
      result.child.id,
    ])

    // INHERITED — the item's acceptance criterion.
    expect(fields["systemPromptOverride"]!["value"]).toBe("inherited from the parent")
    expect(
      fields["systemPromptOverride"]!["origin"],
      "the inherited prompt was not attributed to the parent that set it",
    ).toBe(result.parent.id)
    expect(fields["systemPromptOverride"]!["declaredBy"]).toEqual([result.parent.id])

    // INHERITED, second field — one example is a coin flip.
    expect(fields["type"]!["value"]).toBe("goal-oriented")
    expect(fields["type"]!["origin"]).toBe(result.parent.id)

    // OVERRIDDEN by the child.
    expect(fields["agent"]!["value"]).toBe("child-agent")
    expect(fields["agent"]!["origin"]).toBe(result.child.id)

    // NARROWED — the child asked for `yolo` and runs at `ask`.
    expect(fields["permissionMode"]!["value"], "the child escalated past its parent over HTTP").toBe("ask")
    expect(fields["permissionMode"]!["origin"]).toBe(result.parent.id)
    expect(fields["permissionMode"]!["declaredBy"]).toEqual([result.parent.id, result.child.id])
    expect(resolved["permissionMode"]).toBe("ask")
  })

  test("the response decodes against the schema `packages/protocol` declares", async () => {
    // The handler could produce a shape the wire rejects and every assertion above would still pass;
    // `bun test` type-strips, so the compiler is not the check here either.
    const { success } = configEndpoint()
    const data = await withHandler((call) =>
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const parent = yield* sessions.create({
          location: { directory: DIRECTORY },
          agent: "build" as never,
          priority: 4,
        })
        const child = yield* sessions.create({ location: { directory: DIRECTORY }, parentID: parent.id })
        return yield* call({ params: { sessionID: child.id } })
      }),
    )
    expect(() => Schema.decodeUnknownSync(success as never)(data)).not.toThrow()
  })

  test("🔴 a real `novaclaw.json` reaches the wire as `source`, file and all", async () => {
    // ⚠️ THE case this endpoint's `source` field exists for, and the one a unit test of
    // `resolvedConfigView` cannot make: everything between the file on disk and the decoded
    // response has to work. Three separate things could silently drop it and all three look
    // identical from the outside — the handler passing the shipped defaults instead of the folded
    // layer (what it did until 2026-08-13), the fold refusing the switch as unwired, and the
    // protocol's success schema not declaring `source`, which makes the encoder delete it on the
    // way out and reads exactly like a stale backend.
    const { success } = configEndpoint()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-project-"))
    fs.writeFileSync(
      path.join(root, "novaclaw.json"),
      JSON.stringify({ version: 1, tune: { features: { memory: false } } }),
      "utf8",
    )
    try {
      const data = await withHandler((call) =>
        Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const session = yield* sessions.create({
            location: { directory: AbsolutePath.make(root) },
            agent: "build" as never,
          })
          return yield* call({ params: { sessionID: session.id } })
        }),
      )
      // Decoded, not read raw: a field the schema does not declare is dropped HERE, which is the
      // whole point of checking the decoded value rather than the handler's return.
      const decoded = Schema.decodeUnknownSync(success as never)(data) as {
        readonly data: {
          readonly fields: Record<string, { readonly value?: unknown; readonly source?: Record<string, unknown> }>
          readonly project?: { readonly file: string; readonly applied: readonly string[] }
        }
      }
      expect(decoded.data.fields["memory"]?.value, "the folder's switch did not reach the resolution").toBe(false)
      expect(decoded.data.fields["memory"]?.source).toEqual({
        kind: "project",
        file: path.join(root, "novaclaw.json"),
      })
      expect(decoded.data.project?.applied).toContain("memory")
      // A component the folder did NOT supply must still read as the instance, or "project" would
      // just be what this endpoint says whenever a project file exists.
      expect(decoded.data.fields["permissionMode"]?.source).toEqual({ kind: "instance" })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("a session that does not exist is a 404, not a page of defaults", async () => {
    // The worst possible answer from this endpoint is a confident one about a session that is not
    // there: every field present, every origin absent, reading exactly like a real root session.
    const failure = await withHandler((call) =>
      call({ params: { sessionID: "ses_nope" as SessionSchema.ID } }).pipe(Effect.flip),
    )
    expect((failure as { _tag?: string })._tag, "an unknown session did not produce SessionNotFoundError").toBe(
      "SessionNotFoundError",
    )
  })
})

/**
 * Where a component's value came from when no session declared it.
 *
 * `origin` can only name a session, so before this the folder layer and the shipped defaults were
 * indistinguishable from "nothing set it" — which is the one question this surface exists to answer.
 */
describe("provenance beneath the entity", () => {
  const layerWithProject = {
    defaults: { ...EFFECTIVE_CONFIG_DEFAULTS, memory: false, safeMode: true },
    project: {
      root: "C:/work/app",
      file: "C:/work/app/novaclaw.json",
      applied: ["memory"],
      // Declared and refused: a folder may raise a supervision switch, never lower one. Carried on
      // the layer so the surface can say what the file asked for and did not get.
      refused: ["askBeforeChanges"],
    },
  }

  test("a component the folder supplied names the file", () => {
    const view = resolvedConfigView("s1", ["s1"], [{}], layerWithProject)
    expect(view.fields.memory?.source).toEqual({ kind: "project", file: "C:/work/app/novaclaw.json" })
    expect(view.fields.memory?.origin).toBeUndefined()
    expect(view.fields.memory?.value).toBe(false)
  })

  test("a default the folder did NOT supply reads as the instance", () => {
    // `safeMode` is in the folded defaults but not in `applied`, so it came from below the folder.
    const view = resolvedConfigView("s1", ["s1"], [{}], layerWithProject)
    expect(view.fields.safeMode?.source).toEqual({ kind: "instance" })
  })

  // 🔴 THE COLLEAGUE as an author. Until 2026-08-22 every field an agent declared reported
  // `source: { kind: "instance" }` — by elimination, because the fold writes into `defaults` and a
  // default no project file claimed was assumed to be the instance's. A chat that was read-only
  // because its officer is an auditor told the user the INSTANCE had decided that.
  const layerWithAgent = {
    defaults: { ...EFFECTIVE_CONFIG_DEFAULTS, permissionMode: "plan" as const, safeMode: true },
    agent: { id: "veritas", applied: ["permissionMode"] },
  }

  test("a default the COLLEAGUE declared names the colleague", () => {
    const view = resolvedConfigView("s1", ["s1"], [{}], layerWithAgent)
    expect(view.fields.permissionMode?.source).toEqual({ kind: "agent", agentID: "veritas" })
  })

  test("a default the colleague did NOT declare still reads as the instance", () => {
    // The negative control, and the one that would catch "attribute everything to the agent".
    const view = resolvedConfigView("s1", ["s1"], [{}], layerWithAgent)
    expect(view.fields.safeMode?.source).toEqual({ kind: "instance" })
  })

  test("🔴 the FOLDER outranks the colleague on a field they both declared", () => {
    // Matching the fold order — `ProjectDefaults.fold(AgentDefaults.fold(DEFAULTS, colleague), tune)`
    // — so the folder's value is what survives and the folder is what gets named. Reporting the
    // colleague here would send a user to edit a setting that is being overridden.
    const both = {
      defaults: { ...EFFECTIVE_CONFIG_DEFAULTS, memory: false },
      project: { root: "C:/work/app", file: "C:/work/app/novaclaw.json", applied: ["memory"], refused: [] },
      agent: { id: "veritas", applied: ["memory"] },
    }
    const view = resolvedConfigView("s1", ["s1"], [{}], both)
    expect(view.fields.memory?.source).toEqual({ kind: "project", file: "C:/work/app/novaclaw.json" })
  })

  test("🔴 a session that declares the component OUTRANKS the folder, and says so", () => {
    const view = resolvedConfigView("s1", ["s1"], [{ memory: true }], layerWithProject)
    expect(view.fields.memory?.value).toBe(true)
    expect(view.fields.memory?.origin).toBe("s1")
    // No source: a session set it, so "where did the default come from" is not the answer to give.
    expect(view.fields.memory?.source).toBeUndefined()
  })

  test("a component nothing supplies has neither an origin nor a source", () => {
    const view = resolvedConfigView("s1", ["s1"], [{}], layerWithProject)
    expect(view.fields.quality?.value).toBeUndefined()
    expect(view.fields.quality?.origin).toBeUndefined()
    expect(view.fields.quality?.source).toBeUndefined()
  })

  test("without a project layer every default reads as the instance", () => {
    const view = resolvedConfigView("s1", ["s1"], [{}])
    expect(view.fields.permissionMode?.source).toEqual({ kind: "instance" })
    expect(view.fields.memory?.source).toBeUndefined()
  })
})
