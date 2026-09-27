import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@novaclaw/core/agent"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { Location } from "@novaclaw/core/location"
import { ModelV2 } from "@novaclaw/core/model"
import { Project } from "@novaclaw/core/project"
import { ProviderV2 } from "@novaclaw/core/provider"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionMessage } from "@novaclaw/core/session/message"
import { ToolCatalogue } from "@novaclaw/core/tool-catalogue"
import { ToolCatalogueStore } from "@novaclaw/core/tool-catalogue-store"
import { ToolDiscovery } from "@novaclaw/core/tool-discovery"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { ToolPolicyGate } from "@novaclaw/core/tool-policy-gate"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolSearchTool } from "@novaclaw/core/tool/tool-search"
import { Tool } from "@novaclaw/core/tool/tool"
import { Tools } from "@novaclaw/core/tool/tools"
import { ToolDefinition } from "@novaclaw/llm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { bypassedPolicyGate } from "./lib/tool"

/**
 * Two halves of ONE surface: a model that cannot see a tool's schema can neither find it nor call it,
 * and both seams used to fail SILENTLY in a way that reads to the model as "that thing does not exist".
 *
 *  · `tool_search` skipped a hit whose complete schema would not fit and carried on to the next,
 *    smaller one, while its message went on claiming N complete schemas are callable. Because
 *    `ToolDiscovery.discovered` rebuilds the callable set purely from the names inside a completed
 *    result, a skipped tool was also uncallable for the rest of the session. A false negative is
 *    worse than an error: the model reasons from it and stops asking.
 *
 *  · `tool_call`'s dispatch resolved the name the MODEL typed by exact `Map` lookup. Three shipped
 *    deferred tools are hyphenated in an otherwise snake_case tree (`read-hex`, `write-hex`,
 *    `register-app`), so `read_hex` is a near-certain miss — and the miss answered "call tool_search
 *    and use an exact name it returned", i.e. repeat the search that produced the name just mistyped.
 *
 * ⚠️ **Why neither was noticed in normal use.** All three hyphenated tools are `Tool.withDeferred`, so
 * they are never in the default prompt and are reachable only through `tool_call`; and the search skip
 * only bites once the operational `tool_output` budget is lowered. The assertion below that the
 * deferred tool is absent from `definitions` is what keeps that premise honest rather than assumed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// tool_search — a partial answer must say it is partial
// ─────────────────────────────────────────────────────────────────────────────

const HUGE = { maxBytes: 4_000_000, maxLines: 1_000_000 }

const inputSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] }

const hit = (name: string, description: number): ToolCatalogueStore.SearchHit => ({
  name,
  server: "core",
  description: "d".repeat(description),
  inputSchema,
  arguments: [{ name: "path" }],
  score: -1,
})

const deferredSources: ReadonlyArray<ToolCatalogue.Source> = [
  {
    server: "tracker",
    definition: new ToolDefinition({
      name: "tracker_create_issue",
      description: "Create an issue in a repository",
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
    }),
  },
]

async function search(hits: ReadonlyArray<ToolCatalogueStore.SearchHit>, limits: typeof HUGE) {
  let registered: Tool.AnyTool | undefined
  const root = AbsolutePath.make("/workspace")
  const dependencies = Layer.mergeAll(
    Layer.mock(Tools.Service, {
      register: (entries) => Effect.sync(() => void (registered = entries.tool_search)),
    }),
    Layer.mock(ToolCatalogueStore.Service, { replace: () => Effect.void, search: () => Effect.succeed(hits) }),
    Layer.mock(ToolRegistry.Service, { catalogue: () => Effect.succeed(deferredSources) }),
    Layer.mock(ToolOutputStore.Service, { limits: () => Effect.succeed(limits) }),
    Layer.mock(Location.Service, { directory: root, root, origin: Project.ID.make("prj_test") }),
  )
  await Effect.runPromise(Effect.scoped(Layer.build(ToolSearchTool.layer.pipe(Layer.provide(dependencies)))))
  if (!registered) throw new Error("tool_search did not register")
  const output = await Effect.runPromise(
    Tool.settle(
      registered,
      { type: "tool-call", id: "call_search", name: "tool_search", input: { query: "control the desktop" } },
      {
        sessionID: SessionV2.ID.make("ses_recovery"),
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_recovery"),
        toolCallID: "call_search",
        deferredTools: deferredSources,
      },
    ),
  )
  return output.structured as ToolSearchTool.Output
}

/** The callable set the session will actually reconstruct from this result — the join that makes a
 *  silent omission permanent rather than merely rude. */
