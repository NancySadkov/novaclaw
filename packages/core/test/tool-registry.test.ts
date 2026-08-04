import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { AgentV2 } from "@novaclaw/core/agent"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionMessage } from "@novaclaw/core/session/message"
import { Tool } from "@novaclaw/core/tool/tool"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { ToolRuntime } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { settleTool } from "./lib/tool"

// The unknown-tool horizon (ported from github.com/NancySadkov/novaclaw PR #4, @DassaultFalconKing).
//
// Registry lifecycle/staleness is covered by session-runner-tool-registry.test.ts; this file covers only
// what a model is told when it calls a name that was never advertised.
//
// ⚠️ The message itself lives in `@novaclaw/llm` (packages/llm/src/unknown-tool.ts) as of 2026-07-28, not
// in this package — there are TWO dispatch seams and a model's call can land on either, so the message is
// one function both spend rather than two copies kept in step (ruling 6). It is reached here as
// `ToolRuntime.unknownToolMessage`; the llm seam's own coverage is packages/llm/test/tool-runtime.test.ts.
// The last describe below is the check that stops a third seam from re-growing a bare `Unknown tool: X`.

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const it = testEffect(AppNodeBuilder.build(ToolRegistry.node, [[ToolOutputStore.node, outputStore]]))

const sessionID = SessionV2.ID.make("ses_unknown_tool")
const identity = { agent: AgentV2.ID.make("build"), assistantMessageID: SessionMessage.ID.make("msg_unknown_tool") }
const call = (name: string): ToolRegistry.ExecuteInput => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id: `call-${name}`, name, input: {} },
})

const echo = () =>
  Tool.make({
    description: "Echo",
    input: Schema.Struct({}),
    output: Schema.Struct({ ok: Schema.Boolean }),
    execute: () => Effect.succeed({ ok: true }),
  })

const deferredDispatcher = () =>
  ToolRegistry.withDeferredDispatcher(
    Tool.makeExternal({
      description: "Dispatch a disclosed deferred tool",
      inputSchema: { type: "object" },
      execute: (input, context) => {
        const value = input as { readonly name?: unknown; readonly input?: unknown }
        const name = typeof value.name === "string" ? value.name : ""
        const targetInput =
          typeof value.input === "object" && value.input !== null && !Array.isArray(value.input)
            ? (value.input as Record<string, unknown>)
            : {}
        if (!context.invokeDeferred) return Effect.die("test dispatcher was not granted deferred dispatch")
        return context.invokeDeferred(name, targetInput).pipe(
          Effect.map((output) => ({
            structured: output.structured,
            content: output.content.map((part) =>
              part.type === "text"
                ? part
                : {
                    type: "file" as const,
                    data: part.uri.slice(part.uri.indexOf(",") + 1),
                    mime: part.mime,
                    name: part.name,
                  },
            ),
          })),
        )
      },
    }),
  )

const message = (input: ToolRegistry.Settlement) => {
  expect(input.result.type).toBe("error")
  return String(input.result.value)
}

