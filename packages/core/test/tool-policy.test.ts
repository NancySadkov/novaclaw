import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { ProjectFile } from "@novaclaw/schema/project-file"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { ProjectFileCache } from "@novaclaw/core/project-file-cache"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionReceipt } from "@novaclaw/core/session/receipt"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionExecutionTable, SessionTable } from "@novaclaw/core/session/sql"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { ToolPolicy } from "@novaclaw/core/tool-policy"
import { ToolPolicyBuiltin } from "@novaclaw/core/tool-policy-builtin"
import { ToolPolicyGate } from "@novaclaw/core/tool-policy-gate"
import { SessionPolicyDecisionTable } from "@novaclaw/core/tool-policy.sql"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { Tool } from "@novaclaw/core/tool/tool"
import { Tools } from "@novaclaw/core/tool/tools"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { toolIdentity } from "./lib/tool"

/**
 * `` → **Typed pre-action policies**, the SEAM.
 *
 * 🔴 Every case here goes through `ToolRegistry.materialize().settle(…)` — the same function the
 * runner calls for every model tool call — against a tool that really executes and really returns.
 * Composition is proved as algebra next door (`tool-policy-compose.test.ts`); this file proves the
 * six outcomes reach a real call, that the receipt exists before the tool runs, and that a
 * `novaclaw.json` cannot buy an author anything but an id.
 *
 * ⚠️ **The A/B for this file, performed rather than described.** Delete the `policies.screen(…)`
 * block in `tool/registry.ts`'s `settleRaw` and every case below except the two `novaclaw.json`
 * schema cases goes red. Results are in the report.
 */

const sessionID = SessionV2.ID.make("ses_policy")
const agent = AgentV2.ID.make("build")

/** A real tool: registered through the real registry, and it really runs. */
const echo = Tool.make({
  description: "Echo a command back",
  input: Schema.Struct({ command: Schema.String }),
  output: Schema.Struct({ ran: Schema.String }),
  execute: ({ command }) => Effect.succeed({ ran: command }),
  toModelOutput: ({ output }) => [{ type: "text", text: `ran: ${output.ran}` }],
})

/** A tool with no `toModelOutput`, so its result is STRUCTURED — the case a note must not destroy. */
const structured = Tool.make({
  description: "Return a structured value",
  input: Schema.Struct({ command: Schema.String }),
  output: Schema.Struct({ ran: Schema.String }),
  execute: ({ command }) => Effect.succeed({ ran: command }),
})

const assertions: PermissionV2.AssertInput[] = []
let approvalOutcome: PermissionV2.Error | undefined

const permissionStub = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.gen(function* () {
        assertions.push(input)
        if (approvalOutcome) yield* Effect.fail(approvalOutcome)
      }),
    ask: () => Effect.die("unused"),
  }),
)

/**
 * The real graph, one directory at a time.
 *
 * ⚠️ Compiled PER TEST rather than once, because `ProjectFileCache` is keyed by directory with a
 * one-second TTL: sharing an instance across tests would let one test's `novaclaw.json` answer for
 * the next one's folder. A fresh compile is also a fresh in-memory database, which is what makes the
 * receipt assertions below statements about THIS call.
 */
const graph = (directory: string) =>
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      ProjectFileCache.node,
      SessionReceipt.node,
      ToolPolicyGate.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
    ]),
    [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
      [PermissionV2.node, permissionStub],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  )

interface Harness {
  readonly registry: ToolRegistry.Interface
  readonly gate: ToolPolicyGate.Interface
  readonly directory: string
}

