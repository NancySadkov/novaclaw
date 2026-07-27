import path from "path"
import fsSync from "fs"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
import { Xdg } from "./util/xdg"
import { makeGlobalNode } from "./effect/app-node"

const app = "novaclaw"

// ── base directories ────────────────────────────────────────────────────────────────────────────
//
// This used to be `path.join(xdgData!, app)` over the `xdg-basedir` package. Both halves of that
// were unsafe and it shipped a broken v0.1.0:
//
//   · xdg-basedir snapshots `os.homedir()` ONCE at module load and exports `undefined` for every
//     directory if it comes back empty — and in Electron's packaged utilityProcess it did.
//   · the `!` then asserted that away, so `path.join(undefined, "novaclaw")` produced the literal
//     string "undefined\novaclaw". Every path below inherited it, the scratch directory became
//     "undefined\novaclaw\scratch", and creating a session 500'd on a nonsense location. The failure
//     was invisible in development because Git Bash exports HOME, which makes xdg-basedir resolve.
//
// So: resolve the home directory from every source the platform might actually have it in, keep the
// XDG layout byte-identical so existing installs keep their data, and refuse to build a path at all
// rather than silently writing to a directory literally named "undefined".
const tmp = path.join(os.tmpdir(), app)

/** Last resort when the platform exposes no home at all: somewhere that always exists. A running
 *  instance with a warning beats a dead one — "degrade and recover", never a dead end. */
const emergencyRoot = () => path.join(os.tmpdir(), `${app}-home`)

let cached: Xdg.Dirs | undefined

/**
 * Resolve the instance directories ONCE, on first use.
 *
 * Lazy on purpose. Resolving at module load is what shipped v0.1.0 broken: the import ran in Electron's
 * packaged utilityProcess at a point where no home directory was visible, the values froze as
 * "undefined\novaclaw", and every consumer inherited them. Deferring to first access means the process
 * gets whatever the platform can tell us by the time anything actually needs a path.
 */
const dirs = (): Xdg.Dirs => {
  if (cached) return cached

  const found = Xdg.baseDirs(process.argv, process.env, os.homedir(), app)
  let chosen: Xdg.Dirs
  if (found === undefined || Object.values(found).some((v) => typeof v === "string" && Xdg.isSuspect(v))) {
    const root = emergencyRoot()
    // Loud, on stderr, because this is not a normal state: the instance works but its files are not
    // where the user expects them. `--home <dir>` is the documented way out.
    console.error(
      `[novaclaw] WARNING: could not determine this machine's home directory ` +
        `(os.homedir(), USERPROFILE, HOMEDRIVE+HOMEPATH and HOME are all empty), so NovaClaw is ` +
        `storing its files under ${root} for this run. Pass --home <dir> (or set NOVACLAW_HOME) to ` +
        `choose where they live.`,
    )
    chosen = {
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      explicitHome: root,
    }
  } else {
    chosen = found
  }

  cached = chosen
  Flock.setGlobal({ state: chosen.state })
  // Synchronous: callers read these paths and immediately write into them, and the old module-level
  // `await` is gone now that resolution is lazy.
  for (const dir of [
    chosen.data,
    chosen.config,
    chosen.state,
    tmp,
    path.join(chosen.data, "log"),
    path.join(chosen.cache, "bin"),
    path.join(chosen.data, "repos"),
  ])
    fsSync.mkdirSync(dir, { recursive: true })

  return cached
}

const paths = {
  get home() {
    return process.env.NOVACLAW_TEST_HOME ?? os.homedir()
  },
  get data() {
    return dirs().data
  },
  get bin() {
    return path.join(dirs().cache, "bin")
  },
  get log() {
    return path.join(dirs().data, "log")
  },
  get repos() {
    return path.join(dirs().data, "repos")
  },
  get cache() {
    return dirs().cache
  },
  get config() {
    return dirs().config
  },
  get state() {
    return dirs().state
  },
  tmp,
  /** The pinned instance home, when one was given — for `novaclaw --help` output and diagnostics. */
  get explicitHome() {
    return dirs().explicitHome
  },
}

export const Path = paths

export class Service extends Context.Service<Service, Interface>()("@novaclaw/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Flag.NOVACLAW_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const defaultLayer = layer
export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
