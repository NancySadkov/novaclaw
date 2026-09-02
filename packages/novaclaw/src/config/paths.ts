export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@novaclaw/core/flag/flag"
import { Global } from "@novaclaw/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@novaclaw/core/fs-util"

// `worktree` is REQUIRED, and that is the point: an omitted boundary is an unbounded walk, and this
// one both reads a directory's commands into the session and (through `Config.ensureGitignore`)
// used to write into every `.novaclaw` it passed. Outside a repository the caller's worktree is the
// `"/"` sentinel, which names no ancestor at all — `FSUtil.up` is what turns that into the home
// floor rather than the whole drive; see `FSUtil.walkBoundary`.
export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree: string) {
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
