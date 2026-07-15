export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@novaclaw/core/flag/flag"
import { Global } from "@novaclaw/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@novaclaw/core/fs-util"

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  return unique([
    Global.Path.config,
    ...(!Flag.NOVACLAW_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".novaclaw"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [".novaclaw"],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.NOVACLAW_CONFIG_DIR ? [Flag.NOVACLAW_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
