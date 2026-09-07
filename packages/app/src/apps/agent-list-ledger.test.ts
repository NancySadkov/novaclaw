import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@novaclaw/core/agent"
import { listAgents } from "./agent-list"

/**
 * THE LEDGER THAT DOES NOT DEPEND ON SOMEBODY REMEMBERING.
 *
 * `agent-list.test.ts` beside this one checks field survival ONE TEST PER FIELD, and every one of
 * those tests was written AFTER that field was lost — `workspace` first, then `paused`, which killed
 * the roster badge and made Resume unreachable. A hand-kept ledger for a hand-kept subset catches
 * exactly the fields somebody thought to add, which is the defect it exists to prevent.
 *
 * 🔴 So this one is derived from the SOURCE: every field the wire schema declares must either survive
 * `listAgents` or be named in {@link NOT_CARRIED} with a reason. Adding a field to `AgentV2.Info` fails
 * here until somebody decides which it is. That is the standing constraint in `notes/named-agents.md`
 * — *"derive from the schema with a reasoned exclusion list, or ledger against the SOURCE's keys"* —
 * applied to the loader that broke it.
 *
 * ⚠️ It asserts on the SHAPE, not on a value round-trip: a value check needs a type-correct sentinel
 * per field and would drift into testing the mapper's coercions. Presence is what was lost both
 * times.
 */

/** Fields the roster row deliberately does not carry, each with the reason it is absent. */
const NOT_CARRIED: Readonly<Record<string, string>> = {
  // Authored config, spread wholesale into `config` rather than lifted to the top level.
  request: "provider request body — reaches the UI through `config`, not as a roster field",
  permissions: "a ruleset is not roster copy; `self` and the permission evaluator read it directly",
  strict: "harness override, read per-session rather than drawn on a tile",
  system: "the brief is fetched when a dialog opens, not carried in a list of every colleague",
  directory: "read from `config.directory`; `workspace` is the derived path a tile actually uses",
}

describe("every field the wire schema declares is accounted for", () => {
  const declared = Object.keys(AgentV2.Info.fields)

  test("🔴 the schema has fields to check — the ledger is not vacuously green", () => {
    // Without this, a rename of `AgentV2.Info.fields` would empty the loop and this file would pass forever
    // while checking nothing. The prompt-accounting ledger failed exactly this way.
    expect(declared.length).toBeGreaterThan(10)
    expect(declared).toContain("paused")
    expect(declared).toContain("workspace")
  })

  test("🔴 each is either CARRIED by the loader or named as deliberately absent", async () => {
    // A row that carries EVERY declared field, so absence in the output means the loader dropped it
    // rather than the fixture never having sent it. Sentinels are type-shaped because the mapper
    // coerces (`text()` keeps strings, `paused` tests `=== true`), and a wrongly-typed sentinel would
    // report a carried field as lost.
    const full: Record<string, unknown> = {
      id: "wren",
      mode: "primary",
      hidden: false,
      paused: true,
      name: "Wren",
      title: "Writer",
      description: "writes",
      personality: "brief",
      superior: "nova",
      system: "the brief",
      avatar: "W",
      memory: "own",
      status: { task: "reviewing the P2P handshake", observed: 1_700_000_000_000 },
      workspace: "C:/data/scratch/wren",
      directory: "C:/work",
      model: { providerID: "spark", id: "holo" },
      color: "amber",
      steps: 4,
      archiveChats: true,
      shortChat: true,
      reground: false,
      needsTier: "mid",
      reasoningBudget: 0,
      permissionMode: "build",
      strict: { enabled: true },
      permissions: [],
      request: {},
    }
    for (const field of declared) expect(full).toHaveProperty(field)

    const [row] = await listAgents({
      agent: { list: async () => ({ data: { data: [full] } }) },
    } as never)
    // Carried at the TOP LEVEL, or inside `config` — the authored subset is spread wholesale there,
    // and a field a tile reads out of `config` is not lost.
    const carried = new Set([...Object.keys(row ?? {}), ...Object.keys((row?.config ?? {}) as object)])
    const missing = declared.filter((field) => !carried.has(field) && NOT_CARRIED[field] === undefined)
    expect(missing).toEqual([])
  })

  test("⚠️ the exclusion list names nothing the schema has dropped", () => {
    // An exclusion for a field that no longer exists is a stale excuse, and it hides the next one.
    expect(Object.keys(NOT_CARRIED).filter((field) => !declared.includes(field))).toEqual([])
  })
})
