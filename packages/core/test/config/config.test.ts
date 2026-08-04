import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@novaclaw/core/config"
import { ConfigPermission } from "@novaclaw/core/config/permission"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Global } from "@novaclaw/core/global"
import { Location } from "@novaclaw/core/location"
import { Policy } from "@novaclaw/core/policy"
import { Project } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// Config→SQLite 8c contract: jsonc is NOT a runtime config source. `entries()` returns the
// discovered DIRECTORY entries (global config dir + `.novaclaw` dirs — the D2 filesystem
// resources ride them) plus at most ONE synthetic document carrying the settings store's
// snapshot. File parsing lives exclusively in the import seeds (their own test files).

const it = testEffect(Layer.empty)

const memorySettings = (values: Record<string, unknown>) =>
  Layer.succeed(
    SettingsConfigStore.Service,
    SettingsConfigStore.Service.of({
      all: () => Effect.succeed({ ...values }),
      set: (key, value) =>
        Effect.sync(() => {
          values[key] = value
        }),
      remove: (key) =>
        Effect.sync(() => {
          delete values[key]
        }),
      isEmpty: () => Effect.succeed(Object.keys(values).length === 0),
    }),
  )

function testLayer(
  directory: string,
  globalDirectory = path.join(directory, "global"),
  projectDirectory = directory,
  options: { vcs?: Project.Vcs; settings?: Record<string, unknown> } = {},
) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location(
        { directory: AbsolutePath.make(directory) },
        { projectDirectory: AbsolutePath.make(projectDirectory), vcs: options.vcs },
      ),
    ),
  )
  return AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: globalDirectory })],
    [SettingsConfigStore.node, memorySettings(options.settings ?? {})],
  ])
}

describe("Config", () => {
  it.effect("returns the latest defined scalar from priority-ordered documents", () =>
    Effect.sync(() => {
      const entries = [
        new Config.Document({ type: "document", info: new Config.Info({ model: "openrouter/openai/gpt-5" }) }),
        new Config.Directory({ type: "directory", path: AbsolutePath.make("/skills") }),
        new Config.Document({ type: "document", info: new Config.Info({}) }),
        new Config.Document({ type: "document", info: new Config.Info({ model: "openrouter/openai/gpt-5.5" }) }),
      ]

      expect(Config.latest(entries, "model")).toBe("openrouter/openai/gpt-5.5")
      expect(Config.latest(entries, "default_agent")).toBeUndefined()
    }),
  )

  it.effect("lowers a permission dict + tools map into an ordered ruleset", () =>
    Effect.sync(() => {
      expect(ConfigPermission.ruleset({ bash: "deny", edit: { "*": "allow" } })).toEqual([
        { action: "bash", resource: "*", effect: "deny" },
        { action: "edit", resource: "*", effect: "allow" },
      ])
      // A legacy `tools` allow/deny map expands first; write collapses onto edit.
      expect(ConfigPermission.ruleset(undefined, { write: false })).toEqual([
        { action: "edit", resource: "*", effect: "deny" },
      ])
      expect(ConfigPermission.ruleset(undefined, undefined)).toBeUndefined()
    }),
  )

  it.live("returns only the global directory entry when the store is empty", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const entries = yield* config.entries()

          expect(entries).toEqual([
            new Config.Directory({ type: "directory", path: AbsolutePath.make(path.join(tmp.path, "global")) }),
          ])
        }).pipe(Effect.provide(testLayer(tmp.path))),
      ),
    ),
  )

  it.live("never reads jsonc files at runtime — the settings store is the one document (8c)", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          // DECOY config files everywhere the old walk-up used to look.
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "global"), { recursive: true })
            await Promise.all([
              fs.writeFile(path.join(tmp.path, "config.json"), JSON.stringify({ username: "decoy-a" })),
              fs.writeFile(path.join(tmp.path, "novaclaw.json"), JSON.stringify({ username: "decoy-b" })),
              fs.writeFile(path.join(tmp.path, "novaclaw.jsonc"), JSON.stringify({ username: "decoy-c" })),
              fs.writeFile(path.join(tmp.path, "global", "novaclaw.jsonc"), JSON.stringify({ username: "decoy-d" })),
            ])
          })
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = yield* config.entries()
            const documents = entries.filter((entry): entry is Config.Document => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.path).toBeUndefined()
            expect(Config.latest(entries, "username")).toBe("store-user")
            expect(Config.latest(entries, "shell")).toBe("store-shell")
          }).pipe(
            Effect.provide(
              testLayer(tmp.path, undefined, tmp.path, {
                settings: { username: "store-user", shell: "store-shell" },
              }),
            ),
          )
        }),
      ),
    ),
  )

  it.live("loads policy statements from the store-backed synthetic document", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const policy = yield* Policy.Service
          // The import seed stores policies pre-folded in precedence order (reverse-concat);
          // the layer loads them verbatim — the first matching statement wins.
          expect(yield* policy.evaluate("provider.use", "openai", "allow")).toBe("deny")
          expect(yield* policy.evaluate("provider.use", "anthropic", "deny")).toBe("allow")
        }).pipe(
          Effect.provide(
            testLayer(tmp.path, undefined, tmp.path, {
              settings: {
                experimental: {
                  policies: [
                    { effect: "deny", action: "provider.use", resource: "openai" },
                    { effect: "allow", action: "provider.use", resource: "anthropic" },
                  ],
                },
              },
            }),
          ),
        ),
      ),
    ),
  )

  it.live("discovers global and .novaclaw directories up to the project boundary", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const root = path.join(tmp.path, "repo")
        const parent = path.join(root, "packages")
        const directory = path.join(parent, "app")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.mkdir(path.join(root, ".novaclaw"), { recursive: true })
            await fs.mkdir(path.join(directory, ".novaclaw"), { recursive: true })
            // An outside-the-boundary .novaclaw must NOT be discovered.
            await fs.mkdir(path.join(tmp.path, ".novaclaw"), { recursive: true })
          })

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = yield* config.entries()

            expect(entries.filter((entry) => entry.type === "directory").map((entry) => entry.path)).toEqual([
              AbsolutePath.make(global),
              AbsolutePath.make(path.join(root, ".novaclaw")),
              AbsolutePath.make(path.join(directory, ".novaclaw")),
            ])
            expect(entries.filter((entry) => entry.type === "document")).toHaveLength(0)
          }).pipe(
            Effect.provide(
              testLayer(directory, global, root, {
                vcs: { type: "git", store: AbsolutePath.make(path.join(root, ".git")) },
              }),
            ),
          )
        })
      }),
    ),
  )
})
