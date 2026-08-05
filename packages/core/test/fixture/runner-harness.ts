import { Effect, Layer, Schema, Stream } from "effect"
import {
  LLMClient,
  Model,
  type LLMClientShape,
  type LLMEvent,
  type LLMRequest,
} from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-chat"
import { Database } from "@novaclaw/core/database/database"
import { makeLocationNode } from "@novaclaw/core/effect/app-node"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNodePlatform } from "@novaclaw/core/effect/app-node-platform"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { PermissionV2 } from "@novaclaw/core/permission"
import { QuestionV2 } from "@novaclaw/core/question"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { Snapshot } from "@novaclaw/core/snapshot"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionRunCoordinator } from "@novaclaw/core/session/run-coordinator"
import { SessionRunner } from "@novaclaw/core/session/runner"
import * as SessionRunnerLLM from "@novaclaw/core/session/runner/llm"
import { SessionRunnerModel } from "@novaclaw/core/session/runner/model"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ApplicationTools } from "@novaclaw/core/tool/application-tools"
import { AgentV2 } from "@novaclaw/core/agent"
import { Config } from "@novaclaw/core/config"
import { ConfigCompaction } from "@novaclaw/core/config/compaction"
import { Tool } from "@novaclaw/core/tool/tool"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SessionStore } from "@novaclaw/core/session/store"
import { SystemContext } from "@novaclaw/core/system-context"
import { SystemContextRegistry } from "@novaclaw/core/system-context/registry"
import { SkillGuidance } from "@novaclaw/core/skill/guidance"
import { ReferenceGuidance } from "@novaclaw/core/reference/guidance"
import { Location } from "@novaclaw/core/location"

/**
 * A drain harness with NO shared state — the one property the old suite lacks.
 *
 * ⚠️ **Why this exists rather than a port.** `session-runner.test.ts` drives its mock through **six
 * module-level mutable variables** (`requests`, `response`, `responses`, `streamGate`, `streamStarted`,
 * `streamFailure`) which individual tests reset **by hand — sixty resets across the file**. A test that
 * forgets one reset silently inherits its predecessor's stream, tools or gate, so **order-dependence is
 * designed in** — which is the property that makes a suite pass alone and fail in a full run.
 *
 * Here the script and the whole node graph are created by the factory, so there is nothing to forget
 * and nothing to reset. Two tests cannot see each other's requests.
 *
 * ⚖️ **THE LAYER WIRING IS ADOPTED FROM THE OLD FIXTURE, DELIBERATELY (decided 2026-08-05).** An
 * earlier draft of this file re-derived the graph from scratch and it **never produced a single content
 * event** — nine hypotheses, no ported claim, and the drain reporting `Exit Success` over three
 * identical retries. The ruling that forbade a port forbade photocopying **653 unread lines with the
 * wedge machinery inside**; that hazard is gone now the file has been read closely enough to enumerate
 * its lock, its six globals, its sixty resets and its retry behaviour. Reusing wiring one understands is
 * not that failure. What is NOT carried across, and is the entire point of the rewrite:
 *
 *   - the **six module-level globals** — state is per-harness here, so a reset cannot be forgotten;
 *   - the **Windows singleton lock** — `runBounded` plus `script/test.ts`'s wall-clock kill replace it;
 *   - the **unbounded awaits** — every ported case runs under `runBounded`.
 *
 * ⚠️ The counter-argument, recorded rather than dismissed: if the wiring itself contributes to the 59
 * Linux failures, adopting it carries that bug forward. Nobody has bisected those. It is a **reversible**
 * bet — `session-runner-claims.test.ts` names all 77 claims, so any of them can be re-derived against a
 * different fixture later.
 */
export interface RunnerScript {
  /** Events the provider returns for the next interactive request, and for each request after it. */
  turns?: LLMEvent[][]
  /** Events the out-of-band auto-title probe gets. Default: an empty stream, i.e. no title. */
  titleTurns?: LLMEvent[][]
  /** Events the out-of-band post-drain maintenance probes get. Default: an empty stream. */
  maintenanceTurns?: LLMEvent[][]
}

/**
 * The post-drain passes that call the provider WITHOUT being part of the turn.
 *
 * 🔴 **This list is why the old suite's request counts are wrong, and it is a fixture defect rather
 * than a runner one (measured 2026-08-05).** `session-runner.test.ts` filters exactly one out-of-band
 * consumer — the title generator — because that was the only one when it was written. **Memory
 * extraction was added later and lands straight in the interactive request log**, which is precisely
 * the Linux failure the ledger sampled: `expect(requests).toHaveLength(1)` receiving **2**. That was
 * read as *"the drain issuing a second provider request"*, i.e. a behavioural claim about the runner.
 * It is not: it is post-drain maintenance counted as a turn.
 *
 * ⚠️ **And unclassified is worse than miscounted — it CONSUMES A SCRIPTED TURN.** The provider script
 * is a queue, so an unfiltered maintenance probe shifts the entry meant for the next real turn, and the
 * test that breaks is the one *after* it. That is the order-dependence this rewrite exists to end, so
 * classification is correctness here, not bookkeeping.
 *
 * ⚠️ The exhaustiveness of this list is pinned by `runner-harness-drain.test.ts` — a plain scripted
 * turn must produce exactly ONE interactive request. Add a post-drain provider pass to the runner and
 * that test goes red and names it, instead of silently skewing every count in the suite.
 */
const OUT_OF_BAND = [
  { channel: "title", marker: "You are a title generator" },
  { channel: "maintenance", marker: "You extract durable MEMORIES" },
] as const

