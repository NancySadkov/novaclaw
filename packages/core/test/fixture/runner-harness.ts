import { readFileSync } from "node:fs"
import { Effect, Layer, Schema, Stream } from "effect"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMError, type LLMRequest } from "@novaclaw/llm"
import { runBounded } from "./bounded"
import { asc, desc, eq } from "drizzle-orm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-compatible-chat"
import { Database } from "@novaclaw/core/database/database"
import { makeLocationNode } from "@novaclaw/core/effect/app-node"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNodePlatform } from "@novaclaw/core/effect/app-node-platform"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { EventTable } from "@novaclaw/core/event/sql"
import { PermissionV2 } from "@novaclaw/core/permission"
import { AbsolutePath, RelativePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { Snapshot } from "@novaclaw/core/snapshot"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionRunCoordinator } from "@novaclaw/core/session/run-coordinator"
import { SessionRunner } from "@novaclaw/core/session/runner"
import * as SessionRunnerLLM from "@novaclaw/core/session/runner/llm"
import { SessionMaintenance } from "@novaclaw/core/session/runner/maintenance"
import { SessionRunnerModel } from "@novaclaw/core/session/runner/model"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolPolicy } from "@novaclaw/core/tool-policy"
import { ToolPolicyGate } from "@novaclaw/core/tool-policy-gate"
import { ApplicationTools } from "@novaclaw/core/tool/application-tools"
import { AgentV2 } from "@novaclaw/core/agent"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { WorldMemory } from "@novaclaw/core/kb-graph/world-memory"
import type { ModelV2 } from "@novaclaw/core/model"
import { Config } from "@novaclaw/core/config"
import { ConfigCompaction } from "@novaclaw/core/config/compaction"
import { Tool } from "@novaclaw/core/tool/tool"
import {
  SessionCompactionTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@novaclaw/core/session/sql"
import { SessionHistory } from "@novaclaw/core/session/history"
import { isSteerText } from "@novaclaw/core/session/steer-provenance"
import { SessionStore } from "@novaclaw/core/session/store"
import { SystemContext } from "@novaclaw/core/system-context"
import { SystemContextRegistry } from "@novaclaw/core/system-context/registry"
import { SkillGuidance } from "@novaclaw/core/skill/guidance"
import { ReferenceGuidance } from "@novaclaw/core/reference/guidance"
import { Location } from "@novaclaw/core/location"
import { PluginV2 } from "@novaclaw/core/plugin"
import { Global } from "@novaclaw/core/global"

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
/**
 * One scripted turn: either a plain event list, or a Stream for the cases that need to PAUSE mid-turn.
 *
 * The stream form exists for a specific class of claim — tools must start as soon as their calls are
 * seen, before the turn has finished arriving. That is only expressible if the provider can emit some
 * events, block, and emit the rest; a static array always arrives complete and would let a runner that
 * waits for the whole turn pass a test about not waiting.
 */
export type ScriptedTurn = LLMEvent[] | Stream.Stream<LLMEvent, LLMError>

export interface RunnerScript {
  /**
   * Events the provider returns for the next interactive request, and for each request after it.
   *
   * 🔴 **A TURN THAT SAYS NOTHING COSTS YOU A TURN.** If a scripted turn produces no text and calls no
   * tool — a bare `stepStart`/`stepFinish`/`finish` — the runner correctly treats it as a no-op reply
   * and appends an automated re-ground nudge: an extra **`user`** message on the FOLLOWING request
   * ("Your last turn ended with no reply and no tool call…"), a `synthetic` transcript entry, and
   * usually one more provider request.
   *
   * ⚠️ **This has broken a claim in three separate families** (fragments, steering, step allowance),
   * always the same way: a request COUNT reads one too high, or a `toMatchObject` over a transcript
   * fails on length. Use `completeTurn` — or any turn that replies for real — unless the no-op IS the
   * thing under test. If you must assert over a transcript that contains one, filter BOTH the
   * `[Automated NovaClaw …]` user message and the `synthetic` entry; a role filter alone leaves the
   * first, a marker filter alone leaves the second.
   */
  turns?: ScriptedTurn[]
  /**
   * Register a real `read` tool alongside `echo` and `defect`.
   *
   * 🔴 **Opt-in, because two suites assert the advertised list VERBATIM** as `["echo", "defect"]`
   * (`session-runner-turn`, `session-runner-projection`). Registering a third tool unconditionally
   * would break claims that are about the registry, not about reading files.
   *
   * ⚠️ Exists because a drive can only be driven by the tool it watches. `runner/llm.ts` derives the
   * set from calls named `read`, so a suite with no such tool can only produce FAILING reads — which
   * happen to count today, and will not once `openedThisTurn` stops ignoring `call.failed`.
   */
  withReadTool?: boolean
  /** Events the out-of-band auto-title probe gets. Default: an empty stream, i.e. no title. */
  titleTurns?: LLMEvent[][]
  /** Events the out-of-band post-drain maintenance probes get. Default: an empty stream. */
  maintenanceTurns?: LLMEvent[][]
  /** Events the system-prompt-less utility passes get. Default: an empty stream. */
  utilityTurns?: LLMEvent[][]
  /** Events the bounded, system-prompt-less semantic tool-output summarizer gets. */
  toolSummaryTurns?: LLMEvent[][]
  /** A real OS-temp workspace for claims that execute Strict host actions. Default stays `/project`. */
  directory?: AbsolutePath
  /** Optional isolated instance-data root for claims that exercise retained tool artifacts. */
  dataRoot?: string
  /**
   * Enable a deterministic snapshot service and return these files at the start/end boundary.
   * Absent keeps the historical noop snapshot layer used by every normal-drain claim.
   */
  snapshotFiles?: readonly string[]
  /**
   * Pre-action policies to install for this drain (`tool-policy.ts`).
   *
   * The gate is built here either way — `ToolRegistry.node` depends on it — so this only decides
   * whether anything is INSTALLED. Absent means the gate consults nothing, which is what every other
   * claim in this suite wants and is also the shipped default for a folder that names no policy.
   */
  policies?: readonly ToolPolicy.Provider[]
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
  { channel: "utility", marker: "You are a completion auditor" },
] as const

/**
 * 🔴 **The COMPACTION SUMMARY carries no system prompt and IS real work.**
 *
 * `SessionCompaction` sends `LLM.request({ model, messages: [Message.user(prompt)], tools: [] })` —
 * no `system` at all. The positive rule below ("carries the agent system ⇒ interactive, else
 * out-of-band") therefore routed it to `utilityRequests` and handed it an empty stream, so the
 * summarizer produced nothing and the runner reported `compacted: false`.
 *
 * ⚠️ **That cost four iterations and generated seven hypotheses, every one about the PRODUCT** — the
 * model's limits, the keep window, the context baseline, config freezing (filed as a ruling-3
 * violation and retracted), the token guard. Instrumenting `compactAfterOverflow` settled it in one
 * run: `PAST GATE2 — publishing Started` with `promptTokens=661 limit=3950`. The compactor was
 * working perfectly and being starved by the fixture.
 * ⭐ **The lesson: "no system prompt" is not a synonym for "not part of the turn."** A request is
 * out-of-band because of what it IS, so the summary has to be recognised by name.
 */
const COMPACTION_SUMMARY_MARKER = "anchored summary"

/**
 * What the runner writes as a chronological System message when a context producer disappears.
 * Exported so a claim asserts against the fixture's own wording instead of re-typing it — a literal in
 * two places is a literal that will disagree with itself.
 */
export const SYSTEM_CONTEXT_REMOVED_MESSAGE = "System context source removed: test/harness-context"

/**
 * A one-shot latch: a promise and the function that opens it.
 *
 * ⚠️ **Deliberately a plain Promise rather than an Effect `Deferred`.** A `Deferred` can only be made
 * inside an Effect, which would force every gated claim to thread construction through its test body
 * before it can even describe the scenario. A latch can be created by the synchronous factory, handed
 * to the test, and awaited from inside an Effect with `Effect.promise` — so the gating machinery stays
 * out of the claim's way. The old fixture used `Deferred` and paid for it with six module-level
 * variables that every test had to reset.
 */
export interface Latch {
  readonly promise: Promise<void>
  readonly open: () => void
}

export const makeLatch = (): Latch => {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/** The session every harness seeds. Per-harness DB, so a fixed id cannot collide across tests. */
export const HARNESS_SESSION = SessionV2.ID.make("ses_harness")

/**
 * 🔴 **The isolation this whole fixture rests on is bought by ONE environment variable, and nothing
 * used to say so.** Every harness seeds the *same* session id, which is only safe because
 * `test/preload.ts` sets `NOVACLAW_DB=":memory:"` — `Database.node` resolves its filename once at
 * module load, so with a real file path every harness in the process would share one database **and one
 * `ses_harness` row**. Two tests would then see each other's messages, and it would present as a flaky
 * drain rather than as a configuration change: the second test's context would carry the first test's
 * turns, which reads exactly like the runner mis-projecting.
 *
 * Per ruling 1 an invariant whose violation compiles green ships with a mechanical check, so this
 * asserts rather than assumes. It is checked at harness construction — the moment before the assumption
 * would be relied on — and names the file to fix.
 */
function assertIsolationHolds() {
  const db = process.env["NOVACLAW_DB"]
  if (db !== ":memory:") {
    throw new Error(
      `runner-harness requires NOVACLAW_DB=":memory:" for per-test isolation, got ${JSON.stringify(db)}. ` +
        `Every harness seeds the same session id (${HARNESS_SESSION}); on a shared file database they ` +
        `would share one row. Set it in packages/core/test/preload.ts, or give each harness its own id.`,
    )
  }
}

/**
 * Build one harness. Call it INSIDE a test, never at module scope — module scope is how the shared
 * state got there in the first place.
 */
export function makeRunnerHarness(script: RunnerScript = {}) {
  assertIsolationHolds()
  const directory = script.directory ?? AbsolutePath.make("/project")
  const requests: LLMRequest[] = []
  const titleRequests: LLMRequest[] = []
  const maintenanceRequests: LLMRequest[] = []
  const utilityRequests: LLMRequest[] = []
  const toolSummaryRequests: LLMRequest[] = []
  /**
   * The world a test can change MID-RUN. Mutable, and deliberately so — a family of claims is about
   * context becoming unavailable, a producer being removed, or a baseline changing *between* turns, and
   * none of them is writable against construction-time config.
   *
   * ⚠️ This is per-HARNESS mutable state, which is not the pattern this rewrite exists to kill. The old
   * fixture's six MODULE-level variables were shared by all 77 tests and reset by hand in sixty places;
   * these belong to one harness, cannot be seen by another test, and have nothing to reset.
   */
  const controls = {
    systemBaseline: "Initial context",
    systemRemoved: false,
    systemUnavailable: false,
    /** When set, every tool execution BLOCKS on this latch until the test opens it. */
    toolGate: undefined as Latch | undefined,
    /** Opened once `toolsReady` executions are in flight at the same time. */
    toolsStarted: undefined as Latch | undefined,
    /** How many concurrent executions `toolsStarted` waits for. */
    toolsReady: 1,
    /**
     * The model resolution returns for a session that has not switched. Assign a `makeModel(...)` here
     * to run a claim against different limits.
     */
    currentModel: undefined as Model | undefined,
    /**
     * Run before every model resolution. A latch-await here lets a claim observe the window in which a
     * selection changes WHILE resolution is in flight — which is the only way to state that the turn
     * keeps the model it sampled rather than the newest one.
     */
    modelResolveHook: undefined as Effect.Effect<void> | undefined,
    /**
     * When set, model resolution FAILS with this instead of returning a model.
     *
     * ⚠️ Added because nothing could express it and a real claim needed it: the four pre-turn
     * assembly steps (config walk, agent select, context epoch, model resolve) surface their failure
     * as a Synthetic notice in the CHAT, and of the four this is the only one a test can make fail
     * on purpose — `agents.select` cannot fail at all, the config walk needs a corrupted parent
     * chain, and the context epoch's reachable failure lands on the untapped `initialize` probe
     * rather than the tapped `prepare`. See `session-runner-pre-turn-notice.test.ts`.
     */
    modelResolveFailure: undefined as SessionRunnerModel.Error | undefined,
    /** The CATALOG tier of the resolved model. `undefined` = unknown, which is the shipped default and
     *  what almost every hand-added local model reports. Set it to exercise anything that reads a
     *  tier — `TierScaffold`, and the role/model fit notice (`agent/model-fit.ts`). */
    modelTier: undefined as ModelV2.Tier | undefined,
    /**
     * When set, an INTERACTIVE provider stream signals `streamStarted` and then blocks on this latch
     * before emitting anything. That window — turn in flight, nothing emitted yet — is where steering
     * and queued input have to be observed.
     */
    streamGate: undefined as Latch | undefined,
    /** Opened when an interactive stream begins. Pair with `streamGate` to hold a turn open. */
    streamStarted: undefined as Latch | undefined,
    /** When set, the interactive stream FAILS with this instead of emitting its scripted turn. */
    streamFailure: undefined as LLMError | undefined,
    /**
     * Gate the COMPACTION SUMMARY request specifically.
     *
     * ⚠️ `streamGate` cannot do this. The summary runs on the no-agent-system path classified above, so
     * it never reaches the interactive gate — a claim that set `streamGate` and waited for the summary
     * to block would wait forever. Held open, this is what lets a claim interrupt mid-recovery.
     */
    summaryGate: undefined as Latch | undefined,
    /** Opened when the summary request begins. Pair with `summaryGate` to hold recovery open. */
    summaryStarted: undefined as Latch | undefined,
    /** When set, the out-of-band title request blocks until this latch opens. */
    titleGate: undefined as Latch | undefined,
    /** Opened when an out-of-band title request begins. Pair with `titleGate` for overlap claims. */
    titleStarted: undefined as Latch | undefined,
    /**
     * Run during every system-context LOAD. The agent-sampling claims need to change the world inside
     * that window — the point being that a switch landing mid-load must not retroactively change the
     * turn already assembling.
     */
    systemLoadHook: undefined as Effect.Effect<void> | undefined,
    /**
     * Per-agent skill guidance. Absent agent ⇒ no guidance, which is the default for every other claim.
     */
    skillBaselines: new Map<string, string>(),
    /**
     * Compaction settings, read on every `Config.entries()` call so a claim can change them mid-test.
     * The compaction family is about behaviour AT a threshold, so the threshold has to be reachable.
     */
    compactionBuffer: 3_000,
    compactionKeepTokens: 1_000,
    /**
     * Enable the real Strict router at drain entry. Off by default so the 77 normal-drain claims keep
     * describing that drain; the Strict contract test turns it on explicitly and therefore cannot
     * accidentally make the whole suite exercise a different engine.
     */
    strictEnabled: false,
    /**
     * The harness DRIVE switches (`config/harness-drives.ts`), read on every `Config.entries()` call.
     *
     * ⚠️ `undefined` means the key is ABSENT from config, which is the shipped default and must leave
     * every drive ON — a claim about the switch has to be able to assert both directions, and the
     * absent case is the one that would silently disable the product if `resolve` ever got its sign
     * wrong.
     */
    harnessDrives: undefined as { reground?: boolean; set?: boolean; children?: boolean } | undefined,
  }
  /**
   * Live tool-execution accounting. `maxActive` is the interesting one: it is the only way to assert
   * that tools ran CONCURRENTLY rather than one after another, which several claims are about and which
   * no assertion on results can distinguish.
   */
  const toolState = { active: 0, maxActive: 0 }
  /** Every `Tool.Context` the echo tool was invoked with — who authorised each execution. */
  const authorizations: Tool.Context[] = []
  const turns: ScriptedTurn[] = [...(script.turns ?? [])]
  const titleTurns = [...(script.titleTurns ?? [])]
  const maintenanceTurns = [...(script.maintenanceTurns ?? [])]
  const utilityTurns = [...(script.utilityTurns ?? [])]
  const toolSummaryTurns = [...(script.toolSummaryTurns ?? [])]
  /** Every tool input the echo tool was called with, in order. Per-harness, like everything else. */
  const executions: string[] = []

  const model = Model.make({ id: "harness-model", provider: "harness", route: OpenAIChat.route })
  /**
   * The model a session switches TO. Its id is `replacement` because that is what the runner keys on
   * when a `ModelSwitched` event names it — the switch is resolved per turn from the session row, not
   * captured once.
   */
  const replacementModel = Model.make({ id: "replacement", provider: "harness", route: OpenAIChat.route })
  /**
   * Build a model with explicit context/output limits.
   *
   * The compaction and overflow families are entirely about what happens at a limit, so they need a
   * model whose limits are small enough to reach deliberately. Exposed as a factory rather than a fixed
   * pair so a claim can state the number it depends on instead of inheriting someone else's.
   */
  const makeModel = (id: string, limits: { context: number; output: number }) =>
    Model.make({ id, provider: "harness", route: OpenAIChat.route.with({ limits }) })

  const clientLayer = Layer.succeed(
    LLMClient.Service,
    LLMClient.Service.of({
      prepare: () => Effect.die("the harness has no prepare path — a test that needs one should say so"),
      stream: ((request: LLMRequest) => {
        // Route the out-of-band passes off the interactive log FIRST — see OUT_OF_BAND above for why
        // this is correctness rather than bookkeeping.
        //
        // 🔴 ⚠️ **THE STRUCTURAL TEST COMES FIRST, AND MARKER MATCHING ALONE WAS NOT ENOUGH.** Measured
        // 2026-08-05: a third utility pass exists that carries **no system prompt at all** (`system`
        // empty, `tools` empty, one message). No marker can match an empty string, so it fell through
        // to the interactive log and **consumed the scripted turn** — leaving the real turn an empty
        // stream, so no assistant message was written and the claim failed with a context of one entry.
        // It is conditional on the prompt (`"Two blocks"` triggered it, `"Go"` did not), which is
        // exactly how it hid: probes passed and tests failed on the same script.
        //
        // So the discriminator is now POSITIVE — the interactive turn is the one carrying the agent's
        // system prompt — rather than a list of known utilities. A list of markers can only ever
        // recognise the probes somebody already knew about; this recognises the turn itself, and every
        // present and future utility pass falls out on the other side by construction.
        const parts = request.system ?? []
        // …unless it is the compaction summary, which IS the work.
        //
        // ⚠️ **This test used to be nested inside `parts.length === 0`**, on the reasoning that the
        // summary "carries no agent system". That stopped being true when compaction was wrapped in
        // `ReasoningBudget`, which prefixes one nudge line of its own — the summary then fell through
        // to the marker routing below, matched nothing, and a latch never opened. **The marker in the
        // MESSAGE is the durable discriminator**; the absence of a system part was an implementation
        // detail of the caller, which a fixture must not depend on.
        const isSummary = (request.messages ?? []).some((message) =>
          (message.content as ReadonlyArray<{ type: string; text?: string }> | undefined)?.some(
            (content) => content.type === "text" && (content.text ?? "").includes(COMPACTION_SUMMARY_MARKER),
          ),
        )
        const isToolSummary = (request.messages ?? []).some((message) =>
          (message.content as ReadonlyArray<{ type: string; text?: string }> | undefined)?.some(
            (content) =>
              content.type === "text" &&
              (content.text ?? "").includes("tool output being summarized") &&
              (content.text ?? "").includes("<tool-output>"),
          ),
        )
        // ⚠️ **HOISTED ABOVE the `parts.length === 0` gate, for the reason the compaction-summary note
        // above already gives: the MESSAGE is the durable discriminator and the absence of a system
        // prompt is an implementation detail of the caller.** The tool-output summarizer now runs
        // through `ShortAnswer.generate`, so it carries a system prompt (its own, plus whatever
        // `ReasoningBudget` prefixes) — under the old placement it stopped matching any marker and
        // fell into the INTERACTIVE log, consuming the scripted turn meant for the next real turn.
        if (isToolSummary) {
          toolSummaryRequests.push(request)
          return Stream.fromIterable(toolSummaryTurns.shift() ?? [])
        }
        if (parts.length === 0 || isSummary) {
          if (!isSummary) {
            utilityRequests.push(request)
            return Stream.fromIterable(utilityTurns.shift() ?? [])
          }
          requests.push(request)
          const summaryTurn = turns.shift()
          const summaryBody: Stream.Stream<LLMEvent, LLMError> = Array.isArray(summaryTurn)
            ? Stream.fromIterable(summaryTurn)
            : (summaryTurn ?? Stream.fromIterable([]))
          const summaryStarted = controls.summaryStarted
          const summaryGate = controls.summaryGate
          if (!summaryStarted && !summaryGate) return summaryBody
          return Stream.unwrap(
            Effect.gen(function* () {
              if (summaryStarted) summaryStarted.open()
              if (summaryGate) yield* Effect.promise(() => summaryGate.promise)
              return summaryBody
            }),
          )
        }
        const system = JSON.stringify(parts)
        const channel = OUT_OF_BAND.find((entry) => system.includes(entry.marker))?.channel
        if (channel === "title") {
          titleRequests.push(request)
          const body = Stream.fromIterable(titleTurns.shift() ?? [])
          const started = controls.titleStarted
          const gate = controls.titleGate
          if (!started && !gate) return body
          return Stream.unwrap(
            Effect.gen(function* () {
              if (started) started.open()
              if (gate) yield* Effect.promise(() => gate.promise)
              return body
            }),
          )
        }
        if (channel === "maintenance") {
          maintenanceRequests.push(request)
          return Stream.fromIterable(maintenanceTurns.shift() ?? [])
        }
        if (channel === "utility") {
          utilityRequests.push(request)
          return Stream.fromIterable(utilityTurns.shift() ?? [])
        }
        requests.push(request)
        // ⚠️ Gating and failure are applied ONLY here, on the interactive path — deliberately below the
        // out-of-band classification above. Blocking the title or maintenance probe on a steering gate
        // would deadlock a claim that has nothing to do with them.
        const gate = controls.streamGate
        const started = controls.streamStarted
        const failure = controls.streamFailure
        if (gate || started || failure) {
          const scripted = turns.shift()
          const body: Stream.Stream<LLMEvent, LLMError> = failure
            ? Stream.fail(failure)
            : Array.isArray(scripted)
              ? Stream.fromIterable(scripted)
              : (scripted ?? Stream.fromIterable([]))
          return Stream.unwrap(
            Effect.gen(function* () {
              if (started) started.open()
              if (gate) yield* Effect.promise(() => gate.promise)
              return body
            }),
          )
        }
        // Shift rather than index, so an exhausted script cannot replay its last response forever —
        // a replay looks like a working test right up until it loops.
        //
        // 🔴 ⚠️ AN EMPTY STREAM IS A FAULT, NOT AN ANSWER. Re-measured 2026-08-05 against the finished
        // harness: `[[]]` produces **one** request, and the runner now records a terminal assistant
        // failure ("The provider returned an empty response") — see the claim in
        // `session-runner-errors.test.ts`. Until that fix it produced one request and **nothing else**:
        // no assistant row, `Exit Success`, a transcript holding only the user message.
        //
        // ⚠️ An earlier version of this note claimed **three** requests. That number came from S2's
        // incomplete layer graph and was superseded by the re-measurement the same day; it survived
        // here because it had been written into a comment. Scripting nothing still does not mean "one
        // request and stop" — it means one request and a FAULT — so a claim asserting on a request
        // COUNT must still script a real response.
        const next = turns.shift()
        return Array.isArray(next) ? Stream.fromIterable(next) : (next ?? Stream.fromIterable([]))
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
          execute: ({ text }, toolContext) =>
            Effect.gen(function* () {
              authorizations.push(toolContext)
              executions.push(text)
              toolState.active++
              toolState.maxActive = Math.max(toolState.maxActive, toolState.active)
              if (toolState.active === controls.toolsReady && controls.toolsStarted) {
                controls.toolsStarted.open()
              }
              const gate = controls.toolGate
              if (gate) yield* Effect.promise(() => gate.promise)
              return { text }
            }).pipe(Effect.ensuring(Effect.sync(() => void toolState.active--))),
        }),
        // Registered in this order on purpose: claims about the advertised tool list assert
        // `["echo", "defect"]` verbatim, so the registry's order is part of what is being ported.
        defect: Tool.make({
          description: "Fail unexpectedly",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die("unexpected tool defect"),
        }),
        // ⚠️ Spread LAST so the two suites asserting `["echo", "defect"]` see exactly that when the
        // opt-in is off — order is part of what those claims pin.
        ...(script.withReadTool !== true
          ? {}
          : {
              read: Tool.make({
                description: "Read a file",
                input: Schema.Struct({ path: Schema.String }),
                output: Schema.Struct({ text: Schema.String }),
                toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
                // Deliberately thin: this exists so a `read` call can SUCCEED, and a real read is the
                // only way to distinguish that from one that failed. A missing file fails, which is
                // exactly the case the set drive's accounting has to tell apart.
                execute: ({ path: target }) =>
                  // ⚠️ A `ToolFailure`, not a bare Error. That is what makes the projected part carry
                  // `status: "error"` — and therefore what makes `call.failed` true for the drives
                  // that read it. An `Effect.die` or a plain Error is a different outcome entirely.
                  Effect.try({
                    try: () => ({ text: readFileSync(target, "utf8") }),
                    catch: (cause) => new Tool.Failure({ message: `read failed: ${String(cause)}` }),
                  }),
              }),
            }),
      }),
    ),
  )
  const echoNode = makeLocationNode({ name: "test/runner-harness-tools", layer: echo, deps: [ToolRegistry.node] })

  const policies = Layer.effectDiscard(
    Effect.gen(function* () {
      if (!script.policies?.length) return
      const gate = yield* ToolPolicyGate.Service
      yield* gate.install(script.policies).pipe(Effect.orDie)
    }),
  )
  const policyNode = makeLocationNode({
    name: "test/runner-harness-policies",
    layer: policies,
    deps: [ToolPolicyGate.node],
  })

  const models = SessionRunnerModel.layerWith(
    (session) =>
      Effect.gen(function* () {
        const hook = controls.modelResolveHook
        if (hook) yield* hook
        if (controls.modelResolveFailure) return yield* Effect.fail(controls.modelResolveFailure)
        // Keyed on the SESSION's model id, so a `ModelSwitched` event actually changes what resolves.
        if (session.model?.id === "replacement") return replacementModel
        return controls.currentModel ?? model
      }),
    // ⚠️ Read through `controls` on every call rather than captured, like every other control here:
    // a test that changes the tier mid-run is exactly the shape the fit notice is about.
    () => Effect.succeed(controls.modelTier),
  )

  const systemContextKey = SystemContext.Key.make("test/harness-context")
  const systemContext = Layer.effectDiscard(
    SystemContextRegistry.Service.pipe(
      Effect.flatMap((registry) =>
        registry.register({
          key: systemContextKey,
          // Read through `controls` on EVERY load, so a test can change the world mid-run — which a
          // whole family of claims is about (context becoming unavailable, a producer being removed, a
          // baseline changing). Capturing the values here instead would make those claims unwritable.
          load: Effect.sync(() =>
            SystemContext.combine(
              controls.systemRemoved
                ? []
                : [
                    SystemContext.make({
                      key: systemContextKey,
                      codec: Schema.toCodecJson(Schema.String),
                      load: Effect.gen(function* () {
                        const hook = controls.systemLoadHook
                        if (hook) yield* hook
                        return controls.systemUnavailable ? SystemContext.unavailable : controls.systemBaseline
                      }),
                      baseline: String,
                      update: (_previous, current) => current,
                      removed: () => SYSTEM_CONTEXT_REMOVED_MESSAGE,
                    }),
                  ],
            ),
          ),
        }),
      ),
    ),
  ).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))

  const skillGuidance = Layer.mock(SkillGuidance.Service, {
    load: (agent: { id: string }) =>
      Effect.succeed(
        controls.skillBaselines.has(agent.id)
          ? SystemContext.make({
              key: SystemContext.Key.make("test/skill-guidance"),
              codec: Schema.toCodecJson(Schema.String),
              load: Effect.succeed(controls.skillBaselines.get(agent.id)!),
              baseline: String,
              update: (_previous, current) => current,
              removed: () => "Skill guidance removed",
            })
          : SystemContext.empty,
      ),
  })
  const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })

  const snapshotCaptures: Snapshot.ID[] = []
  const snapshotFiles = script.snapshotFiles?.map((file) => RelativePath.make(file))
  const snapshotLayer =
    snapshotFiles === undefined
      ? Snapshot.noopLayer
      : Layer.succeed(
          Snapshot.Service,
          Snapshot.Service.of({
            capture: () =>
              Effect.sync(() => {
                const id = Snapshot.ID.make(`snapshot_${snapshotCaptures.length + 1}`)
                snapshotCaptures.push(id)
                return id
              }),
            files: () => Effect.succeed(snapshotFiles),
            // Post-run maintenance reads the same boundary to refresh the Changes summary. Empty is
            // enough here: this fake owns boundary propagation, not Git's diff implementation.
            diff: () => Effect.succeed([]),
            read: () => Effect.die("runner-harness snapshot.read is unused"),
            preview: () => Effect.die("runner-harness snapshot.preview is unused"),
            restore: () => Effect.die("runner-harness snapshot.restore is unused"),
            checkout: () => Effect.die("runner-harness snapshot.checkout is unused"),
          }),
        )

  const permission = Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      assert: () => Effect.die("unused"),
      ask: () => Effect.die("unused"),
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
                buffer: controls.compactionBuffer,
                keep: new ConfigCompaction.Keep({ tokens: controls.compactionKeepTokens }),
              }),
              ...(controls.strictEnabled ? { strict: { enabled: true } } : {}),
              ...(controls.harnessDrives === undefined ? {} : { harness_drives: controls.harnessDrives }),
            }),
          }),
        ]),
    }),
  )

  const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
    [Snapshot.node, snapshotLayer],
    [LayerNodePlatform.llmClient, clientLayer],
    [SessionRunnerModel.node, models],
    [SystemContextRegistry.node, systemContext],
    [Location.node, Location.boundNode({ directory })],
    [SkillGuidance.node, skillGuidance],
    [ReferenceGuidance.node, referenceGuidance],
    [PermissionV2.node, permission],
    [Config.node, config],
    ...(script.dataRoot === undefined ? [] : ([[Global.node, Global.layerWith({ data: script.dataRoot })]] as const)),
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
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      echoNode,
      policyNode,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      PluginV2.node,
      // Exposed so a test can SETTLE detached memory organisation. It was already built as a
      // dependency of the runner; listing it only makes the service reachable, which is what the
      // post-drain ratchet needs now that the memory pass no longer blocks the drain.
      // ⚠️ Listed EXPLICITLY though the runner already pulls it in transitively: a node reached only
      // through a dependency is not resolvable from `seed`, and `seed` is where the memory store has
      // to be tidied. Same node object, so the graph builds one store either way (`LayerNode` memoizes
      // on identity).
      Memory.node,
      // The runner's automatic recall/extraction is a separate graph from the explicit KB. Expose it
      // to the seed so the shared test home cannot leak compacted chats or extracted facts between
      // harnesses either.
      WorldMemory.node,
      // Exposed for the same reason as `Memory.node` above and with the same effect: the runner
      // already pulls it in transitively, and `LayerNode` memoizes on identity, so listing it builds
      // one scheduler either way. A claim about WHEN the device slot is charged and released has to
      // reach the service the runner is actually calling.
      SessionScheduler.node,
      SessionMaintenance.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, clientLayer],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, snapshotLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
      ...(script.dataRoot === undefined ? [] : ([[Global.node, Global.layerWith({ data: script.dataRoot })]] as const)),
    ],
  )

  /**
   * Seed the session row. The old fixture's `setup` did this plus sixty resets; here the resets do not
   * exist, so seeding is all that is left.
   */
  /** Seed any session row. Claims about two sessions at once need more than the default one. */
  const seedSession = (id: SessionV2.ID) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({ id, slug: id, directory, title: "test", version: "test" })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })

  const seed = Effect.gen(function* () {
    // This fixture builds the PluginV2 service but deliberately omits PluginInternal: its synthetic
    // world supplies the agent/model/tool state directly, so booting the product's built-in plugins
    // would replace the state the claims are trying to control. PluginInternal is also the production
    // owner of the initial-boot latch. Open that latch explicitly here so SessionRunner can enforce
    // "permissions are materialized before the first turn" without making this intentionally partial
    // graph wait for a boot component it does not contain.
    const plugins = yield* PluginV2.Service
    yield* plugins.markReady
    yield* seedSession(HARNESS_SESSION)
    // 🔴 **THE OTHER HALF OF THE ISOLATION `assertIsolationHolds` ONLY BUYS FOR SQLITE.**
    // `NOVACLAW_DB=":memory:"` gives every harness its own database. The MEMORY GRAPH is a different
    // store: `test/preload.ts` points `NOVACLAW_HOME` at a PID-scoped directory, which isolates it
    // from the developer's real instance but SHARES it across every test in the process.
    //
    // That is a real cross-test channel. Measured 2026-08-22: a whole-unit `core` run failed
    // `hosted tool results > replays durable provider-executed tool results` because
    // `session-runner-compaction.test.ts` runs first, compaction writes the compressed transcript
    // into the agent's memory scope as passages (`session/compaction-archive.ts`), and the next
    // harness's auto-recall found them and put a fourth message in the request. Bisected to that
    // exact pair; neither file fails alone. It passed under SHARDING — separate processes, separate
    // homes — so the gate went green whenever memory pressure made the runner shard and red whenever
    // the machine had room. A suite whose result depends on how much RAM is free is not a signal.
    //
    // ⚠️ Clears the three scopes auto-recall actually searches (`SessionRecall.recallScopes`), never
    // the whole store: a test that seeds a memory and then builds a harness is doing so deliberately,
    // and wiping everything would break it in a way that looks like the feature failing.
    //
    // ⚠️ **The scopes are DERIVED from the store, not hand-listed.** The previous version cleared
    // `agent:${AgentV2.defaultID}` — and `defaultID` is `build`, while a harness session actually runs
    // as **nova**, so compaction's archived passages sat in `agent:nova` and were never touched. The
    // leak this whole comment describes therefore still happened, silently, for four days. A list of
    // scopes kept by hand beside a value that decides them is the same defect twice; ask the store.
    const memory = Memory.client(yield* Memory.node.service)
    const resident = yield* memory
      .list({ limit: 500 })
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ scope: string }>))
    const world = WorldMemory.client(yield* WorldMemory.node.service)
    const worldResident = yield* world
      .list({ limit: 500 })
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ scope: string }>))
    const searched = (scope: string) =>
      scope === "global" || scope === `session:${HARNESS_SESSION}` || scope.startsWith("agent:")
    for (const scope of new Set(resident.map((m) => m.scope).filter(searched)))
      yield* memory.clearScope(scope).pipe(Effect.ignore)
    for (const scope of new Set(worldResident.map((m) => m.scope).filter(searched)))
      yield* world.clearScope(scope).pipe(Effect.ignore)
  })

  /**
   * The canonical prefix a compaction would replace: `{ prefixSeq, prefixHash }` for the session as it
   * stands right now. A `Compaction.Ended` event must carry these, and they cannot be invented — the
   * hash is checked against the messages the summary claims to replace.
   */
  const currentPrefix = Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db
      .select({ seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, HARNESS_SESSION))
      .orderBy(desc(SessionMessageTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    const prefixSeq = row?.seq ?? 0
    return { prefixSeq, prefixHash: yield* SessionHistory.prefixHash(db, HARNESS_SESSION, prefixSeq) }
  })

  /**
   * Rebuild a session's messages FROM ITS EVENTS ALONE — drop the projected rows, then replay.
   *
   * ⭐ This is how a claim proves a projection is **derivable rather than incidental**: if replaying the
   * recorded events does not reproduce the same transcript, then some state reached the messages table
   * without going through an event, and the session is not actually rebuildable. Several claims assert
   * exactly that, which is why it lives here rather than being re-typed per file.
   */
  const replayProjection = (id: SessionV2.ID) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const recorded = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)

      yield* events.remove(id)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, id)).run().pipe(Effect.orDie)
      yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).run().pipe(Effect.orDie)
      // ⚠️ Compaction rows are PROJECTED state too, and forgetting them makes replay fail on a
      // compacted session rather than merely differ: `session_compaction` has a unique
      // (session_id, seq) index, so replaying the Compaction event re-inserts and the query throws.
      // Found 2026-08-05 by the first ported claim that compacts and then replays.
      yield* db.delete(SessionCompactionTable).where(eq(SessionCompactionTable.session_id, id)).run().pipe(Effect.orDie)
      yield* events.replayAll(
        recorded.map((event) => ({
          id: event.id,
          aggregateID: event.aggregate_id,
          seq: event.seq,
          type: event.type,
          data: event.data,
        })),
      )
    })

  return {
    /** Every interactive request the drain issued, in order. Per-harness: another test cannot append. */
    requests,
    /** Requests the out-of-band auto-title probe issued. Kept off `requests` on purpose. */
    titleRequests,
    /** Requests post-drain maintenance (memory extraction) issued. Also kept off `requests`. */
    maintenanceRequests,
    /** Utility passes that carry NO system prompt. The class a marker list cannot recognise. */
    utilityRequests,
    /** Bounded map/reduce calls made specifically for oversized tool-output summaries. */
    toolSummaryRequests,
    /** Snapshot ids minted in capture order; empty unless `snapshotFiles` enabled the fake service. */
    snapshotCaptures,
    /** Text the echo tool was asked to echo, in call order. */
    executions,
    /** Every context the echo tool was invoked with — the authorisation trail. */
    authorizations,
    /** Live execution accounting; `maxActive` proves concurrency, which results alone cannot. */
    toolState,
    model,
    replacementModel,
    makeModel,
    clientLayer,
    /** The whole node graph, wired exactly as the old fixture wires it. Provide this to a test body. */
    layer,
    seed,
    seedSession,
    replayProjection,
    currentPrefix,
    controls,
  }
}

