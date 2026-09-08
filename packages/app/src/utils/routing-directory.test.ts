import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  instanceGlobalDirectory,
  resolveInstanceGlobalDirectory,
  scopedDirectory,
  type DirectoryResolvable,
} from "@/utils/routing-directory"
import { stripComments } from "./strip-comments"

/**
 * **The two directory answers, and the fact that they are two.**
 *
 * Eighteen sites resolved this inline in two orders. The sweep read that as one duplication and
 * prescribed a single order; the tree disagrees, in writing, at both ends — `trash.tsx` and
 * `registry.tsx` say the value is *only* a routing token for a global store, and
 * `settings-v2/project-copy.ts` says the Project section's subject is the routed directory *by
 * design*. So the expression was de-duplicated and the two ANSWERS were kept and named.
 *
 * ⚠️ Which makes the first test below the important one: it pins that the two disagree, and on
 * exactly the input where it matters. A refactor that quietly made them the same function would
 * make this file fail rather than make a Settings screen read the wrong `novaclaw.json`.
 */

describe("the two orders are two decisions, not a drift", () => {
  test("they disagree precisely when the instance is pointed at a project folder", () => {
    const routed = { home: "C:/Users/nancy", directory: "C:/work/novaclaw" }
    // The whole finding, in two lines.
    expect(scopedDirectory(routed)).toBe("C:/work/novaclaw")
    expect(instanceGlobalDirectory(routed)).toBe("C:/Users/nancy")
  })

  test("they agree on every other shape", () => {
    for (const path of [
      { home: "C:/Users/nancy", directory: "C:/Users/nancy" },
      { home: "C:/Users/nancy" },
      { directory: "C:/work" },
      { home: "", directory: "C:/work" },
      { home: "C:/Users/nancy", directory: "" },
      {},
      undefined,
    ])
      expect(scopedDirectory(path)).toBe(instanceGlobalDirectory(path))
  })

  test('absence is "" — falsy, because every caller gates its request on that', () => {
    // A resource keyed on the empty string stays pending; one keyed on `undefined` would too, but
    // four call sites type the value as `string`, and a `?directory=undefined` on the wire is a 400
    // that names a path the user never typed.
    expect(scopedDirectory(undefined)).toBe("")
    expect(instanceGlobalDirectory({})).toBe("")
    expect(scopedDirectory({ home: "", directory: "" })).toBe("")
  })
})

describe("resolveInstanceGlobalDirectory — the read that was written out three times", () => {
  const ctx = (
    stored: { home?: string; directory?: string } | undefined,
    answer: () => Promise<{ data?: { home?: string; directory?: string } }>,
  ): DirectoryResolvable => ({
    sync: { data: { path: stored } },
    sdk: { client: { path: { get: answer } } },
  })

  test("the store wins, and NO request is made when it has answered", async () => {
    let calls = 0
    const value = await resolveInstanceGlobalDirectory(
      ctx({ home: "C:/Users/nancy", directory: "C:/work" }, async () => {
        calls += 1
        return { data: { home: "C:/never" } }
      }),
    )
    expect(value).toBe("C:/Users/nancy")
    expect(calls).toBe(0)
  })

  test("an empty store falls back to GET /path", async () => {
    let calls = 0
    const value = await resolveInstanceGlobalDirectory(
      ctx(undefined, async () => {
        calls += 1
        return { data: { home: "C:/Users/nancy", directory: "C:/work" } }
      }),
    )
    expect(value).toBe("C:/Users/nancy")
    expect(calls).toBe(1)
  })

  test('a store holding only "" also falls back — truthiness is the readiness test', async () => {
    const value = await resolveInstanceGlobalDirectory(
      ctx({ home: "", directory: "" }, async () => ({ data: { home: "C:/fetched" } })),
    )
    expect(value).toBe("C:/fetched")
  })

  test("a failed GET /path REJECTS — it is never folded into an answer", async () => {
    // 🔴 The behaviour this function was changed to have, and the reason it is worth a test of its
    // own. It used to swallow the rejection and return "", which every caller reads as "not asked
    // yet" — so a broken path lookup produced a spinner that would never resolve, on three pages at
    // once. `""` and a rejection are now different facts, and only `createSettledResource` may turn
    // the second one back into a value.
    const read = resolveInstanceGlobalDirectory(ctx(undefined, () => Promise.reject(new Error("offline"))))
    await expect(read).rejects.toThrow("offline")
  })

  test('a 200 with no body is an ANSWER of "", not a failure', async () => {
    // The other side of the same line: the instance replied and has neither a home nor a routed
    // directory. Callers separate this from the rejection above with `answeredNothing`.
    expect(await resolveInstanceGlobalDirectory(ctx(undefined, async () => ({})))).toBe("")
  })
})