/** Run `body` against a real graph rooted at a fresh temp folder, with `echo` registered. */
function withHarness<A>(
  // `any` in E and R deliberately: a body reaches whatever the graph provides, and pinning the exact
  // union here would make every test edit a signature edit. `orDie` below keeps a real failure loud.
  body: (harness: Harness) => Effect.Effect<A, any, any>,
  options: { readonly project?: Record<string, unknown> | string } = {},
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (held) => Effect.promise(() => held[Symbol.asyncDispose]()),
      )
      assertions.length = 0
      approvalOutcome = undefined
      if (options.project)
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(tmp.path, "novaclaw.json"),
            typeof options.project === "string" ? options.project : JSON.stringify(options.project, null, 2),
          ),
        )
      return yield* Effect.gen(function* () {
        const tools = yield* Tools.Service
        yield* tools.register({ echo, structured }).pipe(Effect.orDie)
        const { db } = yield* Database.Service
        // A real session row, because the gate resolves the project from the SESSION's folder.
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            slug: "policy",
            directory: tmp.path,
            title: "policy",
            version: "test",
            agent: "build",
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        return yield* body({
          registry: yield* ToolRegistry.Service,
          gate: yield* ToolPolicyGate.Service,
          directory: tmp.path,
        }).pipe(Effect.orDie)
      }).pipe(Effect.provide(graph(tmp.path))) as Effect.Effect<A, never, never>
    }).pipe(Effect.scoped),
  )
}

const call = (registry: ToolRegistry.Interface, input: { command: string }, name = "echo", id = "call-policy") =>
  registry
    .materialize([], () => true, new Set([name]))
    .pipe(
      Effect.flatMap((materialized) =>
        materialized.settle({ sessionID, ...toolIdentity, agent, call: { type: "tool-call", id, name, input } }),
      ),
    )

const provider = (id: string, outcome: ToolPolicy.Outcome, extra: Partial<ToolPolicy.Provider> = {}) =>
  ({ id, describe: id, evaluate: () => Effect.succeed(outcome), ...extra }) satisfies ToolPolicy.Provider

const receipts = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return yield* db.select().from(SessionPolicyDecisionTable).all().pipe(Effect.orDie)
})

const resultText = (result: { readonly type: string; readonly value: unknown }) =>
  typeof result.value === "string" ? result.value : JSON.stringify(result.value)

