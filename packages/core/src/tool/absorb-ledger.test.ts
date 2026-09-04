import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { ToolFailure } from "@novaclaw/llm"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { stripComments } from "../../test/lib/source-scan"

/**
 * **A tool that asserts a permission must be able to REPORT a refusal (1J).**
 *
 * 🔴 The failure this guards is measured, not hypothetical. Twenty tools in this directory carried a
 * byte-similar three-arm absorber and four had drifted out of it — `js`, `computer`, `skill` and
 * `community`. Running each drifted site's own expression over a real
 * `PermissionV2.DeniedError` on 2026-09-01 produced, respectively: `""` (the empty string —
 * `DeniedError` declares only `rules` and `reason`, so it has no message), `"computer:
 * PermissionV2.DeniedError"` (the tag), the same sentence a MISSING skill produces, and a correct
 * message reached through a hand-rolled `_tag` string compare. `todowrite.ts` records what the
 * collapse costs: a refusal that reads like a transient fault is *"worth retrying, which is exactly
 * the loop the deny-fast text exists to stop"* — and `MODE_RULES.plan` hard-denies `js`, so that
 * loop was reachable in the shipped product.
 *
 * ⚠️ The sweep is over CODE, not prose. Every one of these files discusses `denialMessage` in its
 * comments; a regex that counted those would have reported the tree healthy on the day it was
 * broken. Comments are stripped before matching, and the block below proves the stripper works.
 *
 * ⚠️ This is a REACHABILITY guard, not a shape guard. It does not require `Tool.absorb` — several
 * tools have a legitimately richer mapper — only that a refusal cannot silently become something
 * else. The two behavioural tests at the bottom are what pin the actual message.
 */

const HERE = import.meta.dir
const SELF = path.resolve(HERE, "absorb-ledger.test.ts")

/** Comments discuss `denialMessage` freely; only CODE is swept. */

