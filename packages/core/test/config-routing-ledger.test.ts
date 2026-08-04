import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Schema } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { Config } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { PluginConfigStore } from "@novaclaw/core/plugin-config-store"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigSeed } from "@novaclaw/core/settings-config-seed"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { testEffect } from "./lib/effect"

/**
 * **Every `Config.Info` key is routed into a store, or it is on the ledger with a reason.** This is
 * the check that makes that sentence true rather than aspirational.
 *
 * ⚠️ Why a guard and not a comment. `config-store-write.ts` used to say, in prose, that a new
 * `Config.Info` key "must be routed here … an unrouted key is a silent data-loss bug". That is a
 * normative claim about a DIFFERENT file (`config.ts`, where the field is declared), which is
 * exactly the defect class todo.md ruling 1 names: adding a field without a router arm compiles
 * green, typechecks green, and ships a `PATCH /config` that answers **200 for a write that
 * vanished**. It had already happened once — `models` (the models-primary flat map) was a declared
 * key that decoded cleanly, routed nowhere and reported success, fixed in v0.2.0-prep Wave 1. This
 * file is the class-level version of that per-key fix.
 *
 * The stakes are not cosmetic here, because of the **self-healing law** (AGENTS.md): the entire
 * repair story is "a lay user whose provider moved its servers asks any still-working model to fix
 * it". An agent that PATCHes a key, gets a 200, re-reads and finds nothing cannot tell "I typed the
 * wrong key" from "this instance is broken" — so it loops.
 *
 * The ledger is a RATCHET: it fails in both directions. A `Config.Info` key that routes nowhere and
 * is not listed fails outright; a listed key that no longer exists (or that now routes) fails with
 * "drop the ledger entry", so the list can only shrink.
 *
 * ⚠️ **Measured 2026-07-29, and it bounds what this file can claim:** the only key unrouted today is
 * `$schema`, which is deliberate. So this is a guard against the NEXT key, not a live bug being
 * closed — the live-bug half was `models`, and that is already fixed. The other live half, an
 * entirely *unknown* top-level key dropped by the payload decode before `apply` ever saw it, was a
 * layer up and out of this file's reach; it is **closed too** (`rejectUnknownConfigKeys`, 2026-07-29,
 * covered by `packages/novaclaw/test/server/httpapi-config-unknown-key.test.ts`). See
 * `ConfigStoreWrite.unroutedKeys`' ⚠️ note for why the two guards answer differently.
 */

/** `packages/core/test` → `packages/core`. */
const CORE = path.resolve(import.meta.dir, "..")
const ROUTER_PATH = path.join(CORE, "src", "config-store-write.ts")

/** The comment stripper `kill-tree-ledger.test.ts` uses — `//` must not eat the `//` in a URL. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

/**
 * CODE ONLY. The header of the router quotes several of the key names it routes, so reading the
 * raw file would let a prose mention masquerade as a router arm.
 */
const ROUTER_SOURCE = stripComments(fs.readFileSync(ROUTER_PATH, "utf8"))

/**
 * The two array literals the router's table-driven arms live in, extracted whole so a `key: "…"`
 * inside them can be read without a bare `key:` regex over the file — which would let any unrelated
 * object literal widen the routed set and excuse a key nobody routes.
 *
 * Returns `""` when the table is gone, and the sweep test below fails on that rather than letting
 * the routed set silently shrink (the same "actually has the router to look at" discipline).
 */
const armTable = (name: string): string =>
  ROUTER_SOURCE.match(new RegExp(`const ${name} = \\[[\\s\\S]*?\\n\\]`))?.[0] ?? ""

const LAYERED_TABLE = armTable("LAYERED_ARMS")
const LIST_TABLE = armTable("LIST_ARMS")

/**
 * The keys routed by a per-key arm, read out of the router itself rather than re-declared here.
 * There are TWO forms since the Wave-4 factory collapse, and BOTH must be read or the partition
 * below goes unsound in the silent direction — a key that really routes would look unrouted, and
 * the fix somebody reached for would be a second router arm writing the same store twice.
 *  · Three are still hand-written `if (patch.<key> !== undefined) { … consumed.add("<key>") }`
 *    blocks, because each does something no table row could express: `models` runs the flat→nested
 *    expansion and must land AFTER `providers`, while `model` and `default_agent` are single
 *    whole-value writes into a `*_setting` table.
 *  · Six are ROWS in `LAYERED_ARMS` / `LIST_ARMS`, whose `key:` field the loop hands to
 *    `consumed.add(arm.key)`.
 * Together they are the whole drift surface: forgetting one is what this file exists to catch.
 */
