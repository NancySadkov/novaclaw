import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Config } from "@novaclaw/core/config"
import { ConfigSkillPlugin } from "@novaclaw/core/config/plugin/skill"
import { Global } from "@novaclaw/core/global"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SkillV2 } from "@novaclaw/core/skill"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(Layer.empty)
const decode = Schema.decodeUnknownSync(Config.Info)

// Config→SQLite step 4: the plugin reads config-borne skill sources from the instance-wide store
// (its transitional seed imports the stubbed Config documents on first run).
const memoryStore = () => {
  const sources: string[] = []
  return SkillConfigStore.Service.of({
    sources: () => Effect.sync(() => [...sources]),
    addSource: (source) =>
      Effect.sync(() => {
        if (!sources.includes(source)) sources.push(source)
      }),
    removeSource: (source) =>
      Effect.sync(() => {
        const index = sources.indexOf(source)
        if (index !== -1) sources.splice(index, 1)
      }),
    isEmpty: () => Effect.sync(() => sources.length === 0),
  })
}

describe("ConfigSkillPlugin.Plugin", () => {
  it.effect("registers configured skill directories and URLs", () =>
    Effect.gen(function* () {
      const directory = AbsolutePath.make("/repo/packages/app")
      const sources: SkillV2.Source[] = []
      const transform = Effect.fnUntraced(function* (update: (draft: SkillV2.Draft) => void | Effect.Effect<void>) {
        const result = update({
          source: (source) => {
            sources.push(source)
          },
          list: () => sources,
        })
        if (Effect.isEffect(result)) yield* result
        const dispose = Effect.sync(() => {
          sources.length = 0
        })
        yield* Effect.addFinalizer(() => dispose)
        return { dispose }
      })

      // 8c: the store is PRE-populated (import seeds fill it at boot; the plugin never reads
      // config documents). Relative/~ entries stay tolerated at apply time.
      const store = memoryStore()
      for (const item of ["./skills", "~/shared-skills", "/opt/skills", "https://example.test/skills/"]) {
        yield* store.addSource(item)
      }

      yield* ConfigSkillPlugin.Plugin.effect(
        host({
          skill: { transform, reload: () => Effect.void },
        }),
      ).pipe(
        Effect.provideService(SkillConfigStore.Service, store),
        Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: "/home/test" })),
        Effect.provideService(Location.Service, Location.Service.of(location({ directory }))),
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([new Config.Directory({ type: "directory", path: AbsolutePath.make("/repo/.novaclaw") })]),
          }),
        ),
      )

      expect(sources).toEqual([
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.novaclaw", "skill")),
        }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.novaclaw", "skills")),
        }),
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/home/test", "shared-skills")),
        }),
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make("/opt/skills") }),
        SkillV2.UrlSource.make({ type: "url", url: "https://example.test/skills/" }),
      ])
    }),
  )
})
