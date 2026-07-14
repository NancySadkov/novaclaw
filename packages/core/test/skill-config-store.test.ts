import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { SkillConfigSeed } from "@novaclaw/core/skill-config-seed"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Config→SQLite step 4 gates: source round-trip + the idempotent jsonc seed with
// declaring-file-relative path resolution.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SkillConfigStore.node, FSUtil.node])))

describe("SkillConfigStore", () => {
  it.effect("round-trips sources in insertion order, dedups, removes, and reports emptiness", () =>
    Effect.gen(function* () {
      const store = yield* SkillConfigStore.Service
      expect(yield* store.isEmpty()).toBe(true)

      yield* store.addSource("https://example.test/skills/")
      yield* store.addSource("/opt/skills")
      yield* store.addSource("https://example.test/skills/") // dedup by identity
      expect(yield* store.isEmpty()).toBe(false)
      expect(yield* store.sources()).toEqual(["https://example.test/skills/", "/opt/skills"])

      yield* store.removeSource("/opt/skills")
      expect(yield* store.sources()).toEqual(["https://example.test/skills/"])
    }),
  )

  it.effect("jsonc seed resolves local paths against the declaring file and is idempotent", () =>
    Effect.gen(function* () {
      const store = yield* SkillConfigStore.Service
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const globalDir = path.join(dir.path, "global")
      const projectDir = path.join(dir.path, "project")
      const home = path.join(dir.path, "home")
      yield* Effect.promise(async () => {
        await fs.mkdir(globalDir, { recursive: true })
        await fs.mkdir(projectDir, { recursive: true })
        await fs.writeFile(
          path.join(globalDir, "novaclaw.jsonc"),
          JSON.stringify({ skills: ["./team-skills", "https://example.test/skills/"] }),
        )
        await fs.writeFile(path.join(projectDir, "novaclaw.jsonc"), JSON.stringify({ skills: ["~/my-skills"] }))
      })

      yield* SkillConfigSeed.seedFromDirectory(globalDir, projectDir, home)
      expect(yield* store.sources()).toEqual([
        path.join(globalDir, "team-skills"), // relative → the DECLARING file's dir, not the launch dir
        "https://example.test/skills/",
        path.join(home, "my-skills"),
      ])

      // A user edit after seeding must survive a re-seed (the isEmpty idempotence gate).
      yield* store.removeSource("https://example.test/skills/")
      yield* SkillConfigSeed.seedFromDirectory(globalDir, projectDir, home)
      expect((yield* store.sources()).includes("https://example.test/skills/")).toBe(false)
    }),
  )
})