/**
 * The text of a request's messages for one role. Lives here because claims across several files assert
 * on it, and a helper re-typed per file is a helper that will disagree with itself.
 *
 * ⚠️ RAW — it includes the harness's own tail injections. Use `userTexts` for a claim about the
 * conversation; use this one only when the injection IS the subject.
 */
export const messageTexts = (request: LLMRequest, role: "user" | "system") =>
  request.messages.flatMap((message) =>
    message.role === role ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : [],
  )

/**
 * A message NovaClaw appended to the request tail rather than one the conversation produced.
 *
 * Three of them ride the tail as `user`-role messages — project grounding, auto-recall and the todo
 * reminder — and every one carries the 1N provenance prefix precisely so that nothing downstream
 * mistakes it for the user speaking (`session/steer-provenance.ts`). The helpers below use the
 * shipped predicate rather than matching text, so a change to the prefix cannot make them lie.
 *
 * ⚠️ **This is why they are filtered rather than written into every expectation.** When cadence
 * project grounding landed (`03a5fb4e4`) it appended one such message to the first turn of every
 * session, and seventeen claims about orphan recovery, promotion, steering order and compaction went
 * red — none of which is a claim about grounding. A claim that IS about the tail belongs in
 * `session-runner-grounding.test.ts`, which asserts the cadence directly.
 */
