export * as ConfigReferencePlugin from "./reference"

import { define } from "../../plugin/internal"
import path from "path"
import { Effect } from "effect"
import { Config } from "../../config"
import { ConfigReference } from "../reference"
import { Reference } from "../../reference"
import { ReferenceConfigSeed } from "../../reference-config-seed"
import { ReferenceConfigStore } from "../../reference-config-store"
import { AbsolutePath } from "../../schema"
import { Global } from "../../global"
import { Location } from "../../location"

// Config→SQLite step 4: config-borne reference aliases come from the instance-wide
// `ReferenceConfigStore` (ordered layers per alias, last wins), not from `config.entries()`.
export const Plugin = define({
  id: "core/config-reference",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const store = yield* ReferenceConfigStore.Service
    const location = yield* Location.Service
    const global = yield* Global.Service
    yield* ctx.reference.transform(
      Effect.fn(function* (draft) {
        const entries = new Map<string, Reference.Source>()
        const stored = yield* store.references()
        for (const [name, layers] of Object.entries(stored)) {
          if (!ConfigReference.validAlias(name)) continue
          for (const entry of layers) {
            const description = typeof entry === "string" ? undefined : entry.description
            const hidden = typeof entry === "string" ? undefined : entry.hidden
            entries.set(
              name,
              local(entry)
                ? Reference.LocalSource.make({
                    type: "local",
                    // Stored local entries are absolute (the seed normalizes); the resolution
                    // below keeps tolerating a hand-written relative/`~` row.
                    path: AbsolutePath.make(
                      localPath(location.directory, global.home, typeof entry === "string" ? entry : entry.path),
                    ),
                    ...(description === undefined ? {} : { description }),
                    ...(hidden === undefined ? {} : { hidden }),
                  })
                : Reference.GitSource.make({
                    type: "git",
                    repository: typeof entry === "string" ? entry : entry.repository,
                    ...(entry.branch === undefined ? {} : { branch: entry.branch }),
                    ...(description === undefined ? {} : { description }),
                    ...(hidden === undefined ? {} : { hidden }),
                  }),
            )
          }
        }
        for (const [name, source] of entries) draft.add(name, source)
      }),
    )
  }),
})

function local(entry: ConfigReference.Entry): entry is string | ConfigReference.Local {
  return typeof entry === "string"
    ? entry.startsWith(".") || entry.startsWith("/") || entry.startsWith("~")
    : "path" in entry
}

function localPath(directory: string, home: string, value: string) {
  if (value.startsWith("~/")) return path.join(home, value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(directory, value)
}