describe("unknownToolMessage", () => {
  test("names every advertised tool, in advertised order", () => {
    const text = ToolRuntime.unknownToolMessage("frobnicate", ["read", "bash", "write"])
    expect(text).toBe(
      "Unknown tool: frobnicate. Nothing ran. Available tools: read, bash, write. " +
        "Use one of these exact advertised names — do not invent a tool or write a call as text.",
    )
  })

  // Negative control: the empty registry must NOT claim tools exist, and must not dangle an empty list.
  test("says plainly that there is nothing to call when no tool is advertised", () => {
    const text = ToolRuntime.unknownToolMessage("read", [])
    expect(text).toBe(
      "Unknown tool: read. Nothing ran — no tools are available in this turn. Do not invent a tool or " +
        "write a call as text; answer in your reply instead.",
    )
    expect(text).not.toContain("Available tools")
    expect(text).not.toContain("Did you mean")
  })

  test("offers the near miss the model actually produces", () => {
    // Suffix ("read_file" for "read"), separator ("read_hex" for "read-hex" — our own names mix both),
    // case/word-break ("WebSearch"), and truncation ("todo" for "todowrite").
    const tools = ["read", "read-hex", "write", "websearch", "todowrite", "js"]
    const hint = (name: string) => ToolRuntime.closestToolName(name, tools)
    expect(hint("read_file")).toBe("read")
    expect(hint("read_hex")).toBe("read-hex")
    expect(hint("readHexDump")).toBe("read-hex")
    expect(hint("WebSearch")).toBe("websearch")
    expect(hint("web_search")).toBe("websearch")
    expect(hint("todo")).toBe("todowrite")
    expect(hint("js_run")).toBe("js")
    expect(ToolRuntime.unknownToolMessage("read_file", tools)).toContain('Did you mean "read"?')
  })

  test("stays silent rather than guessing", () => {
    // A tie is a coin flip, an unrelated name has no answer, and a 1-char stub is not evidence.
    expect(ToolRuntime.closestToolName("web", ["webfetch", "websearch"])).toBeUndefined()
    expect(ToolRuntime.closestToolName("frobnicate", ["read", "bash"])).toBeUndefined()
    expect(ToolRuntime.closestToolName("r", ["read"])).toBeUndefined()
    expect(ToolRuntime.closestToolName("", ["read"])).toBeUndefined()
    expect(ToolRuntime.unknownToolMessage("frobnicate", ["read", "bash"])).not.toContain("Did you mean")
  })

  test("truncates only past the character budget, and says how much it withheld", () => {
    const many = Array.from({ length: 400 }, (_, index) => `tool_${index}`)
    const text = ToolRuntime.unknownToolMessage("nope", many)
    const shown = /\(([0-9]+) of 400\)/.exec(text)?.[1]
    expect(shown).toBeDefined()
    expect(Number(shown)).toBeLessThan(400)
    expect(text).toContain(`and ${400 - Number(shown)} more.`)
    expect(text.length).toBeLessThan(ToolRuntime.UNKNOWN_TOOL_LIST_BUDGET + 300)
    // The stock 28-tool session is well inside the budget, so it is never truncated.
    const stock = Array.from({ length: 28 }, (_, index) => `some_tool_${index}`)
    expect(ToolRuntime.unknownToolMessage("nope", stock)).not.toContain(" more.")
  })

  test("always lists at least one name, even when a single name blows the budget", () => {
    const huge = "x".repeat(ToolRuntime.UNKNOWN_TOOL_LIST_BUDGET + 50)
    expect(ToolRuntime.unknownToolMessage("nope", [huge, "read"])).toContain(`(1 of 2): ${huge}, and 1 more.`)
  })
})

describe("ToolRegistry settlement of an unadvertised name", () => {
  // Each assertion below is `toBe(ToolRuntime.unknownToolMessage(...))`, which is also the strongest
  // available proof that this seam and the llm one share ONE implementation: core no longer exports a
  // message of its own, so there is nothing left here for the two to drift apart on.
  it.effect("hands the model the tools it does have", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ read: echo(), bash: echo(), write: echo() })

      const text = message(yield* settleTool(service, call("read_file")))
      expect(text).toBe(ToolRuntime.unknownToolMessage("read_file", ["read", "bash", "write"]))
      expect(text).toContain('Did you mean "read"?')
      expect(text).toContain("Available tools: read, bash, write.")
    }),
  )

  // Negative control: an empty registry must reach the no-tools branch through the real settle path.
  it.effect("does not invent a horizon when nothing is registered", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service

      expect(message(yield* settleTool(service, call("read")))).toBe(ToolRuntime.unknownToolMessage("read", []))
    }),
  )

  // The listed set is the ADVERTISED set: a tool denied by permission is not offered as a correction.
  it.effect("omits tools the turn's permissions removed", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ read: echo(), write: Tool.withPermission(echo(), "edit") })
      const materialized = yield* service.materialize([{ action: "edit", resource: "*", effect: "deny" }])

      const text = message(yield* materialized.settle(call("write_file")))
      expect(text).toBe(ToolRuntime.unknownToolMessage("write_file", ["read"]))
      expect(text).toContain("Available tools: read.")
      expect(text).not.toContain("Did you mean")
    }),
  )

  it.effect("uses the routed horizon for definitions, settlement, and unknown-tool recovery", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ read: echo(), write: echo(), apply_patch: echo() })
      const materialized = yield* service.materialize([], (name) => name !== "write")

      expect(materialized.definitions.map((definition) => definition.name)).toEqual(["read", "apply_patch"])
      expect((yield* materialized.settle(call("read"))).result.type).toBe("json")
      expect(message(yield* materialized.settle(call("write")))).toBe(
        ToolRuntime.unknownToolMessage("write", ["read", "apply_patch"]),
      )
    }),
  )

  it.effect("cannot route a permission-withdrawn tool back onto the horizon", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ read: echo(), write: Tool.withPermission(echo(), "edit") })
      const materialized = yield* service.materialize([{ action: "edit", resource: "*", effect: "deny" }], () => true)

      expect(materialized.definitions.map((definition) => definition.name)).toEqual(["read"])
      expect(message(yield* materialized.settle(call("write")))).toContain("Available tools: read.")
    }),
  )

  it.effect("corrects a dispatcher call aimed at a resident tool toward the native name", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ tool_call: deferredDispatcher(), spawn: echo() })
      const materialized = yield* service.materialize()
      const settled = yield* materialized.settle({
        sessionID,
        ...identity,
        call: {
          type: "tool-call",
          id: "call-tool_call-resident",
          name: "tool_call",
          input: { name: "spawn", input: {} },
        },
      })

      expect(message(settled)).toBe(
        "spawn is a resident provider-native tool already advertised in this turn. " +
          "Call spawn directly as the tool name; do not use tool_call or tool_search for resident tools.",
      )
    }),
  )

  it.effect("keeps a deferred Core schema out of the resident array and dispatches it after discovery", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({
        tool_call: deferredDispatcher(),
        read: echo(),
        rare: Tool.withDeferred(echo()),
      })
      const before = yield* service.materialize()

      expect(before.definitions.map((definition) => definition.name)).toEqual(["tool_call", "read"])
      expect(before.deferred.map((source) => [source.definition.name, source.server])).toEqual([["rare", "core"]])
      expect(message(yield* before.settle(call("rare")))).toContain("schema has not been disclosed")

      const after = yield* service.materialize([], () => true, new Set(["rare"]))
      const settled = yield* after.settle({
        sessionID,
        ...identity,
        call: {
          type: "tool-call",
          id: "call-tool_call-rare",
          name: "tool_call",
          input: { name: "rare", input: {} },
        },
      })

      expect(after.definitions.map((definition) => definition.name)).toEqual(["tool_call", "read"])
      expect(settled.result).toEqual({ type: "json", value: { ok: true } })
    }),
  )
})