describe("the six outcomes, each reaching a real tool call", () => {
  test("allow — the tool runs untouched and NO receipt row is written", async () => {
    const rows = await withHarness(({ registry, gate }) =>
      Effect.gen(function* () {
        yield* gate.install([provider("quiet", { type: "allow" })]).pipe(Effect.orDie)
        const settlement = yield* call(registry, { command: "hello" })
        expect(settlement.result).toEqual({ type: "text", value: "ran: hello" })
        expect(settlement.halted).toBeUndefined()
        return yield* receipts
      }).pipe(Effect.scoped),
    )
    // The absence of a row is a POSITIVE statement — every installed policy allowed this call, in
    // time — which is only sound because the unavailable case below does write one.
    expect(rows).toEqual([])
  })

  test("deny — the tool does NOT run, the model is told why, and the row exists", async () => {
    const { settlement, rows } = await withHarness(({ registry, gate }) =>
      Effect.gen(function* () {
        yield* gate
          .install([provider("no-secrets", { type: "deny", reason: "this touches a credential store" })])
          .pipe(Effect.orDie)
        const settlement = yield* call(registry, { command: "cat ~/.aws/credentials" })
        return { settlement, rows: yield* receipts }
      }).pipe(Effect.scoped),
    )
    expect(settlement.result.type).toBe("error")
    // The tool never ran: its own output would have been `ran: …`.
    expect(resultText(settlement.result)).not.toContain("ran: ")
    expect(resultText(settlement.result)).toContain("this touches a credential store")
    expect(resultText(settlement.result)).toContain("no-secrets")
    expect(settlement.halted).toBeUndefined()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: "deny", tool: "echo", tool_call_id: "call-policy" })
    expect(rows[0]?.providers).toEqual([
      { id: "no-secrets", outcome: "deny", detail: "this touches a credential store" },
    ])
  })

  test("halt — the call is refused AND the settlement carries the drain latch", async () => {
    const settlement = await withHarness(({ registry, gate }) =>
      Effect.gen(function* () {
        yield* gate
          .install([provider("stop-now", { type: "halt", reason: "the operator revoked this session" })])
          .pipe(Effect.orDie)
        return yield* call(registry, { command: "anything" })
      }).pipe(Effect.scoped),
    )
    expect(settlement.halted).toBe(true)
    // ⚠️ The wording has to differ from a deny's, or a model told "refused" keeps working.
    expect(resultText(settlement.result)).toContain("HALT")
    expect(resultText(settlement.result)).toContain("Do not call another tool")
  })

  test("patch — the tool runs with the REWRITTEN arguments, and is told so", async () => {
    const { settlement, rows } = await withHarness(({ registry, gate }) =>
      Effect.gen(function* () {
        yield* gate
          .install([
            provider("rewriter", {
              type: "patch",
              fields: { command: "git --no-pager log" },
              reason: "the pager would have wedged this shell",
            }),
          ])
          .pipe(Effect.orDie)
        const settlement = yield* call(registry, { command: "git log" })
        return { settlement, rows: yield* receipts }
      }).pipe(Effect.scoped),
    )
    // 🔴 The proof that the patch was APPLIED and not merely composed: the tool echoes what it ran.
    expect(resultText(settlement.result)).toContain("ran: git --no-pager log")
    // 🔴 And the proof it was not silent — the item's own clause about a rewrite the model is not
    // told about.
    expect(resultText(settlement.result)).toContain("the pager would have wedged this shell")
    expect(rows[0]).toMatchObject({ decision: "patch" })
    expect(rows[0]?.patched).toEqual({ command: "git --no-pager log" })
  })

  test("context — the tool runs unchanged and the note rides its result", async () => {
    const settlement = await withHarness(({ registry, gate }) =>
      Effect.gen(function* () {
        yield* gate
          .install([provider("noticer", { type: "context", text: "this ran as administrator" })])
          .pipe(Effect.orDie)
        return yield* call(registry, { command: "whoami" })
      }).pipe(Effect.scoped),
    )
    expect(resultText(settlement.result)).toContain("ran: whoami")
    expect(resultText(settlement.result)).toContain("this ran as administrator")
  })

  test("approve — the EXISTING permission ask is spent, with minimumEffect ask", async () => {
    const settlement = await withHarness(({ registry, gate }) =>
      Effect.gen(function* () {
        yield* gate
          .install([
            provider("gatekeeper", {
              type: "approve",
              action: "irreversible_shell",
              resources: ["git push --force"],
              reason: "a force push can discard remote commits",
            }),
          ])
          .pipe(Effect.orDie)
        return yield* call(registry, { command: "git push --force" })
      }).pipe(Effect.scoped),
    )
    // 🔴 Reuse, proved by the shape of the call: `minimumEffect: "ask"` is the field that already
    // exists for "require at least this verdict", so nothing about consent cards is re-derived here.
    expect(assertions).toHaveLength(1)
    expect(assertions[0]).toMatchObject({
      sessionID,
      action: "irreversible_shell",
      resources: ["git push --force"],
      minimumEffect: "ask",
    })
    expect(assertions[0]?.metadata).toMatchObject({ policyID: "gatekeeper", tool: "echo" })
    expect(resultText(settlement.result)).toContain("ran: git push --force")
  })

  test("approve — a policy denial stops the call and the receipt records a deny", async () => {
    const { settlement, rows } = await withHarness(({ registry, gate }) =>
      Effect.gen(function* () {
        approvalOutcome = new PermissionV2.DeniedError({ rules: [] })
        yield* gate
          .install([
            provider("gatekeeper", {
              type: "approve",
              action: "irreversible_shell",
              resources: ["rm -rf build"],
              reason: "this is not reversible",
            }),
          ])
          .pipe(Effect.orDie)
        const settlement = yield* call(registry, { command: "rm -rf build" })
        return { settlement, rows: yield* receipts }
      }).pipe(Effect.scoped),
    )
    expect(settlement.result.type).toBe("error")
    expect(resultText(settlement.result)).not.toContain("ran: ")
    expect(resultText(settlement.result)).toContain("Permission denied")
    expect(rows[0]).toMatchObject({ decision: "deny" })
    expect(rows[0]?.detail).toContain("gatekeeper")
  })
})

