export * as ConfigSkillPlugin from "./skill"

import { define } from "../../plugin/internal"
import path from "path"
import { Effect } from "effect"
import { Config } from "../../config"
import { AbsolutePath } from "../../schema"
import { SkillV2 } from "../../skill"
import { SkillConfigSeed } from "../../skill-config-seed"
import { SkillConfigStore } from "../../skill-config-store"
import { Global } from "../../global"
import { Location } from "../../location"

// Config→SQLite step 4: config-borne skill discovery sources come from the instance-wide
// `SkillConfigStore` (URLs + absolute directory paths), not from `config.entries()`. The
// `skill(s)/` directory walk under config dirs stays filesystem-driven (locked decision D2 —
// user-editable documents, not settings).
export const Plugin = define({
  id: "config-skill",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const store = yield* SkillConfigStore.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    yield* ctx.skill.transform(
      Effect.fn(function* (draft) {
        const entries = yield* config.entries()
        const directories = entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
        for (const directory of directories) {
          draft.source(
            SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skill")) }),
          )
          draft.source(
            SkillV2.DirectorySource.make({
              type: "directory",
              path: AbsolutePath.make(path.join(directory, "skills")),
            }),
          )
        }

        // Transitional jsonc seed (one-time, mirrors config-agent/command): import an existing
        // config's `skills` entries into the store the first time it is empty, resolved against
        // each declaring file's directory. Removed in step 8.
        if (yield* store.isEmpty()) {
          for (const doc of entries.filter((entry): entry is Config.Document => entry.type === "document")) {
            const declaringDir = doc.path ? path.dirname(doc.path) : location.directory
            for (const item of doc.info.skills ?? [])
              yield* store.addSource(SkillConfigSeed.resolveSkillSource(declaringDir, global.home, item))
          }
        }

        // Stored sources are URLs or absolute paths; the expansion below keeps tolerating a
        // hand-written relative/`~` row (resolved like the historical jsonc semantics).
        for (const item of yield* store.sources()) {
          if (URL.canParse(item) && /^(https?:)$/.test(new URL(item).protocol)) {
            draft.source(SkillV2.UrlSource.make({ type: "url", url: item }))
            continue
          }
          const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
          draft.source(
            SkillV2.DirectorySource.make({
              type: "directory",
              path: AbsolutePath.make(path.isAbsolute(expanded) ? expanded : path.join(location.directory, expanded)),
            }),
          )
        }
      }),
    )
  }),
})