const SOURCES = fs
  .readdirSync(HERE, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
  .filter((entry) => path.resolve(HERE, entry.name) !== SELF && !entry.name.endsWith(".test.ts"))
  .map((entry) => ({ name: entry.name, code: stripComments(fs.readFileSync(path.join(HERE, entry.name), "utf8")) }))

const ASSERTS = /\bpermission\s*\.\s*assert\s*\(/
/** The three ways a refusal can legitimately keep its identity. */
const REPORTS = /\bdenialMessage\s*\(|\bTool\s*\.\s*absorb\s*\(|\bPermissionV2\s*\.\s*DeniedError\b/

/**
 * **Tools that assert a permission and answer a refusal with their OWN words.** Not residue — each
 * line is a deliberate divergence with a reason, and the reason has to survive the next reader.
 */
const OWN_WORDS = new Map<string, string>([
  [
    "community.ts",
    "Names the exact grant a user must give — `community_ask` for a peer, `community_say` for a " +
      "channel — which `denialMessage` cannot, because one mapper serves every op and the wording " +
      "branches on `input.op`. It still detects the refusal through `PermissionV2.DeniedError` " +
      "rather than a private `_tag` compare, so a renamed tag fails the type checker instead of " +
      "silently reverting the tool to its generic line.",
  ],
])

describe("the sweep can actually see the tree", () => {
  test("it found a real source set, not an empty one", () => {
    // Every assertion below is `toEqual([])`. A mis-resolved directory would empty the scan and turn
    // them all into tautologies that pass forever — the exact failure this block makes impossible.
    expect(SOURCES.length).toBeGreaterThan(30)
    expect(SOURCES.some((file) => file.name === "todowrite.ts")).toBe(true)
    expect(SOURCES.some((file) => file.name.endsWith(".test.ts"))).toBe(false)
    // The set the guard is actually about must be non-empty too.
    expect(SOURCES.filter((file) => ASSERTS.test(file.code)).length).toBeGreaterThan(20)
  })

  test("the stripper removes prose without removing the code beside it", () => {
    expect(REPORTS.test(stripComments("// we should call denialMessage here one day"))).toBe(false)
    expect(REPORTS.test(stripComments("/* denialMessage\n * across lines\n */"))).toBe(false)
    expect(REPORTS.test(stripComments("const d = PermissionV2.denialMessage(error)"))).toBe(true)
    // A comment must not be able to HIDE the real call on the next line.
    expect(REPORTS.test(stripComments("// about denialMessage\nconst d = denialMessage(error)"))).toBe(true)
    // A URL's `//` is not a line comment.
    expect(stripComments('const u = "https://x/denialMessage"')).toContain("denialMessage")
    expect(ASSERTS.test(stripComments("// permission.assert( is discussed here"))).toBe(false)
    expect(ASSERTS.test(stripComments("yield* permission.assert({ action: name })"))).toBe(true)
  })
})

describe("every tool that asserts a permission can report a refusal", () => {
  test("no tool absorbs its errors without consulting the denial", () => {
    const offenders = SOURCES.filter((file) => ASSERTS.test(file.code) && !REPORTS.test(file.code)).map(
      (file) => file.name,
    )
    expect(
      offenders,
      [
        "A tool calls `permission.assert` and never reaches `denialMessage`:",
        `  ${offenders.join("\n  ")}`,
        "",
        "  Map its error channel with `Tool.absorb(fallback)`. A refusal MUST arrive as the crafted",
        "  deny-fast paragraph, not as a fallback sentence — a model told only that something failed",
        "  retries, and an unattended run burns on the retry. If this tool genuinely needs its own",
        "  wording, detect the refusal with `PermissionV2.DeniedError` and add it to OWN_WORDS here",
        "  with the reason.",
      ].join("\n"),
    ).toEqual([])
  })

  test("the OWN_WORDS ledger has no dead entries", () => {
    const stale = [...OWN_WORDS.keys()].filter((name) => {
      const file = SOURCES.find((entry) => entry.name === name)
      return !file || !ASSERTS.test(file.code) || /\bTool\s*\.\s*absorb\s*\(/.test(file.code)
    })
    expect(stale, `Delete these lines from OWN_WORDS — they no longer diverge:\n  ${stale.join("\n  ")}`).toEqual([])
  })
})

/**
 * **The messages themselves.** The sweep above proves `denialMessage` is REACHED; these prove what
 * comes out, because "reached" was never the property that broke — `community.ts` reached its own
 * detector and still lost, and a source-level test written for that fix passed anyway *because it
 * only checked the strings existed*. That note is in `community.ts` and it is the reason this block
 * exists.
 */
describe("a refusal arrives as a refusal", () => {
  const denial = () =>
    new PermissionV2.DeniedError({
      rules: [{ action: "js", resource: "*", effect: "deny" }] as never,
      reason: "ask-removed",
    })

  test("denialMessage answers a DeniedError with the deny-fast paragraph", () => {
    const message = PermissionV2.denialMessage(denial())
    expect(message).toBeDefined()
    expect(message).toContain("Permission denied")
    expect(message).toContain("retrying will not change it")
  })

  test("Tool.absorb prefers the denial over its own fallback", async () => {
    const failure = await Effect.runPromise(
      Effect.fail(denial()).pipe(Effect.mapError(Tool.absorb("Unable to run the code")), Effect.flip),
    )
    expect(failure).toBeInstanceOf(ToolFailure)
    expect(failure.message).toContain("Permission denied")
    // 🔴 The pre-fix expressions, kept as the CONTROL. Without them this test would pass against a
    // fallback that happened to contain the word "Permission", and — more to the point — a reader
    // cannot see what was wrong from an assertion that only states what is right.
    const error: unknown = denial()
    expect(error instanceof Error ? error.message : String(error)).toBe("") // js.ts, before
    expect(`computer: ${String(error)}`).toBe("computer: PermissionV2.DeniedError") // computer.ts, before
    expect(failure.message).not.toBe("")
    expect(failure.message).not.toBe("Unable to run the code")
  })

  test("Tool.absorb uses the fallback for everything that is NOT a refusal, and passes a ToolFailure through", async () => {
    const boom = await Effect.runPromise(
      Effect.fail(new Error("socket hung up")).pipe(
        Effect.mapError(Tool.absorb("Unable to run the code")),
        Effect.flip,
      ),
    )
    expect(boom.message).toBe("Unable to run the code")
    // The underlying fault is still attached, so it reaches the log even though the model reads the
    // sentence.
    expect((boom.error as Error | undefined)?.message).toBe("socket hung up")

    const shaped = new ToolFailure({ message: "the tool said this on purpose" })
    const through = await Effect.runPromise(
      Effect.fail(shaped).pipe(Effect.mapError(Tool.absorb("Unable to run the code")), Effect.flip),
    )
    expect(through).toBe(shaped)
  })

  test("a function fallback sees the error", async () => {
    const failure = await Effect.runPromise(
      Effect.fail(new Error("nope")).pipe(
        Effect.mapError(Tool.absorb((error) => `computer: ${String(error)}`)),
        Effect.flip,
      ),
    )
    expect(failure.message).toBe("computer: Error: nope")
  })
})