/**
 * ─── the ledger: there is exactly ONE unknown-tool message ──────────────────────────────────────────
 *
 * **Why a guard and not a review.** "Every dispatch path names the tools that exist" is a claim about
 * code in files other than the one it is written in — the defect class that compiles green, so a review
 * is the wrong instrument (todo.md ruling 1: an invariant without a mechanical check does not exist).
 * This is not hypothetical: the horizon shipped in `packages/core/src/tool/registry.ts` on 2026-07-28
 * and a SECOND dispatch seam (`ToolRuntime.dispatch`, packages/llm/src/tool-runtime.ts) went on
 * answering a hallucinated name with a bare `Unknown tool: X` for the rest of that day, because nothing
 * failed. What that costs is the whole point of the harness: a small model that gets back only "you
 * lost" has nothing to correct toward, so it re-guesses or gives up and the turn is dead (AGENTS.md's
 * opening, notes/jh.md — small models fail from lack of HORIZON, not lack of knowledge).
 *
 * So: any `packages/**\/src` file that writes an unknown-tool message by hand must be in the ledger
 * below, with a reason. It is a RATCHET and fails in both directions — a new site fails outright, and a
 * listed site that no longer writes one fails with "drop the ledger entry", so the list can only shrink.
 *
 * ⚠️ It reads files directly rather than shelling out to a search tool, which matters here: ripgrep
 * classifies a file holding a raw NUL as binary and SKIPS it, and this tree has had exactly that
 * (Wave 1 batch 2 — the two files carrying the steer-provenance bug were invisible to a grep audit OF
 * that bug). A guard that can be hidden from by a stray control byte is not a guard.
 */

/** The app repo root: `packages/core/test` → `packages/core` → `packages` → repo. */
const ROOT = path.resolve(import.meta.dir, "..", "..", "..")

const SKIP_DIRS = new Set(["node_modules", "dist", "out", "build", "coverage", "gen", ".git", ".turbo", ".vite"])
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]

interface Source {
  /** Repo-relative, posix-separated — the name the ledger and the failures speak. */
  readonly name: string
  /** CODE ONLY. Comments are stripped, so this answers "does this file PRODUCE one", never "does it
   *  mention one" — every collapsed site explains in prose what it used to hand-roll. */
  readonly text: string
}