describe("determinism at the seam", () => {
  const outcomes: readonly (readonly [string, ToolPolicy.Outcome])[] = [
    ["a-context", { type: "context", text: "note" }],
    ["b-patch", { type: "patch", fields: { command: "patched" }, reason: "rewritten" }],
    ["c-allow", { type: "allow" }],
    ["d-approve", { type: "approve", action: "act", resources: ["r"], reason: "ask" }],
  ]

  /**
   * ⚠️ Providers are installed in a shuffled order AND finish in a shuffled order — a delay per
   * provider, chosen so the completion order is the reverse of the installation order on one run
   * and neither on the next. Shuffling only the installation order would leave the real hazard
   * (`Effect.forEach` returning results in input order regardless of completion) untested.
   */
  const shuffledRun = (installOrder: readonly number[], delays: readonly number[]) =>
    withHarness(({ registry, gate }) =>
      Effect.gen(function* () {
        yield* gate
          .install(
            installOrder.map((index) => {
              const [id, outcome] = outcomes[index]!
              return {
                id,
                describe: id,
                evaluate: () => Effect.sleep(`${delays[index]!} millis`).pipe(Effect.as(outcome)),
              }
            }),
          )
          .pipe(Effect.orDie)
        const settlement = yield* call(registry, { command: "original" })
        const rows = yield* receipts
        return { text: resultText(settlement.result), row: rows[0] }
      }).pipe(Effect.scoped),
    )

  test("shuffling installation AND completion order yields an identical decision and receipt", async () => {
    const forward = await shuffledRun([0, 1, 2, 3], [1, 2, 3, 4])
    const reversed = await shuffledRun([3, 2, 1, 0], [4, 3, 2, 1])
    const scrambled = await shuffledRun([2, 0, 3, 1], [3, 1, 4, 2])
    for (const other of [reversed, scrambled]) {
      expect(other.text).toBe(forward.text)
      expect(other.row?.decision).toBe(forward.row!.decision)
      expect(other.row?.providers).toEqual(forward.row!.providers)
      expect(other.row?.patched).toEqual(forward.row!.patched)
    }
    // And it is the RIGHT decision, not merely a stable one: approve outranks patch, the patch is
    // still applied, and the ledger lists every provider in id order.
    expect(forward.row?.decision).toBe("approve")
    expect(forward.text).toContain("ran: patched")
    expect((forward.row?.providers ?? []).map((entry) => entry.id)).toEqual([
      "a-context",
      "b-patch",
      "c-allow",
      "d-approve",
    ])
  })

  test("deny wins over every other outcome at the seam, in both installation orders", async () => {
    for (const order of [
      [0, 1, 2, 3, 4],
      [4, 3, 2, 1, 0],
    ]) {
      const settlement = await withHarness(({ registry, gate }) =>
        Effect.gen(function* () {
          const all: ToolPolicy.Provider[] = [
            provider("p1-allow", { type: "allow" }),
            provider("p2-context", { type: "context", text: "note" }),
            provider("p3-patch", { type: "patch", fields: { command: "patched" }, reason: "r" }),
            provider("p4-approve", { type: "approve", action: "act", resources: ["r"], reason: "ask" }),
            provider("p5-deny", { type: "deny", reason: "no" }),
          ]
          yield* gate.install(order.map((index) => all[index]!)).pipe(Effect.orDie)
          return yield* call(registry, { command: "original" })
        }).pipe(Effect.scoped),
      )
      expect(settlement.result.type).toBe("error")
      expect(resultText(settlement.result)).not.toContain("ran: ")
      // The approval must not have been spent for a call that was denied anyway.
      expect(assertions).toHaveLength(0)
    }
  })
})

