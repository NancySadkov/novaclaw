// 🔴 AGENTS.md principle 11 — NovaClaw creates, modifies or deletes files in exactly three places:
// a home instance dir, the OS temp dir, or the session's working/project folder. Everywhere else it
// may READ and nothing more. Config loading used to break that twice, and both failures were
// invisible on a developer's own machine:
//
//   * it rewrote the file it had just read to inject a `$schema` line — and the only file that path
//     ever reaches is the MACHINE-WIDE managed config an administrator deploys (`/etc/novaclaw`,
//     `%ProgramData%\novaclaw`), whose write was swallowed exactly where permissions forbid it;
//   * for a folder outside any repository the config directory walk ran to the drive root and
//     dropped a `.gitignore` into every `.novaclaw` it passed on the way.
//
// These tests are about the WRITES. The walk's boundary is a separate mechanism with its own suite
// (`packages/core/test/fs-util-walk-boundary.test.ts`), and the two are deliberately independent:
// this file must still pass if a future change widens the set of directories the walk yields.
import { expect, describe } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { FSUtil } from "@novaclaw/core/fs-util"
import { EffectFlock } from "@novaclaw/core/util/effect-flock"
import { CrossSpawnSpawner } from "@novaclaw/core/cross-spawn-spawner"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { tmpdirScoped, provideInstanceEffect, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { NpmTest } from "../fake/npm"

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const layer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provideMerge(infra),
  Layer.provide(NpmTest.noop),
  Layer.provideMerge(FSUtil.defaultLayer),
  Layer.provide(AgentConfigStore.defaultLayer),
  Layer.provide(CatalogStore.defaultLayer),
  Layer.provide(CommandConfigStore.defaultLayer),
  Layer.provide(ReferenceConfigStore.defaultLayer),
  Layer.provide(SettingsConfigStore.defaultLayer),
  Layer.provide(SkillConfigStore.defaultLayer),
)

const it = testEffect(layer)

function withProcessEnv<A, E, R>(key: string, value: string, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[key]
      process.env[key] = value
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }),
  )
}

/** Every directory from `start` up to (and including) the OS temp dir. */
function ancestorsWithinTemp(start: string) {
  const temp = path.resolve(os.tmpdir())
  const result: string[] = []
  let current = path.resolve(start)
  while (FSUtil.contains(temp, current)) {
    result.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return result
}

/**
 * What `Config.ensureGitignore` writes — used here as a FINGERPRINT, not as an expectation.
 *
 * ⚠️ The ancestors above this test's own fixture are shared with every other process on the
 * machine (`%TEMP%` already carries someone else's `.gitignore`, and sibling test processes come
 * and go inside it), so "is this directory unchanged" is not answerable there. "Is this file
 * OURS" is.
 */
const OUR_GITIGNORE = ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n")

const listing = (dir: string) =>
  Effect.promise(() =>
    fs.readdir(dir).then(
      (entries) => entries.sort(),
      () => ["<absent>"],
    ),
  )

describe("config loading writes only where principle 11 allows", () => {
  it.effect("a managed config file is READ and never modified", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const managedDir = path.join(dir, "managed")
      const file = path.join(managedDir, "novaclaw.json")
      // Deliberately WITHOUT a `$schema` key — that absence is what used to trigger the rewrite.
      const bytes = JSON.stringify({ model: "managed/model" })
      yield* FSUtil.use.writeWithDirs(file, bytes)
      const before = yield* Effect.promise(() => fs.stat(file))

      const config = yield* withProcessEnv(
        "NOVACLAW_TEST_MANAGED_CONFIG_DIR",
        managedDir,
        Config.use.get().pipe(provideInstanceEffect(dir)),
      )

      // ⚠️ FIRST, that the read still happened. "The file is unchanged" is also what a config
      // loader that never opened it would report, so this assertion is what stops this test from
      // passing green-because-broken.
      expect(config.model).toBe("managed/model")
      // …and the convenience the write existed for survives, in memory, where every consumer reads it.
      expect(config.$schema).toBe("https://novaclaw.app/config.json")

      expect(yield* FSUtil.use.readFileString(file)).toBe(bytes)
      const after = yield* Effect.promise(() => fs.stat(file))
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(after.size).toBe(before.size)
    }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )

  it.effect("a .novaclaw ABOVE the session folder gets no file of ours", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      // An unrelated project's config directory, one level above the folder the session opens —
      // the `C:\Users\<me>\Documents\.novaclaw` of the report, in a place we are allowed to create.
      const outside = path.join(root, "outside")
      const session = path.join(outside, "project")
      yield* FSUtil.use.ensureDir(path.join(outside, ".novaclaw"))
      yield* FSUtil.use.ensureDir(path.join(session, ".novaclaw"))

      // Listed BEFORE, so the claim is "nothing was created" rather than "nothing I thought to
      // name was created" — a write with a different filename fails this too.
      const owned = [root, outside, path.join(outside, ".novaclaw")]
      const before = yield* Effect.forEach(owned, listing)

      yield* Config.use.get().pipe(provideInstanceEffect(session))

      // The control FIRST: the session's own config directory still gets its `.gitignore`, so a
      // guard that simply refused every write could not satisfy this test.
      expect(yield* FSUtil.use.readFileStringSafe(path.join(session, ".novaclaw", ".gitignore"))).toBe(OUR_GITIGNORE)

      expect(yield* Effect.forEach(owned, listing)).toEqual(before)

      // …and upward, past this test's own fixture, for every ancestor inside the OS temp dir.
      for (const ancestor of ancestorsWithinTemp(outside)) {
        for (const candidate of [path.join(ancestor, ".gitignore"), path.join(ancestor, ".novaclaw", ".gitignore")]) {
          expect(yield* FSUtil.use.readFileStringSafe(candidate), candidate).not.toBe(OUR_GITIGNORE)
        }
      }
    }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )
})