/** The comment stripper `src/jh/imports.test.ts` uses — `//` must not eat the `//` in a URL. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

function collect(dir: string, out: Source[]): Source[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collect(full, out)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.endsWith(".d.ts")) continue
    if (!EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue
    const name = path.relative(ROOT, full).replaceAll("\\", "/")
    // SHIPPING SOURCE ONLY. A test that asserts on the message does not produce one for a model, and
    // sweeping tests would drag half a dozen suites into a ledger about production behaviour. That also
    // means this file needs no SELF exclusion: `packages/core/test/**` is not in the sweep.
    if (!name.includes("/src/")) continue
    out.push({ name, text: stripComments(fs.readFileSync(full, "utf8")) })
  }
  return out
}

const sources = collect(path.join(ROOT, "packages"), [])

const SHAPES: ReadonlyArray<{ readonly what: string; readonly re: RegExp }> = [
  // The bare verdict itself. `Unknown tool call: ${callID}` is excluded by construction, not by a ledger
  // entry: it is an `Effect.die` DEFECT about an unrecognised tool-call ID (session/runner/
  // publish-llm-event.ts), not a model-facing result about a tool NAME — there is no horizon to hand back
  // for it, so listing it would read as sanctioned debt when it is not debt at all.
  { what: "a hand-written unknown-tool message", re: /Unknown tool(?! call\b)/ },
  // The same message in other words, which is how a second copy actually appears — nobody re-types the
  // exact string they are trying not to duplicate.
  { what: "an unknown-tool message in other words", re: /\bno such tool\b|\btool not found\b|\bunknown tool name\b/i },
]

const shapesIn = (text: string): string[] => SHAPES.filter((shape) => shape.re.test(text)).map((shape) => shape.what)

/**
 * Every file allowed to author the message, and WHY. Adding an entry is a decision with a cost: it is one
 * more place a model can be handed a dead end. Call `ToolRuntime.unknownToolMessage(name, advertised)`
 * instead — it is exported from `@novaclaw/llm`, which every package that can dispatch a tool already
 * depends on.
 */
const LEDGER = new Map<string, string>([
  [
    "packages/llm/src/unknown-tool.ts",
    "THE implementation. A leaf module importing nothing at all, so no consumer is constrained by where " +
      "it sits. It lives in `@novaclaw/llm` rather than here because the dependency edge only points one " +
      "way — `@novaclaw/core` depends on `@novaclaw/llm` and not the reverse — so this is the only end " +
      "that both dispatch seams can reach without an import cycle. Its content is asserted above and in " +
      "packages/llm/test/tool-runtime.test.ts.",
  ],
])