/**
 * **The site sweep.** Ruling 1: an invariant with no mechanical check does not exist, and "nobody
 * re-invents this expression" is exactly the kind that decays one plausible-looking file at a time —
 * it already decayed into eighteen.
 */
describe("nothing resolves the routing directory by hand any more", () => {
  const SRC = path.resolve(import.meta.dir, "..")
  const SELF = path.resolve(import.meta.dir, "routing-directory.test.ts")
  const OWNER = path.resolve(import.meta.dir, "routing-directory.ts")

  /** `x.directory || y.home` / `x.home || y.directory`, however the two sides are spelled. */
  const BY_HAND = /\.\s*directory\s*\|\|[^\n]*?\.\s*home\b|\.\s*home\s*\|\|[^\n]*?\.\s*directory\b/

  const collect = (dir: string, out: { name: string; code: string }[] = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue
        collect(full, out)
      } else if (/\.tsx?$/.test(entry.name) && full !== SELF && full !== OWNER) {
        out.push({
          name: path.relative(SRC, full).replaceAll("\\", "/"),
          code: stripComments(fs.readFileSync(full, "utf8")),
        })
      }
    }
    return out
  }
  const SOURCES = collect(SRC)

  /**
   * The sites that legitimately still name both fields, and why. This list may only ever SHRINK.
   */
  const ALLOWED = new Map<string, string>([
    [
      "components/dialog-select-directory-v2.tsx",
      "Not a routing decision: it asks whether the instance has ANY base at all, to decide whether " +
        "the picker can open. Neither order applies — the question is the disjunction itself.",
    ],
    [
      "pages/files.tsx",
      "The file browser's START directory, not a request-routing token. Home is where a person " +
        "expects a file browser to open; the routed folder is reachable from the places list.",
    ],
  ])

  test("the sweep sees a real tree", () => {
    expect(SOURCES.length).toBeGreaterThan(200)
    expect(SOURCES.some((file) => file.name === "pages/trash.tsx")).toBe(true)
    // The detector must actually detect. If this stops matching, every assertion below is a
    // tautology.
    expect(BY_HAND.test("const d = p?.directory || p?.home || ''")).toBe(true)
    expect(BY_HAND.test("const d = path.home || path.directory")).toBe(true)
    expect(BY_HAND.test("const d = sync().data.path.directory || sync().data.path.home")).toBe(true)
    expect(BY_HAND.test(stripComments("// path.directory || path.home is discussed here"))).toBe(false)
    expect(BY_HAND.test("const d = scopedDirectory(path)")).toBe(false)
  })

  test("no file outside the ledger resolves it inline", () => {
    const found = SOURCES.filter((file) => BY_HAND.test(file.code) && !ALLOWED.has(file.name)).map((file) => file.name)
    expect(
      found,
      [
        "A file resolves the routing directory by hand:",
        `  ${found.join("\n  ")}`,
        "",
        "  Use `scopedDirectory(path)` when the folder is the SUBJECT of the screen (a project file,",
        "  a policy, a skill, a draft), or `instanceGlobalDirectory(path)` when it is only a routing",
        "  token for an install-wide store (trash, registry, scheduler, memory graph, pty). Picking",
        "  the wrong one is a screen that reads the wrong folder, which is why they are named.",
      ].join("\n"),
    ).toEqual([])
  })

  test("the ledger has no dead entries", () => {
    const stale = [...ALLOWED.keys()].filter((name) => {
      const file = SOURCES.find((entry) => entry.name === name)
      return !file || !BY_HAND.test(file.code)
    })
    expect(stale, `Delete these lines from ALLOWED:\n  ${stale.join("\n  ")}`).toEqual([])
  })
})
