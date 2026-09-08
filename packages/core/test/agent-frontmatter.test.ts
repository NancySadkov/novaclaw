import { expect, test, describe } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { Option, Schema } from "effect"
import { ConfigAgent } from "@novaclaw/core/config/agent"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// `novaclaw agent create` wrote a SINGULAR `permission:` frontmatter map for its entire life. The V2
// markdown-agent schema declares `permissions` — an ordered {action,resource,effect} array — and the
// loader (`src/config/plugin/agent.ts`) decodes with `Schema.decodeUnknownOption` passing no
// `onExcessProperty`, so Effect's default of "ignore" applies. The key was therefore SILENTLY DROPPED
// while the agent loaded anyway: every agent that command ever created was unrestricted, and the CLI
// reported it had denied things. Ruling 2, on a surface a user drives by hand.
//
// A comment in the loader asserted the opposite — that an unknown key fails to decode and the agent is
// skipped. It was false, and it is why the bug survived being read. BOTH halves are pinned here,
// because either one flipping silently re-opens the defect: if the drop ever became fatal, agents that
// load today would vanish instead; if the CLI goes back to the singular key, its output goes inert.
//
// The CLI lives in `packages/novaclaw`, but this file is in `packages/core` on purpose — core owns the
// decoder, and a test importing core's config graph from inside the `novaclaw` package hangs that
// package's `test/preload.ts` teardown (`AppRuntime.dispose()` plus a 30-retry Windows EBUSY rm).
// Measured: the same assertions cost 20 s and a hook timeout there, 0.1 s here. Cross-package source
// scanning follows the precedent in `ui/src/theme/default-theme.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info)
const DECODE_OPTS = { errors: "all", propertyOrder: "original" } as const

const CLI_PATH = join(import.meta.dir, "../../novaclaw/src/cli/cmd/agent.ts")
const CLI_SOURCE = readFileSync(CLI_PATH, "utf8")

/** Actions retired from the V2 path. A rule naming one is inert but reads as a restriction. */
const RETIRED_ACTIONS = ["glob", "grep", "list", "task"]

describe("markdown-agent frontmatter: what the decoder REALLY does", () => {
  test("an unknown frontmatter key is DROPPED, and the agent still loads", () => {
    const decoded = decodeAgent({ description: "d", system: "body", totally_bogus_key: 1 }, DECODE_OPTS)
    // Not skipped — the loader comment used to claim it was.
    expect(Option.isSome(decoded)).toBe(true)
    expect(Object.keys(Option.getOrThrow(decoded))).not.toContain("totally_bogus_key")
  })

  test("the historical CLI shape decodes, and loses its permissions entirely", () => {
    // Verbatim what `novaclaw agent create` used to emit.
    const decoded = decodeAgent(
      { description: "d", mode: "subagent", permission: { glob: "deny", grep: "deny" }, system: "body" },
      DECODE_OPTS,
    )
    expect(Option.isSome(decoded)).toBe(true)
    const agent = Option.getOrThrow(decoded) as Record<string, unknown>
    expect(agent["permission"]).toBeUndefined()
    expect(agent["permissions"]).toBeUndefined()
    // The agent itself was perfectly usable, which is exactly why nobody noticed.
    expect(agent["description"]).toBe("d")
  })

  test("the canonical `permissions` array survives decode, rules and order intact", () => {
    // `as const` on the effect: without it TypeScript widens to `string`, which does not match the
    // schema's `"allow" | "deny" | "ask"` literal union and fails `toEqual`'s overload.
    const permissions = [
      { action: "explore", resource: "*", effect: "deny" as const },
      { action: "bash", resource: "*", effect: "deny" as const },
    ]
    const decoded = decodeAgent({ description: "d", system: "body", permissions }, DECODE_OPTS)
    expect(Option.isSome(decoded)).toBe(true)
    // Order is load-bearing: the evaluator is findLast.
    expect(Option.getOrThrow(decoded).permissions).toEqual(permissions)
  })
})

describe("nothing writes agent frontmatter from the CLI any more", () => {
  /**
   * ⚠️ RE-POINTED 2026-09-03. Three tests here scanned `cli/cmd/agent.ts` for the writer that
   * emitted `frontmatter.permissions`, and the CLI prune deleted `agent create` — an LLM-backed
   * creation wizard on a surface principle 7 makes vestigial and headless-only, and one that dropped
   * into `prompts.select` whenever three of its four flags were passed.
   *
   * The decoder half above is untouched and is where the value always was: it pins what the LOADER
   * does with a singular `permission:` key, which is the fault the deleted command shipped for its
   * whole life. That fault is now unreachable from the CLI, and this asserts the unreachability
   * directly rather than leaving three scans looking for a symbol nothing defines — a scan whose
   * subject is gone passes or fails for reasons that have nothing to do with the invariant.
   */
  test("the CLI's agent command writes no frontmatter at all — it only lists", () => {
    // Non-vacuity first: the file still exists and still defines a command, so an empty read cannot
    // make the assertions below pass forever.
    expect(CLI_SOURCE.length).toBeGreaterThan(200)
    expect(CLI_SOURCE).toContain("AgentListCommand")

    expect(CLI_SOURCE).not.toContain("frontmatter")
    expect(CLI_SOURCE).not.toContain("AgentCreateCommand")
    // The wizard's permission menu went with it; an offer list nothing offers is a door left open.
    expect(CLI_SOURCE).not.toContain("AVAILABLE_PERMISSIONS")
  })

  test("the emitted ruleset round-trips through the real schema with its denies intact", () => {
    // Kept because it never needed the CLI: it constructs the shape that command produced and holds
    // the DECODER to it. If agent creation returns on any surface, this is the property it must have.
    const offered = ["bash", "read", "edit", "explore", "webfetch", "todowrite", "websearch", "skill"]
    const selected = ["read", "explore"]
    const permissions = offered
      .filter((action) => !selected.includes(action))
      .map((action) => ({ action, resource: "*", effect: "deny" as const }))

    const decoded = decodeAgent({ description: "d", mode: "subagent", system: "body", permissions }, DECODE_OPTS)
    expect(Option.isSome(decoded)).toBe(true)
    const kept = Option.getOrThrow(decoded).permissions
    expect(kept).toEqual(permissions)
    // The denies a user asked for are actually present — the property that was false for the entire
    // lifetime of that command.
    expect(kept?.map((rule) => rule.action).sort()).toEqual([
      "bash",
      "edit",
      "skill",
      "todowrite",
      "webfetch",
      "websearch",
    ])
    expect(kept?.every((rule) => rule.effect === "deny")).toBe(true)
    // And none of them names an action the V2 path retired, which is what the old
    // `AVAILABLE_PERMISSIONS` scan was guarding.
    expect(permissions.filter((rule) => RETIRED_ACTIONS.includes(rule.action))).toEqual([])
  })
})
