import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { CatalogSeed } from "@novaclaw/core/catalog-seed"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { NovaHealth } from "@novaclaw/core/nova-health"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

/**
 * 🔴 **A config document that cannot be read must reach the person, not just the log.**
 *
 * Decoding is all-or-nothing per document, so one malformed provider entry costs every provider,
 * agent and command in that file. That loss used to reach nobody: a log line, readable only in
 * Developer mode by someone who already knew the event's name, met much later as *"every turn fails
 * model resolution"* — a symptom naming the wrong subsystem.
 *
 * ⚠️ **The reading is RE-DERIVED, and the last test here is the one that proves why.** A drop
 * recorded when the seed ran would go stale the instant the user fixed the file, and a health screen
 * confidently reporting a repaired problem is worse than one that says nothing.
 */
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, FSUtil.node])))

const withConfig = (root: string, name: string, body: string) =>
  Effect.promise(async () => {
    const dir = path.join(root, "config")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, name), body)
    return dir
  })

describe("an unreadable config document surfaces", () => {
  it.effect("🔴 malformed JSON is reported with the FILE and the REASON", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const configDir = yield* withConfig(dir.path, "novaclaw.jsonc", "{ this is not json")

      const unreadable = yield* CatalogSeed.unreadableDocuments(configDir)
      expect(unreadable.length).toBe(1)
      expect(unreadable[0]!.path).toContain("novaclaw.jsonc")
      expect(unreadable[0]!.notice).toContain("not valid JSON")

      const signal = NovaHealth.fromConfigDocument({ unreadable })
      expect(signal.status).toBe("problem")
      // The FILE, because "a config file is invalid" sends someone to the wrong one when they keep
      // more than one; and the REASON, because "invalid" alone does not say what to change.
      expect(signal.detail).toContain("novaclaw.jsonc")
      expect(signal.detail).toContain("not valid JSON")
      // An honest action, never comfort.
      expect(signal.action).toBeDefined()
    }),
  )

  it.effect("a document that is valid JSON but the wrong SHAPE is reported differently", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      // Valid JSON, but `providers` must not be a string — the case that costs a user every provider
      // in the file while looking perfectly fine to a human skim.
      const configDir = yield* withConfig(dir.path, "novaclaw.jsonc", JSON.stringify({ providers: "nope" }))

      const unreadable = yield* CatalogSeed.unreadableDocuments(configDir)
      expect(unreadable.length).toBe(1)
      expect(unreadable[0]!.notice).toContain("did not match the config schema")
    }),
  )

  it.effect("NEGATIVE CONTROL: a readable document reports nothing, and an absent one reports nothing", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const configDir = yield* withConfig(dir.path, "novaclaw.jsonc", JSON.stringify({ username: "fine" }))

      // Without this the check above would pass on an implementation that flags every file it finds.
      expect(yield* CatalogSeed.unreadableDocuments(configDir)).toEqual([])
      expect(NovaHealth.fromConfigDocument({ unreadable: [] }).status).toBe("ok")

      // An empty config dir is the common case and must be silent, not "unknown".
      const empty = path.join(dir.path, "empty-config")
      yield* Effect.promise(() => fs.mkdir(empty, { recursive: true }))
      expect(yield* CatalogSeed.unreadableDocuments(empty)).toEqual([])
    }),
  )

  it.effect("🔴 FIXING the file clears the row — which is why this is re-derived, not remembered", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const configDir = yield* withConfig(dir.path, "novaclaw.jsonc", "{ broken")
      expect((yield* CatalogSeed.unreadableDocuments(configDir)).length).toBe(1)

      // The user repairs it. A notice persisted at seed time would still be claiming a problem here,
      // and a health board that reports a repaired fault is worse than one that reports nothing.
      yield* Effect.promise(() =>
        fs.writeFile(path.join(configDir, "novaclaw.jsonc"), JSON.stringify({ username: "fixed" })),
      )
      expect(yield* CatalogSeed.unreadableDocuments(configDir)).toEqual([])
    }),
  )
})