/** The dispatch seams that were collapsed onto it. Each must still REACH it, or the collapse regressed. */
const SEAMS: ReadonlyArray<readonly [string, RegExp]> = [
  ["packages/llm/src/tool-runtime.ts", /\bunknownToolMessage\(/],
  ["packages/core/src/tool/registry.ts", /\bToolRuntime\.unknownToolMessage\(/],
]

const offendersIn = (files: ReadonlyArray<Source>): string[] =>
  files
    .filter((file) => !LEDGER.has(file.name))
    .flatMap((file) => {
      const found = shapesIn(file.text)
      return found.length === 0 ? [] : [`${file.name} → ${found.join(", ")}`]
    })
    .sort()

const staleIn = (files: ReadonlyArray<Source>): string[] => {
  const stale: string[] = []
  for (const name of LEDGER.keys()) {
    const file = files.find((item) => item.name === name)
    if (file === undefined) {
      stale.push(`${name} (no longer exists — drop the ledger entry)`)
      continue
    }
    if (shapesIn(file.text).length === 0)
      stale.push(`${name} (no longer holds the unknown-tool message — drop the ledger entry)`)
  }
  return stale
}

describe("the sweep", () => {
  test("actually has source files to look at", () => {
    // A mistyped root, a moved test file or a bad SKIP_DIRS entry would silently empty the sweep and turn
    // every assertion below into a tautology — the exact way a sibling guard failed silently this round.
    expect(sources.length).toBeGreaterThan(500)
  })

  test("reaches both dispatch seams and spans packages beyond this one", () => {
    const names = new Set(sources.map((file) => file.name))
    for (const name of [
      "packages/llm/src/unknown-tool.ts",
      "packages/llm/src/tool-runtime.ts",
      "packages/core/src/tool/registry.ts",
      "packages/core/src/session/runner/publish-llm-event.ts",
      "packages/novaclaw/src/index.ts",
    ])
      expect(names, `${name} is not in the sweep`).toContain(name)
  })
})

describe("there is exactly ONE unknown-tool message", () => {
  test("no unledgered source file writes one by hand", () => {
    // Call `ToolRuntime.unknownToolMessage(name, advertised)` with the set that was actually advertised at
    // your seam. If you genuinely cannot, add an entry to LEDGER above WITH ITS REASON — and expect that
    // reason to be read.
    expect(offendersIn(sources)).toEqual([])
  })

  test("the ledger can only SHRINK — a fixed or vanished entry must be deleted from it", () => {
    expect(staleIn(sources)).toEqual([])
  })

  test("the canonical implementation still supplies a horizon rather than a verdict", () => {
    const canonical = sources.find((file) => file.name === "packages/llm/src/unknown-tool.ts")
    expect(canonical, "packages/llm/src/unknown-tool.ts vanished from the sweep").toBeDefined()
    // A stub that satisfied the ledger while naming nothing is the "reads as coverage while being none"
    // failure this whole block exists to remove. Both branches and the budget, by the text they produce.
    for (const marker of [
      "export const unknownToolMessage",
      "export const closestToolName",
      "UNKNOWN_TOOL_LIST_BUDGET",
      "Available tools",
      "Did you mean",
      "no tools are available in this turn",
    ])
      expect(canonical!.text, `unknown-tool.ts no longer contains ${marker}`).toContain(marker)
  })

  test("every dispatch seam still reaches it", () => {
    // The other direction of the collapse: deleting the call (rather than replacing it with a bare string)
    // passes the offender sweep above while silently restoring a horizonless answer.
    const regressed: string[] = []
    for (const [name, expected] of SEAMS) {
      const file = sources.find((item) => item.name === name)
      if (file === undefined) {
        regressed.push(`${name} (missing from the sweep)`)
        continue
      }
      if (!expected.test(file.text)) regressed.push(`${name} (no longer calls ${String(expected)})`)
    }
    expect(regressed).toEqual([])
  })

  test("core takes the message from llm instead of keeping a copy", () => {
    const registry = sources.find((file) => file.name === "packages/core/src/tool/registry.ts")
    expect(registry!.text).toContain('from "@novaclaw/llm"')
    expect(registry!.text).toContain("ToolRuntime")
  })
})

describe("the guard actually bites (negative control)", () => {
  test("each shape matches the copy it was written for", () => {
    expect(shapesIn('return result(call, { type: "error", value: `Unknown tool: ${call.name}` })')).toContain(
      "a hand-written unknown-tool message",
    )
    expect(shapesIn('throw new Error("No such tool: " + name)')).toContain("an unknown-tool message in other words")
    expect(shapesIn("const error = `tool not found: ${name}`")).toContain("an unknown-tool message in other words")
  })

  test("it does NOT fire on the collapsed call, on the tool-call-ID defect, or on prose", () => {
    expect(shapesIn("ToolRuntime.unknownToolMessage(input.call.name, registrations.keys())")).toEqual([])
    expect(shapesIn("value: unknownToolMessage(call.name, Object.keys(tools))")).toEqual([])
    // The `Effect.die` in publish-llm-event.ts — a defect about a call ID, not a tool name.
    expect(shapesIn("return Effect.die(`Unknown tool call: ${callID}`)")).toEqual([])
    // …and a file that only TALKS about the old bare message is code-clean, because comments are stripped.
    expect(shapesIn(stripComments("// this used to return `Unknown tool: ${name}`\nconst x = 1"))).toEqual([])
  })

  test("an unledgered offender is what the sweep reports", () => {
    // The predicate itself, exercised on a synthetic file: the real sweep asserts an EMPTY list, which
    // alone cannot show that a non-empty one is reachable.
    const rogue: Source = { name: "packages/somewhere/src/rogue.ts", text: "value: `Unknown tool: ${name}`" }
    expect(offendersIn([rogue])).toEqual(["packages/somewhere/src/rogue.ts → a hand-written unknown-tool message"])
  })

  test("a ledger entry that stopped applying is what the shrink direction reports", () => {
    const gutted: Source = { name: "packages/llm/src/unknown-tool.ts", text: "export const nothing = 1" }
    expect(staleIn([gutted])).toEqual([
      "packages/llm/src/unknown-tool.ts (no longer holds the unknown-tool message — drop the ledger entry)",
    ])
    expect(staleIn([])).toEqual(["packages/llm/src/unknown-tool.ts (no longer exists — drop the ledger entry)"])
  })
})
