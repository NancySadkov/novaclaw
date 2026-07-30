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

describe("novaclaw agent create writes the key the loader actually reads", () => {
  test("it assigns `permissions`, and declares no singular `permission` frontmatter field", () => {
    expect(CLI_SOURCE).toContain("frontmatter.permissions")
    // The exact regression: a frontmatter type declaring the singular key, or an assignment to it.
    expect(CLI_SOURCE).not.toMatch(/^\s*permission\?:/m)
    expect(CLI_SOURCE).not.toMatch(/frontmatter\.permission\b(?!s)/)
  })

  test("the emitted ruleset round-trips through the real schema with its denies intact", () => {
    // Mirrors the CLI's construction: deny every offered action the user did not select.
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
    // lifetime of this command.
    expect(kept?.map((rule) => rule.action).sort()).toEqual([
      "bash",
      "edit",
      "skill",
      "todowrite",
      "webfetch",
      "websearch",
    ])
    expect(kept?.every((rule) => rule.effect === "deny")).toBe(true)
  })

  test("AVAILABLE_PERMISSIONS offers no action the V2 path has retired", () => {
    const block = CLI_SOURCE.match(/const AVAILABLE_PERMISSIONS = \[([\s\S]*?)\]/)
    // Guard the instrument: if the const is renamed or reshaped, fail loudly rather than vacuously.
    expect(block).not.toBeNull()
    const offered = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(offered.length).toBeGreaterThan(0)
    expect(offered.filter((action) => RETIRED_ACTIONS.includes(action))).toEqual([])
    // `explore` replaced the retired glob/grep pair. Without it the command can no longer express
    // "deny search", which is the capability the retirement was supposed to preserve.
    expect(offered).toContain("explore")
  })
})