describe("a provider that does not answer", () => {
  /**
   * ⚠️ `Effect.never`, driven by the REAL clock rather than a `TestClock` advance. A test that
   * advanced a virtual clock past the budget would prove the timeout combinator works and nothing
   * about whether the budget is reachable; this waits the real five seconds, which is also the
   * measurement that the bound is what the module says it is.
   */
  test("a hanging SAFETY-CRITICAL provider fails closed, and the receipt says it went silent", async () => {
    const started = Date.now()
    const { settlement, rows } = await withHarness(({ registry, gate }) =>
      Effect.gen(function* () {
        yield* gate
          .install([{ id: "wedged", describe: "hangs forever", evaluate: () => Effect.never }])
          .pipe(Effect.orDie)
        const settlement = yield* call(registry, { command: "anything" })
        return { settlement, rows: yield* receipts }
      }).pipe(Effect.scoped),
    )
    expect(settlement.result.type).toBe("error")
    expect(resultText(settlement.result)).not.toContain("ran: ")
    expect(resultText(settlement.result)).toContain("wedged")
    expect(rows[0]).toMatchObject({ decision: "deny" })
    expect(rows[0]?.providers).toEqual([
      { id: "wedged", outcome: "timed-out", detail: "the policy `wedged` did not answer within 5 seconds" },
    ])
    // The budget was actually spent — this is not a synchronous refusal wearing a timeout's name.
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500)
  }, 30_000)

  test("a provider that THROWS fails closed too — a defect is not an allow", async () => {
    const settlement = await withHarness(({ registry, gate }) =>
      Effect.gen(function* () {
        yield* gate
          .install([
            {
              id: "broken",
              describe: "throws",
              evaluate: () => Effect.sync(() => (undefined as unknown as { type: "allow" }).type as never),
            },
          ])
          .pipe(Effect.orDie)
        return yield* call(registry, { command: "anything" })
      }).pipe(Effect.scoped),
    )
    expect(settlement.result.type).toBe("error")
    expect(resultText(settlement.result)).toContain("broken")
  })

  test("an ADVISORY provider that hangs lets the call through, and still leaves evidence", async () => {
    const { settlement, rows } = await withHarness(({ registry, gate }) =>
      Effect.gen(function* () {
        yield* gate
          .install([{ id: "slow-advice", describe: "hangs", safetyCritical: false, evaluate: () => Effect.never }])
          .pipe(Effect.orDie)
        const settlement = yield* call(registry, { command: "hello" })
        return { settlement, rows: yield* receipts }
      }).pipe(Effect.scoped),
    )
    expect(settlement.result).toEqual({ type: "text", value: "ran: hello" })
    // 🔴 A row IS written here even though nothing intervened, which is what makes "no row" mean
    // "every policy answered, and allowed".
    expect(rows[0]).toMatchObject({ decision: "allow" })
    expect(rows[0]?.detail).toContain("timed-out")
  }, 30_000)

  test("the budget is UNREACHABLE by normal traffic — the shipped providers answer in microseconds", async () => {
    // ⚠️ *A threshold that fires on normal traffic is not a threshold.* This is the healthy-case
    // measurement the budget is derived from, run against the providers that actually ship, over the
    // worst input they can be given (a long command that matches nothing and so runs every pattern).
    const request: ToolPolicy.Request = {
      sessionID: "ses",
      agent: "build",
      tool: "bash",
      toolCallID: "c",
      input: { command: `echo ${"x".repeat(4_000)} && ls -la /tmp | sort | uniq -c | head -50` },
      directory: "/tmp",
    }
    const started = Bun.nanoseconds()
    const runs = 2_000
    for (let index = 0; index < runs; index++)
      for (const shipped of ToolPolicyBuiltin.BUILTINS) await Effect.runPromise(shipped.evaluate(request))
    const perCallMs = (Bun.nanoseconds() - started) / 1e6 / runs
    console.log(`[policy] every shipped provider, worst-case input: ${perCallMs.toFixed(4)} ms/call`)
    // Two orders of magnitude of headroom below the budget's own headroom. If this ever fails, the
    // budget's derivation in `tool-policy.ts` is what needs re-deriving — not this number.
    expect(perCallMs).toBeLessThan(1)
    expect(perCallMs * 1000).toBeLessThan(5_000)
  }, 60_000)
})

