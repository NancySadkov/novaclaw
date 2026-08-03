import { createRequire } from "node:module"
import type * as NodePty from "@lydell/node-pty"
import type { Opts, Proc } from "./pty"

export type { Disp, Exit, Opts, Proc } from "./pty"

const require = createRequire(import.meta.url)
let nodePty: typeof NodePty | undefined

// A broken optional native dependency must disable the Terminal, not prevent the entire instance
// from booting. Load PTY only when somebody actually opens a terminal; the desktop package still
// ships the generic loader and the matching platform binary as explicit runtime dependencies.
function load(): typeof NodePty {
  nodePty ??= require("@lydell/node-pty") as typeof NodePty
  return nodePty
}

export function spawn(file: string, args: string[], opts: Opts): Proc {
  const proc = load().spawn(file, args, opts)
  return {
    pid: proc.pid,
    onData(listener) {
      return proc.onData(listener)
    },
    onExit(listener) {
      return proc.onExit(listener)
    },
    write(data) {
      proc.write(data)
    },
    resize(cols, rows) {
      proc.resize(cols, rows)
    },
    kill(signal) {
      proc.kill(signal)
    },
  }
}