const callableAfter = (structured: ToolSearchTool.Output) => [
  ...ToolDiscovery.discovered([
    SessionMessage.Assistant.make({
      id: SessionMessage.ID.make("msg_recovery"),
      type: "assistant",
      agent: "build",
      model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
      content: [
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_search",
          name: "tool_search",
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: { query: "control the desktop" },
            content: [],
            structured,
          }),
          time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(0) },
        }),
      ],
      time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(0) },
    }),
  ]),
]

describe("tool_search never drops a hit in silence", () => {
  test("CONTROL: an under-budget search is unchanged — every hit, and no partial notice", async () => {
    const structured = await search([hit("computer", 40), hit("read-hex", 40), hit("todowrite", 40)], HUGE)
    expect(structured.kind).toBe(ToolDiscovery.RESULT_KIND)
    expect(structured.tools.map((tool) => tool.name)).toEqual(["computer", "read-hex", "todowrite"])
    expect(structured.message).toContain("These 3 complete schemas are now callable")
    expect(structured.message).not.toContain("PARTIAL")
    expect(callableAfter(structured)).toEqual(["computer", "read-hex", "todowrite"])
  })

  test("a hit it cannot carry is NAMED, and the result stops claiming an unqualified success", async () => {
    // Size the budget off the real rendered cost of the top hit alone, so the assertion below is
    // about the BEHAVIOUR and not about a byte count guessed at authoring time.
    const alone = await search([hit("computer", 1_200)], HUGE)
    const limits = { maxBytes: Buffer.byteLength(ToolSearchTool.render(alone), "utf-8") + 600, maxLines: 1_000_000 }

    const structured = await search([hit("computer", 1_200), hit("read-hex", 1_200), hit("todowrite", 40)], limits)
    // The prefix that fits — the TOP-ranked hit, never a set silently reordered by size.
    expect(structured.tools.map((tool) => tool.name)).toEqual(["computer"])
    expect(structured.message).toContain("PARTIAL")
    expect(structured.message).toContain("read-hex")
    expect(structured.message).toContain("todowrite")
    expect(structured.message).toContain("NOT callable")
    // The message and the reconstructed callable set agree: what was named as withheld is not
    // silently callable, and what was returned is.
    expect(callableAfter(structured)).toEqual(["computer"])
    // And the answer it did return still fits the budget it was given.
    expect(Buffer.byteLength(ToolSearchTool.render(structured), "utf-8")).toBeLessThanOrEqual(limits.maxBytes)
  })

  test("when the TOP-ranked hit will not fit, the refusal names it instead of quietly serving the rest", async () => {
    // The shipped failure: a lowered tool_output budget, a search whose best answer is the largest
    // schema in the tree. Two smaller tools fit; serving those two and calling it success is how a
    // model is told the tool it asked for does not exist.
    const structured = await search([hit("computer", 3_000), hit("read", 40), hit("write", 40)], {
      maxBytes: 2_000,
      maxLines: 1_000_000,
    })
    expect(structured.kind).toBe("tool-search-unavailable")
    expect(structured.tools).toEqual([])
    expect(structured.message).toContain("computer")
    expect(structured.message).toContain("no partial schema was disclosed")
    expect(callableAfter(structured)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// tool_call — a near miss on a deferred name is recovered, not refused
// ─────────────────────────────────────────────────────────────────────────────

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const it = testEffect(
  AppNodeBuilder.build(ToolRegistry.node, [
    [ToolOutputStore.node, outputStore],
    [ToolPolicyGate.node, bypassedPolicyGate],
  ]),
)

const sessionID = SessionV2.ID.make("ses_near_miss")
const identity = { agent: AgentV2.ID.make("build"), assistantMessageID: SessionMessage.ID.make("msg_near_miss") }

const echo = (label: string) =>
  Tool.make({
    description: "Echo",
    input: Schema.Struct({}),
    output: Schema.Struct({ ran: Schema.String }),
    execute: () => Effect.succeed({ ran: label }),
  })

/** The shipped `tool_call`: a resident dispatcher granted the per-materialization deferred capability. */
const dispatcher = () =>
  ToolRegistry.withDeferredDispatcher(
    Tool.makeExternal({
      description: "Call a deferred tool whose schema was returned by tool_search",
      inputSchema: { type: "object" },
      execute: (input, context) => {
        const value = input as { readonly name?: unknown }
        if (!context.invokeDeferred) return Effect.die("test dispatcher was not granted deferred dispatch")
        return context
          .invokeDeferred(typeof value.name === "string" ? value.name : "", {})
          .pipe(Effect.map((output) => ({ structured: output.structured, content: [] })))
      },
    }),
  )

const registerHexTools = (service: ToolRegistry.Interface) =>
  service.register({
    tool_call: dispatcher(),
    read: echo("read"),
    // Hyphenated in an otherwise snake_case tree, and deferred — the two facts that together make a
    // mistyped name both likely and unrecoverable.
    "read-hex": Tool.withDeferred(echo("read-hex")),
    "write-hex": Tool.withDeferred(echo("write-hex")),
  })

const dispatch = (materialized: ToolRegistry.Materialization, name: string) =>
  materialized.settle({
    sessionID,
    ...identity,
    call: { type: "tool-call", id: `call-${name}`, name: "tool_call", input: { name, input: {} } },
  })

describe("tool_call recovers a near miss on a deferred name", () => {
  it.effect("PREMISE: the hyphenated tool is deferred, so it is never in the prompt to be copied from", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* registerHexTools(service)
      const materialized = yield* service.materialize()
      expect(materialized.definitions.map((one) => one.name)).toEqual(["tool_call", "read"])
      expect(materialized.deferred.map((one) => one.definition.name)).toEqual(["read-hex", "write-hex"])
    }),
  )

  it.effect("a separator slip on a disclosed name RESOLVES and the tool runs", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* registerHexTools(service)
      const materialized = yield* service.materialize([], () => true, new Set(["read-hex"]))

      expect((yield* dispatch(materialized, "read_hex")).result).toEqual({ type: "json", value: { ran: "read-hex" } })
    }),
  )

  it.effect("CONTROL: the exact name still resolves to the same tool", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* registerHexTools(service)
      const materialized = yield* service.materialize([], () => true, new Set(["read-hex"]))

      expect((yield* dispatch(materialized, "read-hex")).result).toEqual({ type: "json", value: { ran: "read-hex" } })
    }),
  )

  it.effect("a genuinely unknown name is refused, and named as INSTALLATION rather than session state", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* registerHexTools(service)
      const materialized = yield* service.materialize([], () => true, new Set(["read-hex"]))

      const settled = yield* dispatch(materialized, "frobnicate")
      expect(settled.result.type).toBe("error")
      const text = String(settled.result.value)
      // 🔴 The wording CHANGED, owner 2026-09-27, and the change is the point. This used to say
      // `Deferred tool frobnicate is not callable in this session` and list the DISCLOSED set — which
      // described a prompt-budget decision as a fact about the session, and so told a model that a
      // tool the instance had installed was somehow not available to it. That is the sentence the
      // owner was shown, twice, on two different live agents, and it is the reason the "not callable"
      // level was deleted rather than softened. What is left says only what is true: no tool by that
      // name is installed here, and here is what you can actually reach.
      expect(text).toContain("No deferred tool called frobnicate is installed on this instance")
      // Every INSTALLED deferred tool, not the disclosed subset. Under the old code this listed only
      // what had been sent to the model, so a tool the instance could run was described as absent —
      // the same inversion the removed sentence carried, just in list form.
      expect(text).toContain("Callable through tool_call here: read-hex, write-hex.")
      // Never guess: nothing here is close to `frobnicate`, and a confidently wrong correction costs
      // more than no hint at all.
      expect(text).not.toContain("Did you mean")
      // The removed level must be GONE, not merely unused: the phrase is what the owner read, and
      // leaving it in the tree invites it back into a message.
      expect(text).not.toContain("not callable in this session")
    }),
  )

  it.effect("🔴 an UNDISCLOSED tool is EXECUTED, not refused — the disclosure tier is gone", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* registerHexTools(service)
      // `discovered` is EMPTY: nothing was disclosed to the model this turn, so under the old code
      // every deferred tool sat in the "not callable" tier. `read-hex` is installed, and it runs.
      const materialized = yield* service.materialize([], () => true, new Set())

      const settled = yield* dispatch(materialized, "read-hex")
      expect(settled.result).toEqual({ type: "json", value: { ran: "read-hex" } })
    }),
  )
  it.effect("🔴 a near miss on an UNDISCLOSED tool is RECOVERED AND RUNS, not described as withheld", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* registerHexTools(service)
      // `write-hex` is installed but was NOT disclosed, and the model typed `write_hex`. The old
      // behaviour answered `Deferred tool write-hex is installed but its schema has not been
      // disclosed` — a refusal whose entire content was a fact about the prompt budget. It is the
      // third and last wording of this same defect, and the one that would have caught Sopitis had it
      // reached this branch instead of the horizon one.
      const materialized = yield* service.materialize([], () => true, new Set(["read-hex"]))

      const settled = yield* dispatch(materialized, "write_hex")
      expect(settled.result).toEqual({ type: "json", value: { ran: "write-hex" } })
    }),
  )

  it.effect("CONTROL: an exact resident name is still sent back to the native call, not dispatched", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* registerHexTools(service)
      const materialized = yield* service.materialize([], () => true, new Set(["read-hex"]))

      expect(String((yield* dispatch(materialized, "read")).result.value)).toBe(
        "read is a resident provider-native tool already advertised in this turn. " +
          "Call read directly as the tool name; do not use tool_call or tool_search for resident tools.",
      )
    }),
  )

  it.effect("🔴 NEGATIVE CONTROL, INVERTED: with nothing disclosed, the near miss now RESOLVES", () =>
    Effect.gen(function* () {
      // This test asserted the exact opposite, and it is the clearest single statement of what the
      // owner ruled against: *"Recovery canonicalizes against the DISCLOSED set … discovery stays the
      // gate, so this must refuse rather than run `read-hex`."* Under the old code `materialize()` with
      // no `discovered` set left every deferred tool in the withheld tier, so a correctly-spelled
      // tool call on a fully installed tool was refused for a reason that had nothing to do with the
      // instance. Owner, 2026-09-27: *"remove the entire `not callable in this session` permission
      // check, so any tool, deferred or not, will be callable."*
      //
      // So it runs. What is worth keeping from the original is the property underneath it, and that
      // survives: recovery canonicalizes against the INSTALLED set, so it still cannot invent a name
      // the instance does not have. That is asserted below as the control it now is.
      const service = yield* ToolRegistry.Service
      yield* registerHexTools(service)
      const materialized = yield* service.materialize()

      expect((yield* dispatch(materialized, "read_hex")).result).toEqual({
        type: "json",
        value: { ran: "read-hex" },
      })
      // …and the guard that replaced it: a name with no near match is still refused, so
      // canonicalization resolves WITHIN the instance rather than within the model's imagination.
      // `read-hexx` would have been the wrong probe here — it is one character from `read-hex` and
      // recovery is supposed to catch that, which is the feature the two tests above pin.
      const invented = yield* dispatch(materialized, "frobnicate")
      expect(String(invented.result.value)).toContain("No deferred tool called frobnicate is installed")
    }),
  )
})