const LITERAL_ROUTED = [...ROUTER_SOURCE.matchAll(/consumed\.add\("([^"]+)"\)/g)].map((match) => match[1]!)

const TABLE_ROUTED = [LAYERED_TABLE, LIST_TABLE].flatMap((table) =>
  // `\r?` because the router is checked out CRLF on Windows and `$` would otherwise never match.
  [...table.matchAll(/^[ \t]*key: "([^"]+)",[ \t]*\r?$/gm)].map((match) => match[1]!),
)

const STORE_ROUTED = new Set<string>([...LITERAL_ROUTED, ...TABLE_ROUTED])

/**
 * The settings half routes by ITERATING `SETTINGS_KEYS` (`consumed.add(key)`, a variable), so it
 * cannot drift from its own declaration the way the nine `if`s can — a key joins the constant and
 * is routed in the same edit. Treating the constant as the routed set is therefore a fact, not a
 * claim; the sweep below asserts the loop is still what the router does.
 */
const SETTINGS_ROUTED = new Set<string>(SettingsConfigSeed.SETTINGS_KEYS)

const ROUTED = new Set<string>([...SETTINGS_ROUTED, ...STORE_ROUTED])

/** The authored schema — the one place a config key is declared (todo.md, Runtime ground truth §4). */
const CONFIG_INFO_KEYS = Object.keys(Config.Info.fields)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      AgentConfigStore.node,
      CatalogStore.node,
      CommandConfigStore.node,
      PluginConfigStore.node,
      ReferenceConfigStore.node,
      SettingsConfigStore.node,
      SkillConfigStore.node,
    ]),
  ),
)

const decodeInfo = Schema.decodeUnknownSync(Config.Info)

describe("the sweep", () => {
  test("actually has the router to look at", () => {
    // A moved file or a bad strip would silently empty every set below and turn the assertions into
    // tautologies that pass forever.
    expect(fs.existsSync(ROUTER_PATH), `${ROUTER_PATH} is gone — repoint the sweep`).toBe(true)
    expect(ROUTER_SOURCE.length).toBeGreaterThan(2_000)
    expect(CONFIG_INFO_KEYS.length).toBeGreaterThan(30)
    // …including the two arm TABLES. A renamed or reshaped table would otherwise make `armTable`
    // return "" and quietly drop six routed keys out of the sweep, which the partition test would
    // then report as six unrouted `Config.Info` fields — a loud failure with a misleading cause.
    expect(LAYERED_TABLE, "LAYERED_ARMS is gone from the router — repoint the sweep").not.toBe("")
    expect(LIST_TABLE, "LIST_ARMS is gone from the router — repoint the sweep").not.toBe("")
  })

  test("the settings half is still a loop over SETTINGS_KEYS, not a hand-written list", () => {
    // If this stops being true, `SETTINGS_ROUTED` becomes a claim about another file rather than a
    // reading of this one, and the whole partition below is unsound.
    expect(ROUTER_SOURCE).toContain("for (const key of SettingsConfigSeed.SETTINGS_KEYS)")
    expect(ROUTER_SOURCE).toContain("consumed.add(key)")
    expect(SETTINGS_ROUTED.size).toBeGreaterThan(20)
  })

  test("the nine per-key arms are what the sweep found", () => {
    // Named explicitly so that DELETING an arm fails here too — the regex alone would just return a
    // shorter list and the partition test would blame `config.ts` for a key the router lost.
    expect([...STORE_ROUTED].sort()).toEqual([
      "agents",
      "commands",
      "default_agent",
      "model",
      "models",
      "plugins",
      "providers",
      "references",
      "skills",
    ])
  })

  test("…and the 3/6 split between the hand-written arms and the table rows is what it claims", () => {
    // The union above would still pass if a table row were quietly rewritten as a hand-written `if`,
    // or a special-cased arm folded into a row it cannot express — so pin WHICH form each key uses.
    // Moving one is legitimate; doing it without noticing is what this line prevents.
    expect([...LITERAL_ROUTED].sort()).toEqual(["default_agent", "model", "models"])
    expect([...TABLE_ROUTED].sort()).toEqual(["agents", "commands", "plugins", "providers", "references", "skills"])
  })

  test("every routed key is a real Config.Info key", () => {
    // A typo in `consumed.add("provder")` would otherwise widen the routed set and excuse the very
    // key it failed to route.
    const phantom = [...ROUTED].filter((key) => !CONFIG_INFO_KEYS.includes(key)).sort()
    expect(phantom).toEqual([])
  })
})

describe("every Config.Info key routes, or is on the ledger", () => {
  test("no key is silently dropped", () => {
    const unrouted = CONFIG_INFO_KEYS.filter(
      (key) => !ROUTED.has(key) && !ConfigStoreWrite.NOT_ROUTED_KEYS.has(key),
    ).sort()
    // Give the key a router arm in packages/core/src/config-store-write.ts (or join it to
    // SettingsConfigSeed.SETTINGS_KEYS, which routes automatically). If it genuinely must be
    // accepted and discarded, add it to `ConfigStoreWrite.NOT_ROUTED_KEYS` WITH ITS REASON — and
    // expect that reason to be read.
    expect(unrouted).toEqual([])
  })

  test("the ledger can only SHRINK — a routed or vanished entry must be deleted from it", () => {
    const stale: string[] = []
    for (const [key, reason] of ConfigStoreWrite.NOT_ROUTED_KEYS) {
      if (!CONFIG_INFO_KEYS.includes(key)) stale.push(`${key} (no longer a Config.Info key — drop the ledger entry)`)
      else if (ROUTED.has(key)) stale.push(`${key} (now routes into a store — drop the ledger entry)`)
      if (reason.trim().length < 40)
        stale.push(`${key} (the ledger entry has no real reason — say why the key is accepted and discarded)`)
    }
    expect(stale).toEqual([])
  })

  test("today the ledger is exactly `$schema`, and that is the whole live gap", () => {
    // Pinned as a MEASUREMENT, not a preference: it is the honest answer to "how much is this guard
    // actually catching today". If a second key ever appears here, that is a decision somebody made
    // and this line is where it gets noticed.
    expect([...ConfigStoreWrite.NOT_ROUTED_KEYS.keys()]).toEqual(["$schema"])
  })
})

