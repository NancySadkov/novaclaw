export * as SessionWorkerCommand from "./command"

import path from "node:path"
import { fileURLToPath } from "node:url"

export interface Command {
  readonly command: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly workerPath: string
}

/** Resolves the worker beside the already-bundled server. Electron's utility-process host uses the
 * app executable as Node; a standalone Node sidecar uses its ordinary Node executable. */
export function make(input: {
  readonly moduleURL: string
  readonly execPath: string
  readonly electron: boolean
}): Command {
  const serverPath = fileURLToPath(input.moduleURL)
  const basename = path.basename(serverPath)
  const workerPath =
    basename === "novaclaw-server.js"
      ? path.join(path.dirname(serverPath), "novaclaw-session-worker.js")
      : basename === "command.ts"
        ? // Source-mode CLI: command.ts is one directory below the actual Bun entrypoint. Treating
          // it like the bundled Node chunk produced a nonexistent session-worker/session-worker-node.js.
          path.join(path.dirname(serverPath), "..", "session-worker-node.ts")
        : path.join(path.dirname(serverPath), "session-worker-node.js")
  return {
    command: [input.execPath, workerPath],
    ...(input.electron ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}),
    workerPath,
  }
}

export const current = () =>
  make({ moduleURL: import.meta.url, execPath: process.execPath, electron: process.versions.electron !== undefined })