/** The session every harness seeds. Per-harness DB, so a fixed id cannot collide across tests. */
export const HARNESS_SESSION = SessionV2.ID.make("ses_harness")

/**
 * Build one harness. Call it INSIDE a test, never at module scope — module scope is how the shared
 * state got there in the first place.
 */
export function makeRunnerHarness(script: RunnerScript = {}) {
  const requests: LLMRequest[] = []
  const titleRequests: LLMRequest[] = []
  const maintenanceRequests: LLMRequest[] = []
  const turns = [...(script.turns ?? [])]
  const titleTurns = [...(script.titleTurns ?? [])]
  const maintenanceTurns = [...(script.maintenanceTurns ?? [])]
  /** Every tool input the echo tool was called with, in order. Per-harness, like everything else. */
  const executions: string[] = []

  const model = Model.make({ id: "harness-model", provider: "harness", route: OpenAIChat.route })

  const clientLayer = Layer.succeed(
    LLMClient.Service,
    LLMClient.Service.of({
      prepare: () => Effect.die("the harness has no prepare path — a test that needs one should say so"),
      stream: ((request: LLMRequest) => {
        // Route the out-of-band passes off the interactive log FIRST — see OUT_OF_BAND above for why
        // this is correctness rather than bookkeeping.
        const system = JSON.stringify(request.system ?? [])
        const channel = OUT_OF_BAND.find((entry) => system.includes(entry.marker))?.channel
        if (channel === "title") {
          titleRequests.push(request)
          return Stream.fromIterable(titleTurns.shift() ?? [])
        }
        if (channel === "maintenance") {
          maintenanceRequests.push(request)
          return Stream.fromIterable(maintenanceTurns.shift() ?? [])
        }
        requests.push(request)
        // Shift rather than index, so an exhausted script cannot replay its last response forever —
        // a replay looks like a working test right up until it loops.
        //
        // 🔴 ⚠️ AN EMPTY STREAM DOES NOT SETTLE THE TURN. Measured 2026-08-05: a script of `[[]]`
        // produced **three** provider requests in three seconds — the drain treats an empty stream as a
        // turn worth retrying, not as an answer. So a claim asserting on a request COUNT must script a
        // real response; scripting nothing does not mean "one request and stop".
        return Stream.fromIterable(turns.shift() ?? [])
      }) as unknown as LLMClientShape["stream"],
      generate: () => Effect.die("the harness has no non-streaming path — a test that needs one should say so"),
    }),
  )

  const echo = Layer.effectDiscard(
    ToolRegistry.Service.use((registry) =>
      registry.register({
        echo: Tool.make({
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: ({ text }) =>
            Effect.sync(() => {
              executions.push(text)
              return { text }
            }),
        }),
      }),
    ),
  )
  const echoNode = makeLocationNode({ name: "test/runner-harness-tools", layer: echo, deps: [ToolRegistry.node] })

  const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))

  const systemContextKey = SystemContext.Key.make("test/harness-context")
  const systemContext = Layer.effectDiscard(
    SystemContextRegistry.Service.pipe(
      Effect.flatMap((registry) =>
        registry.register({
          key: systemContextKey,
          load: Effect.sync(() =>
            SystemContext.combine([
              SystemContext.make({
                key: systemContextKey,
                codec: Schema.toCodecJson(Schema.String),
                load: Effect.succeed("Initial context"),
                baseline: String,
                update: (_previous, current) => current,
                removed: () => "System context source removed: test/harness-context",
              }),
            ]),
          ),
        }),
      ),
    ),
  ).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))

  const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
  const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })

  const permission = Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      assert: () => Effect.die("unused"),
      ask: () => Effect.die("unused"),
      reply: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      forSession: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
    }),
  )

  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({
              compaction: new ConfigCompaction.Info({
                buffer: 3_000,
                keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
              }),
            }),
          }),
        ]),
    }),
  )

  const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
    [Snapshot.node, Snapshot.noopLayer],
    [LayerNodePlatform.llmClient, clientLayer],
    [SessionRunnerModel.node, models],
    [SystemContextRegistry.node, systemContext],
    [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
    [SkillGuidance.node, skillGuidance],
    [ReferenceGuidance.node, referenceGuidance],
    [PermissionV2.node, permission],
    [Config.node, config],
  ])

  const execution = Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const sessionRunner = yield* SessionRunner.Service
      const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
        drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
      })
      return SessionExecution.Service.of({
        active: coordinator.active,
        resume: coordinator.run,
        wake: coordinator.wake,
        interrupt: coordinator.interrupt,
      })
    }),
  ).pipe(Layer.provide(runnerLayer))

  const layer = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      echoNode,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, clientLayer],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
    ],
  )

  /**
   * Seed the session row. The old fixture's `setup` did this plus sixty resets; here the resets do not
   * exist, so seeding is all that is left.
   */
  const seed = Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({ id: HARNESS_SESSION, slug: HARNESS_SESSION, directory: "/project", title: "test", version: "test" })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

  return {
    /** Every interactive request the drain issued, in order. Per-harness: another test cannot append. */
    requests,
    /** Requests the out-of-band auto-title probe issued. Kept off `requests` on purpose. */
    titleRequests,
    /** Requests post-drain maintenance (memory extraction) issued. Also kept off `requests`. */
    maintenanceRequests,
    /** Text the echo tool was asked to echo, in call order. */
    executions,
    model,
    clientLayer,
    /** The whole node graph, wired exactly as the old fixture wires it. Provide this to a test body. */
    layer,
    seed,
  }
}

/** Derived rather than declared, so the factory stays the single description of its own shape. */
export type RunnerHarness = ReturnType<typeof makeRunnerHarness>
