import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"

/**
 * 🔴 **Nobody builds their own dial list — the mechanism, not the fix (review 1.9).**
 *
 * `dialableRoutes` already existed as "the §5(i) fix" for exactly this bug and had two callers,
 * while six broadcast paths went on unioning `contacts.bootstrap()` with a raw `peers.list()` and
 * dialling blocked peers. **Fixing it in one place is not a mechanism when six other places build
 * their own** — the same failure as blocking missing two doors and the airgap missing ten.
 *
 * So every `peers.list()` call site is classified here, and a new one fails this ledger until
 * somebody says which kind it is. `dial` is allowed in exactly one file.
 */

const SRC = new URL("../src/", import.meta.url)

/** Comments stripped before any scan: a comment is not evidence, and this file is full of prose. */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

/**
 * Why each file reads the peer table.
 *
 * `dial` — it builds a list of places to SEND to. Must go through `CommunityReach`, which applies
 *          the user's block across both tables and validates every route.
 * `read` — it reports or inspects rows. No socket is opened from what it returns.
 */
const READERS: Record<string, "dial" | "read"> = {
  "community/reach.ts": "dial",
  /** Lists known peers to the agent, and reads one row's introducer for the trust ladder. */
  "tool/community.ts": "read",
}

const filesCalling = (): string[] => {
  const out: string[] = []
  for (const dir of ["community", "tool"]) {
    for (const name of readdirSync(new URL(`${dir}/`, SRC))) {
      if (!name.endsWith(".ts") || name.endsWith(".sql.ts")) continue
      const path = `${dir}/${name}`
      const text = strip(readFileSync(new URL(path, SRC), "utf8"))
      if (/\bpeers\.list\(\)/.test(text)) out.push(path)
    }
  }
  return out.sort()
}

describe("the dial list has ONE builder", () => {
  test("🔴 every file reading the peer table is classified, and only one may DIAL", () => {
    const found = filesCalling()
    // The scan must find something at all — an empty scan satisfies every loop below.
    expect(found.length, "the scan must find the call sites").toBeGreaterThan(0)
    expect(found, "a new peers.list() caller must declare whether it dials or reads").toEqual(
      Object.keys(READERS).sort(),
    )
    expect(
      Object.entries(READERS)
        .filter(([, kind]) => kind === "dial")
        .map(([file]) => file),
      "only the shared builder may assemble a dial list",
    ).toEqual(["community/reach.ts"])
  })

  test("🔴 the diallers call the builder rather than the table", () => {
    // Named individually because these are the six the review found building their own: if one of
    // them stops going through `CommunityReach` this fails, whatever it does instead.
    for (const file of ["community/transport.ts", "community/sync.ts", "community/search.ts"]) {
      const text = strip(readFileSync(new URL(file, SRC), "utf8"))
      expect(text, `${file} dials, so it must use the shared list`).toContain("CommunityReach.")
      expect(/\bpeers\.list\(\)/.test(text), `${file} must not re-derive the list from the table`).toBe(false)
    }
  })

  test("⚠️ and the control: the scan can tell a stripped comment from a call", () => {
    expect(strip("/* peers.list() */ const x = 1")).not.toContain("peers.list()")
    expect(strip("const known = yield* peers.list()")).toContain("peers.list()")
  })
})
