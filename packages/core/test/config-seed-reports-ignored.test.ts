import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Logger } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { ConfigSeedStartup } from "@novaclaw/core/config-seed-startup"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

/**
 * 🔴 **A config file that is present and does NOT apply must say so.**
 *
 * Every first-boot seed is `isEmpty`-gated, so an authored `novaclaw.jsonc` applies on the boot where
 * its stores are empty and is inert on every boot after. That gate is correct — a jsonc file is an
 * import wire and never a runtime source, so re-applying it would overwrite whatever the user changed
 * in the UI since. What was wrong is that it happened in COMPLETE silence: two of the six seeds read
 * the file, decode it successfully and drop it, and the other four return before looking. A user
 * editing that file on a live instance got no signal at all, which is principle 12's c64 line — a
 * value that decides the outcome with nothing on screen.
 *
 * The pair below is the whole claim, and it needs both halves: the event must fire on a SECOND pass
 * and must NOT fire on the first, or "reports correctly" and "reports always" look identical.
 */
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      CatalogStore.node,
      AgentConfigStore.node,
      CommandConfigStore.node,
      SkillConfigStore.node,
      ReferenceConfigStore.node,
      SettingsConfigStore.node,
      FSUtil.node,
    ]),
  ),
)

/** Info-level records only — the event is deliberately `info`, because an ignored file is not a fault. */
const collectInfo = () => {
  const records: unknown[][] = []
  const collector = Logger.make((options: Logger.Options<unknown>) => {
    if (options.logLevel !== "Info") return
    records.push(Array.isArray(options.message) ? [...options.message] : [options.message])
  })
  return { records, layer: Logger.layer([collector]) }
}

const linesOf = (records: unknown[][]) => records.map((record) => JSON.stringify(record))

/** A config dir holding one authored document that touches several subsystems. */
const configDirWith = (root: string) =>
  Effect.promise(async () => {
    const configDir = path.join(root, "config")
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(
      path.join(configDir, "novaclaw.jsonc"),
      JSON.stringify({
        username: "authored",
        agent: { scribe: { description: "authored agent", mode: "subagent" } },
      }),
    )
    return configDir
  })

describe("a config file that did not apply says so", () => {
  it.effect("🔴 a SECOND seed pass over a populated instance reports the file it ignored", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const configDir = yield* configDirWith(dir.path)

      // First pass fills the stores. Whatever it logs is not what this test is about.
      yield* ConfigSeedStartup.seedAll(configDir, dir.path)

      // Second pass: the file is still there, the stores are no longer empty, nothing can apply.
      const info = collectInfo()
      yield* ConfigSeedStartup.seedAll(configDir, dir.path).pipe(Effect.provide(info.layer))

      const lines = linesOf(info.records).filter((line) => line.includes("config.seed.ignored"))
      expect(lines.length, `no ignored-source report among:\n${linesOf(info.records).join("\n")}`).toBeGreaterThan(0)
      // It must name the file, so the user can tell WHICH document was disregarded...
      expect(lines.join("\n")).toContain("novaclaw.jsonc")
      // ...and which stores refused it, so "ignored" is not an unfalsifiable claim about everything.
      expect(lines.join("\n")).toContain("settings")
    }),
  )

  it.effect("NEGATIVE CONTROL: the FIRST pass applies the file, so it reports nothing", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const configDir = yield* configDirWith(dir.path)

      const info = collectInfo()
      yield* ConfigSeedStartup.seedAll(configDir, dir.path).pipe(Effect.provide(info.layer))

      // Without this the test above would pass on an implementation that fires unconditionally —
      // i.e. on every boot of every instance forever, which is noise wearing a report's clothes.
      expect(linesOf(info.records).filter((line) => line.includes("config.seed.ignored"))).toEqual([])
      // Non-vacuity: the seed really did run and really did apply the document.
      const settings = yield* (yield* SettingsConfigStore.Service).all()
      expect(settings.username).toBe("authored")
    }),
  )

  it.effect("NEGATIVE CONTROL: a populated instance with NO config file reports nothing", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const configDir = yield* configDirWith(dir.path)
      yield* ConfigSeedStartup.seedAll(configDir, dir.path)

      // Delete the document, then seed again over the now-populated stores.
      yield* Effect.promise(() => fs.rm(path.join(configDir, "novaclaw.jsonc")))
      const info = collectInfo()
      yield* ConfigSeedStartup.seedAll(configDir, dir.path).pipe(Effect.provide(info.layer))

      // Nothing authored means nothing was discarded — the event is about a file being disregarded,
      // never about a store merely being non-empty.
      expect(linesOf(info.records).filter((line) => line.includes("config.seed.ignored"))).toEqual([])
    }),
  )
})