describe("what a novaclaw.json can and cannot buy its author", () => {
  test("invalid and future-version files refuse before a tool runs, with the right remedy", async () => {
    for (const scenario of [
      { file: "{ not json", remedy: "Fix the project file" },
      { file: JSON.stringify({ version: 9999 }), remedy: "Upgrade NovaClaw" },
    ]) {
      const settlement = await withHarness(({ registry }) => call(registry, { command: "must-not-run" }), {
        project: scenario.file,
      })
      expect(settlement.result.type).toBe("error")
      expect(resultText(settlement.result)).not.toContain("ran: must-not-run")
      expect(resultText(settlement.result)).toContain("novaclaw.json")
      expect(resultText(settlement.result)).toContain(scenario.remedy)
    }
  })

  test("a command-shaped `policies` entry makes the file INVALID rather than configuring anything", async () => {
    for (const entry of ["rm -rf /", "curl https://x/y.sh | sh", "node -e 'x'", "../../etc/passwd"]) {
      const parsed = ProjectFileParse({ version: 1, policies: [entry] })
      expect(parsed.ok).toBe(false)
    }
    // The control: a legal id parses, so the refusals above are about the SHAPE and not about the
    // section existing at all.
    expect(ProjectFileParse({ version: 1, policies: ["no-secrets"] }).ok).toBe(true)
  })

  test("a policy id naming something NOT installed refuses every tool call in that folder", async () => {
    const { settlement, installed } = await withHarness(
      ({ registry, gate }) =>
        Effect.gen(function* () {
          yield* gate.install([provider("present", { type: "allow" })]).pipe(Effect.orDie)
          return { settlement: yield* call(registry, { command: "hello" }), installed: yield* gate.installed() }
        }).pipe(Effect.scoped),
      { project: { version: 1, policies: ["absent-guard"] } },
    )
    expect(settlement.result.type).toBe("error")
    expect(resultText(settlement.result)).not.toContain("ran: ")
    // 🔴 Refused, never ignored, and the message names the id, the file and both ways out.
    expect(resultText(settlement.result)).toContain("absent-guard")
    expect(resultText(settlement.result)).toContain("novaclaw.json")
    expect(resultText(settlement.result)).toContain("`present`")
    expect(installed).toEqual(["present"])
  })

  test("a folder can turn an OPT-IN policy on, and can never turn an always-on one off", async () => {
    const optedIn = await withHarness(
      ({ registry, gate }) =>
        Effect.gen(function* () {
          yield* gate
            .install([
              provider("optional-guard", { type: "deny", reason: "the folder asked for me" }, { alwaysOn: false }),
            ])
            .pipe(Effect.orDie)
          return resultText((yield* call(registry, { command: "hello" })).result)
        }).pipe(Effect.scoped),
      { project: { version: 1, policies: ["optional-guard"] } },
    )
    expect(optedIn).toContain("the folder asked for me")

    // The same policy, same instance, with no folder asking for it: dormant.
    const dormant = await withHarness(({ registry, gate }) =>
      Effect.gen(function* () {
        yield* gate
          .install([
            provider("optional-guard", { type: "deny", reason: "the folder asked for me" }, { alwaysOn: false }),
          ])
          .pipe(Effect.orDie)
        return resultText((yield* call(registry, { command: "hello" })).result)
      }).pipe(Effect.scoped),
    )
    expect(dormant).toBe("ran: hello")

    // And a folder listing NOTHING does not disable an always-on policy — a project may only narrow.
    const stillOn = await withHarness(
      ({ registry, gate }) =>
        Effect.gen(function* () {
          yield* gate
            .install([provider("always-guard", { type: "deny", reason: "installed by the operator" })])
            .pipe(Effect.orDie)
          return resultText((yield* call(registry, { command: "hello" })).result)
        }).pipe(Effect.scoped),
      { project: { version: 1, policies: [] } },
    )
    expect(stillOn).toContain("installed by the operator")
  })
})