export const isHarnessInjected = (message: LLMRequest["messages"][number]) =>
  message.role === "user" &&
  message.content.length > 0 &&
  message.content.every((content) => content.type === "text" && isSteerText(content.text))

/** The request's messages with the harness's own tail injections removed. */
export const conversation = (request: LLMRequest) => request.messages.filter((message) => !isHarnessInjected(message))

/** The roles of the conversation's messages, in order — injections excluded. */
export const messageRoles = (request: LLMRequest) => conversation(request).map((message) => message.role)

/** The user's OWN texts: what the conversation contributed, never what the harness appended. */
export const userTexts = (request: LLMRequest) =>
  conversation(request).flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
      : [],
  )

export const systemTexts = (request: LLMRequest) => messageTexts(request, "system")

/** Derived rather than declared, so the factory stays the single description of its own shape. */
export type RunnerHarness = ReturnType<typeof makeRunnerHarness>

/**
 * The canonical complete turn — the same shape the old suite's `fragmentFixture("text")` produces.
 * Lives here rather than in each ported file so the ported claims cannot drift apart on what "a normal
 * provider response" means.
 */
export const completeTurn = (id: string, text: string): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

/**
 * Seed the session, run `body` against the harness graph, and bound the whole thing against a hang.
 *
 * ⚠️ **Every ported case goes through this.** The bound is the half of S2's ruling that survived
 * undiluted: a wedged case must fail by name rather than stall the suite. The 60 s is a HANG bound, not
 * a latency budget — a ~19-node graph is built per case and the first pays for module init — so a case
 * that trips it is wedged, not slow.
 */
export const drive = <A, E>(harness: RunnerHarness, body: Effect.Effect<A, E, any>, label: string) =>
  runBounded(
    Effect.gen(function* () {
      yield* harness.seed
      const result = yield* body
      /**
       * Settle DETACHED memory organisation before the scope closes.
       *
       * `postRun` no longer awaits memory extraction — owner ruling 2026-08-12: it must not delay
       * the reply, and the facts are still in the session's context anyway. A test reading
       * `maintenanceRequests` the instant the drain returns would race the pass, and — worse —
       * `Effect.scoped` below would INTERRUPT it, so the count would read 0 for work that was
       * cancelled rather than skipped.
       *
       * ⚠️ Here rather than per-test, so the OUT_OF_BAND exhaustiveness ratchet keeps working for
       * every driven test instead of only the ones that remembered to wait.
       */
      yield* (yield* SessionMaintenance.Service).settleMemory
      return result
    }).pipe(Effect.scoped, Effect.provide(harness.layer)) as unknown as Effect.Effect<A, E, never>,
    { ms: 60_000, label },
  )