describe("the router refuses an unrouted key at runtime", () => {
  // The declaration above is a reading of the source; this is the behaviour. Both are needed — a
  // ledger that agrees with a router that does not enforce it is the guard-shaped no-op.
  it.effect("faults the whole write BY NAME, and nothing it already wrote survives", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsConfigStore.Service
      yield* settings.set("shell", "before-the-refused-write")

      // A test cannot add a field to `Config.Info`, so it builds the exact shape the check reads:
      // a decoded patch carrying one extra own key that no arm consumes — which is what a newly
      // declared field with no router arm looks like to `unroutedKeys`.
      const patch = decodeInfo({ shell: "after-the-refused-write" })
      ;(patch as unknown as Record<string, unknown>).future_key = { some: "value" }

      const exit = yield* ConfigStoreWrite.apply(patch).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const message = Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "<the write SUCCEEDED>"
      // Named, not merely refused: "something went wrong" would leave the agent in the same loop.
      expect(message).toContain("future_key")

      // …and it is a refusal, not a partial apply. The settings arm runs BEFORE the check, so an
      // un-transacted guard would leave this write committed under a reported failure — ruling 2's
      // problem in the mirror.
      expect((yield* settings.all()).shell).toBe("before-the-refused-write")
    }),
  )

  it.effect("`$schema` rides along without faulting and without being counted as stored", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsConfigStore.Service
      // The real import path: the Import button PATCHes the user's whole jsonc document, and a
      // hand-authored one normally opens with `$schema`. Refusing it would break importing the
      // archive the product tells people to import.
      const consumed = yield* ConfigStoreWrite.apply(
        decodeInfo({ $schema: "https://novaclaw.app/config.json", shell: "pwsh" }),
      )
      expect([...consumed]).toEqual(["shell"])
      expect((yield* settings.all()).shell).toBe("pwsh")
    }),
  )

  it.effect("every hand-written arm really consumes the key the sweep read out of it", () =>
    Effect.gen(function* () {
      // Ties the source reading to runtime: an arm that stops routing (or a `consumed.add` moved out
      // of its `if`) fails here, and a NEW arm fails until this patch is taught to exercise it.
      const consumed = yield* ConfigStoreWrite.apply(
        decodeInfo({
          providers: { spark: { name: "Spark", models: { m1: { name: "M1" } } } },
          models: { flat: { url: "http://127.0.0.1:8000/v1", name: "Flat" } },
          model: "flat",
          agents: { build: { description: "the builder" } },
          default_agent: "build",
          commands: { deploy: { template: "run it" } },
          references: { docs: { path: "/docs" } },
          skills: ["/opt/skills"],
          plugins: ["team-plugin@1.0.0"],
        }),
      )
      expect([...consumed].sort()).toEqual([...STORE_ROUTED].sort())
    }),
  )
})

describe("the guard actually bites (negative control)", () => {
  test("the predicate names the offender and stays silent on everything else", () => {
    // The runtime tests above assert an EMPTY offender list in the happy cases, which alone cannot
    // show that a non-empty one is reachable. This exercises the predicate directly.
    const patch = {
      shell: "bash",
      $schema: "https://novaclaw.app/config.json",
      future_key: { some: "value" },
      never_set: undefined,
    } as unknown as Config.Info

    expect(ConfigStoreWrite.unroutedKeys(patch, new Set(["shell"]))).toEqual(["future_key"])
    // A key the router did consume is not an offender…
    expect(ConfigStoreWrite.unroutedKeys(patch, new Set(["shell", "future_key"]))).toEqual([])
    // …and neither is an absent optional field, which is an own key on a class instance.
    expect(ConfigStoreWrite.unroutedKeys(patch, new Set(["shell", "future_key"]))).not.toContain("never_set")
    // The ledgered key is excused on its own, with nothing consumed at all.
    expect(ConfigStoreWrite.unroutedKeys(decodeInfo({ $schema: "x" }), new Set())).toEqual([])
  })

  test("removing the ledger would make `$schema` an offender — the excuse is doing work", () => {
    // The other half of the control: `$schema` passes because the LEDGER excuses it, not because
    // the predicate happens to ignore keys beginning with `$`.
    const bare = (patch: Config.Info, consumed: ReadonlySet<string>) => {
      const values = patch as unknown as Record<string, unknown>
      return Object.keys(values).filter((key) => values[key] !== undefined && !consumed.has(key))
    }
    expect(bare(decodeInfo({ $schema: "x" }), new Set())).toEqual(["$schema"])
  })
})