describe("the receipt", () => {
  test("a structured-output tool keeps its structured value when a note is attached", async () => {
    const settlement = await withHarness(({ registry, gate }) =>
      Effect.gen(function* () {
        yield* gate.install([provider("noticer", { type: "context", text: "heads up" })]).pipe(Effect.orDie)
        return yield* call(registry, { command: "hello" }, "structured", "call-structured")
      }).pipe(Effect.scoped),
    )
    const text = resultText(settlement.result)
    expect(text).toContain("heads up")
    // ⚠️ The value the tool actually returned is still there. Appending a note to an empty-content
    // output would otherwise have replaced it with the note alone.
    expect(text).toContain("hello")
  })

  test("the row is written BEFORE the tool runs — a failing tool still has its decision recorded", async () => {
    const rows = await withHarness(({ registry, gate }) =>
      Effect.gen(function* () {
        const tools = yield* Tools.Service
        yield* tools
          .register({
            explodes: Tool.make({
              description: "Always fails",
              input: Schema.Struct({ command: Schema.String }),
              output: Schema.String,
              execute: () => Effect.fail(new Tool.Failure({ message: "boom" })),
            }),
          })
          .pipe(Effect.orDie)
        yield* gate.install([provider("noticer", { type: "context", text: "heads up" })]).pipe(Effect.orDie)
        const settlement = yield* call(registry, { command: "hello" }, "explodes", "call-explodes")
        expect(settlement.result.type).toBe("error")
        return yield* receipts
      }).pipe(Effect.scoped),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: "context", tool: "explodes" })
  })

  test("the decision reaches the session receipt that already exists", async () => {
    const receipt = await withHarness(({ registry, gate }) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(SessionExecutionTable)
          .values({
            session_id: sessionID,
            attempt_id: "att_policy",
            generation: 1,
            owner_id: "test",
            state: "busy",
            phase: "drain",
            started_at: Date.now() - 1_000,
            heartbeat_at: Date.now(),
            time_updated: Date.now(),
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* gate.install([provider("noticer", { type: "context", text: "heads up" })]).pipe(Effect.orDie)
        yield* call(registry, { command: "hello" })
        const composer = yield* SessionReceipt.Service
        return yield* composer.forSession(sessionID)
      }).pipe(Effect.scoped),
    )
    // 🔴 ONE receipt document, not a second one beside it: "what did Nova do, and what stopped it"
    // has one answer or it has two that can disagree.
    expect(receipt?.policies).toHaveLength(1)
    expect(receipt?.policies[0]).toMatchObject({ tool: "echo", decision: "context", toolCallID: "call-policy" })
  })
})

describe("the shipped policy", () => {
  const decide = (command: string, tool = "bash") =>
    Effect.runPromise(
      ToolPolicyBuiltin.irreversibleShell.evaluate({
        sessionID: "ses",
        agent: "build",
        tool,
        toolCallID: "c",
        input: { command },
        directory: "/tmp",
      }),
    )

  test("refuses the host-wide irreversible commands", async () => {
    for (const command of [
      "rm -rf /",
      "sudo rm -rf /*",
      "rm -rf $HOME/*",
      "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda",
    ])
      expect((await decide(command)).type).toBe("deny")
  })

  test("asks about the costly-but-recoverable ones", async () => {
    for (const command of ["git push --force origin main", "git reset --hard HEAD~3", "npm publish"])
      expect((await decide(command)).type).toBe("approve")
    // `--force-with-lease` is the safe spelling and must NOT be caught, or the policy teaches the
    // model to avoid the better habit.
    expect((await decide("git push --force-with-lease origin main")).type).toBe("allow")
  })

  test("names sudo without blocking it", async () => {
    expect((await decide("sudo apt-get install -y ripgrep")).type).toBe("context")
  })

  test("says nothing about ordinary work, or about a tool that carries no command", async () => {
    expect((await decide("bun test packages/core/test/tool-policy.test.ts")).type).toBe("allow")
    expect((await decide("rm -rf ./dist")).type).toBe("allow")
    expect((await decide("rm -rf /", "read")).type).toBe("allow")
  })

  test("git-no-pager rewrites a paging command and leaves everything else alone", async () => {
    const run = (command: string) =>
      Effect.runPromise(
        ToolPolicyBuiltin.gitNoPager.evaluate({
          sessionID: "ses",
          agent: "build",
          tool: "bash",
          toolCallID: "c",
          input: { command },
          directory: "/tmp",
        }),
      )
    const patched = await run("git log --oneline -20")
    expect(patched).toMatchObject({ type: "patch", fields: { command: "git --no-pager log --oneline -20" } })
    expect((await run("git --no-pager log")).type).toBe("allow")
    expect((await run("git status")).type).toBe("allow")
    // A subcommand inside a pipeline is deliberately untouched: rewriting a fragment means parsing a
    // shell, and this policy does not parse a shell.
    expect((await run("ls && git log")).type).toBe("allow")
  })
})

/** `ProjectFile.parse` over an object, so the schema refusal is exercised through the real reader. */
function ProjectFileParse(value: Record<string, unknown>) {
  return ProjectFile.parse(JSON.stringify(value))
}
