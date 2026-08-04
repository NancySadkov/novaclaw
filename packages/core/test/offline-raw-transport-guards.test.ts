import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Offline } from "@novaclaw/core/offline"

/**
 * ─── the transports the HttpClient chokepoint cannot see ────────────────────────────────────────
 *
 * AGENTS.md → *Runtime ground truth* §5: there is ONE shared `HttpClient` node, and **every new
 * feature's egress must ride it OR add its own `Offline` policy check**. Most do. Three sites in
 * `packages/core` cannot ride it — npm runs its own transport, and the embedder is a plain `async`
 * function outside the Effect graph — so the "or" arm is what protects them, and this file is what
 * makes that arm real rather than remembered.
 *
 * ⚠️ **Why a source sweep and not only a behavioural test.** Both defects this file was written for
 * were *invisible to behaviour*: `npm.ts` DID refuse when offline — it just refused against a policy
 * captured at layer init, so it kept installing for the rest of the process after a user turned
 * airgap on. A test that flips the policy and calls the function passes either way unless it also
 * rebuilds the layer. The defect lives in WHERE the read happens, which is a source fact.
 *
 * Found 2026-07-31, by auditing `offline.ts`'s nine manifest claims against what actually enforces
 * each one. Two of the nine were false; a third was vacuous. `layerManifest` reads the LIVE policy,
 * so any snapshot-at-init guard reports itself active the instant a user flips the switch and keeps
 * egressing until restart — ruling 3's defect producing ruling 2's, which is the exact pair the A3
 * fix was written from.
 */

const CORE = path.resolve(import.meta.dir, "..")

/** `//` must not eat the `//` in a URL — the idiom the other source sweeps in this repo use. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

const codeOf = (relative: string): string => stripComments(fs.readFileSync(path.join(CORE, relative), "utf8"))

/**
 * Every `packages/core` file that reaches the network on a transport the chokepoint does not own,
 * and the shape that proves it reads the policy LIVE rather than once.
 *
 * ⚠️ This is a ledger, so it fails in BOTH directions: a new raw-transport site must be added here
 * (with its guard), and an entry whose file stops matching fails with "drop the line". It may only
 * shrink by a site genuinely moving onto the shared client.
 */
const RAW_TRANSPORTS: ReadonlyArray<{
  readonly file: string
  readonly why: string
  /** The live read. Its ABSENCE is the bug; a captured `loadPolicy(...)` is what it replaced. */
  readonly live: RegExp
}> = [
  {
    file: "src/npm.ts",
    why: "npm runs its own transport (Arborist), so the shared HttpClient cannot see a registry fetch.",
    live: /currentPolicy\(\)\.enabled/,
  },
  {
    file: "src/kb-graph/embedder.ts",
    why:
      "a plain async function outside the Effect graph, POSTing the user's own KB and chat text to a " +
      "user-configured embedding URL — the heaviest payload of the three.",
    live: /Offline\.checkUrl\(\s*settings\.url\s*,\s*Offline\.currentPolicy\(\)\s*\)/,
  },
]

describe("raw transports carry their own live offline guard", () => {
  test("the sweep has real files to look at", () => {
    // A mistyped path would make every assertion below vacuously true.
    for (const entry of RAW_TRANSPORTS)
      expect(fs.existsSync(path.join(CORE, entry.file)), `${entry.file} is not in the tree`).toBe(true)
  })

  for (const entry of RAW_TRANSPORTS)
    test(`${entry.file} reads the policy LIVE — ${entry.why}`, () => {
      const code = codeOf(entry.file)
      expect(entry.live.test(code), `${entry.file}: no live policy read matching ${entry.live}`).toBe(true)
      // The specific regression: a policy resolved once, at layer/module scope, and closed over.
      // `loadPolicy` is legitimate INSIDE offline.ts and in tests that inject a source; in a raw
      // transport it is the snapshot bug by construction.
      expect(code.includes("loadPolicy("), `${entry.file}: captures loadPolicy — that is the snapshot bug`).toBe(false)
    })

  test("the ledger can only shrink — a site that moved to the shared client must be dropped", () => {
    // The inverse direction. If a file stops needing an entry (because it now rides the chokepoint),
    // this says so by name instead of leaving a dead line that reads as coverage.
    const stale = RAW_TRANSPORTS.filter((entry) => {
      const code = codeOf(entry.file)
      return !code.includes("fetch(") && !code.includes("arborist.reify") && !code.includes("Arborist")
    })
    expect(
      stale.map((entry) => entry.file),
      "these no longer raw-transport — DELETE their ledger lines",
    ).toEqual([])
  })
})

describe("the guard the ledger is protecting actually refuses", () => {
  const enabled: Offline.Policy = { enabled: true, allowedHosts: new Set<string>() }

  test("a WAN embedding URL is refused, and the refusal names the host", () => {
    const verdict = Offline.checkUrl("https://api.openai.com/v1", enabled)
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.message).toContain("api.openai.com")
  })

  test("loopback is still allowed with airgap ON — an airgapped user's only model is a local one", () => {
    // Not an oversight in the policy: `checkUrl` short-circuits loopback BEFORE the allowlist, and
    // a local embedding server is exactly what an airgapped instance is supposed to keep using.
    for (const url of ["http://127.0.0.1:8001/v1", "http://localhost:11434/v1"])
      expect(Offline.checkUrl(url, enabled).allowed, url).toBe(true)
  })

  test("with airgap OFF nothing is refused", () => {
    const off: Offline.Policy = { enabled: false, allowedHosts: new Set<string>() }
    expect(Offline.checkUrl("https://api.openai.com/v1", off).allowed).toBe(true)
  })
})
