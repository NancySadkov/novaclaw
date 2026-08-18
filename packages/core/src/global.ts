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
/**
 * The OS temp root, refused if it is not a usable absolute path.
 *
 * ⚠️ **`tmp` was the ONE of the seven instance directories that never went through `Xdg.isSuspect`,
 * and the hole was still open on 2026-08-18** — three weeks after the data-directory half of this
 * exact bug was fixed. `os.tmpdir()` returns `TMPDIR`/`TMP`/`TEMP` **verbatim**, so the same
 * `Object.assign(process.env, {K: undefined})` footgun that made the data directory
 * `undefined\novaclaw` makes the temp root `"undefined"` too. Measured with `TEMP="undefined"`:
 * `Global.Path.tmp` resolved to the RELATIVE `"undefined\novaclaw"`, `ensureDirectories` created it
 * under the process's current working directory, and `directoryStatus()` still reported `ok` — no
 * warning anywhere. A relative temp root writes into whatever folder the process happens to be in,
 * which on this product is the user's own project: principle 11's exact prohibition.
 *
 * So it gets the same treatment as the XDG homes — refuse a suspect value, name it on stderr, and
 * fall back to the platform's documented default rather than stringifying anything.
 */
let cachedTmpRoot: string | undefined
const tmpRoot = (): string => {
  if (cachedTmpRoot !== undefined) return cachedTmpRoot
  const candidate = os.tmpdir()
  if (typeof candidate === "string" && !Xdg.isSuspect(candidate)) return (cachedTmpRoot = candidate)
  const systemRoot = [process.env["SystemRoot"], process.env["windir"], "C:\\Windows"].find(
    (v): v is string => typeof v === "string" && v.trim() !== "" && !Xdg.isSuspect(v),
  )
  const fallback = process.platform === "win32" ? path.join(systemRoot ?? "C:\\Windows", "Temp") : "/tmp"
  console.error(
    `[novaclaw] WARNING: the system temp directory resolved to ${JSON.stringify(candidate)}, which is ` +
      `not a usable absolute path — TMPDIR/TMP/TEMP is empty, relative, or holds the literal text ` +
      `"undefined". NovaClaw is using ${fallback} for this run instead of creating a directory under ` +
      `the current working folder.`,
  )
  return (cachedTmpRoot = fallback)
}

/** `<tmp>/novaclaw` — design principle 11's location (b). */
const instanceTmp = () => path.join(tmpRoot(), app)

/** Last resort when the platform exposes no home at all: somewhere that always exists. A running
 *  instance with a warning beats a dead one — "degrade and recover", never a dead end. */
const emergencyRoot = () => path.join(tmpRoot(), `${app}-home`)

let cached: Xdg.Dirs | undefined

/**
 * **What happened when the instance tried to create its directories.**
 *
 * A VALUE rather than a throw, because this function runs at the very first step of the boot, inside
 * `Effect.sync` on the most dependency-central node in the graph — so an exception here is a defect
 * that no caller can catch and the self-healing law ("as long as one working model remains, the
 * system must be restorable by asking an agent") is void for the whole process. See
 * `notes/reports/startup-classification-2026-08-07.md` §4.1, `Global`.
 *
 * ⚠️ This does NOT make the directories usable. It makes the FAILURE reportable: the instance comes
 * up, the state is named, and whatever later tries to write into a missing directory fails as an
 * ordinary error at its own call site instead of as a dead process.
 */
export type DirectoryStatus =
  /** All seven directories exist. */
  | { readonly state: "ok" }
  /** The chosen home could not be created, so the instance is running out of the emergency root. */
  | { readonly state: "relocated"; readonly root: string; readonly failures: readonly DirectoryFault[] }
  /** Neither the chosen home NOR the emergency root could be created. Named, not fatal. */
  | { readonly state: "degraded"; readonly failures: readonly DirectoryFault[] }

export interface DirectoryFault {
  readonly directory: string
  readonly message: string
}

let status: DirectoryStatus = { state: "ok" }

/**
 * The seven instance directories, derived from an XDG layout. Pure — it names paths and touches no
 * disk, so the guard below can be exercised against a root that is guaranteed to fail.
 */
export const directoriesOf = (chosen: Xdg.Dirs, tmpDir: string): readonly string[] => [
  chosen.data,
  chosen.config,
  chosen.state,
  tmpDir,
  path.join(chosen.data, "log"),
  path.join(chosen.cache, "bin"),
  path.join(chosen.data, "repos"),
]

/**
 * A path segment that is a stringified nullish value.
 *
 * `String(undefined)` and `String(null)` are ordinary non-empty strings, so `path.join` accepts them
 * and every `??`/`||` downstream skips its fallback. That is how `C:\Users\<u>\undefined\novaclaw`
 * came to hold six days of real databases. No real directory is named exactly `undefined` or `null`;
 * a path carrying one is a bug that has reached the filesystem.
 */
const NULLISH_SEGMENT = /(?:^|[\\/])(?:undefined|null)(?:[\\/]|$)/

/**
 * `mkdirSync` every directory, and report the ones that refused instead of throwing on the first.
 *
 * Every directory is attempted even after one fails: a single unwritable path (a stale file where a
 * directory belongs, a revoked ACL on `state`) should not hide the state of the other six from
 * whoever has to repair this.
 *
 * ⚠️ **This is the LAST place a path becomes bytes on someone else's disk, so it is where a
 * stringified `undefined` is refused rather than created.** The resolver upstream already rejects a
 * suspect home, but every derived path (`<data>/log`, `<cache>/bin`, the temp root) is built AFTER
 * that check, and the temp root never went through it at all. A guard at the chokepoint is the one
 * that cannot be bypassed by adding a directory to `directoriesOf`. It reports rather than throws,
 * in the same shape as an EACCES, so the caller relocates and says so.
 */
export const ensureDirectories = (directories: readonly string[]): readonly DirectoryFault[] => {
  const failures: DirectoryFault[] = []
  for (const directory of directories) {
    if (typeof directory !== "string" || directory.trim() === "" || NULLISH_SEGMENT.test(directory)) {
      failures.push({
        directory: String(directory),
        message:
          `refusing to create a directory whose path carries a stringified nullish segment — some ` +
          `variable was undefined/null and got interpolated instead of falling back. This is how ` +
          `NovaClaw once wrote six days of databases into a folder literally named "undefined" ` +
          `(AGENTS.md design principle 11).`,
      })
      continue
    }
    try {
      fsSync.mkdirSync(directory, { recursive: true })
    } catch (cause) {
      failures.push({ directory, message: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  return failures
}

/**
 * What the last (and only) directory-creation attempt did. Resolves the directories if nothing has
 * yet — otherwise a caller asking "is this instance healthy?" would get `ok` for a boot that never ran.
 */
export const directoryStatus = (): DirectoryStatus => {
  dirs()
  return status
}

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

  // Synchronous: callers read these paths and immediately write into them, and the old module-level
  // `await` is gone now that resolution is lazy.
  //
  // ⚠️ This used to be a bare `fsSync.mkdirSync(dir, …)` loop, i.e. seven unguarded syscalls inside
  // `Effect.sync` on the boot path: EACCES/EPERM/EROFS/ENOSPC on any one of them was an
  // unrecoverable boot defect. It degrades now instead, in the same shape the home-resolution branch
  // above already used — the emergency root, loudly named.
  const failures = ensureDirectories(directoriesOf(chosen, instanceTmp()))
  // ⚠️ Only an unusable HOME earns a relocation, never one bad subdirectory. Moving the whole
  // instance because `<data>/log` could not be created would orphan the user's existing sessions
  // database in their real home and start them in an empty one — the "quarantine is scarier than a
  // hard fail if done sloppily" case ruling 2 names. A failed subdirectory degrades in place and
  // says which one; the subsystem that needed it (the logger) has its own fallback.
  const unusableHome = failures.some((fault) => [chosen.data, chosen.config, chosen.state].includes(fault.directory))
  const root = emergencyRoot()
  if (unusableHome && chosen.explicitHome !== root) {
    const relocated: Xdg.Dirs = {
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      explicitHome: root,
    }
    const second = ensureDirectories(directoriesOf(relocated, instanceTmp()))
    if (second.length === 0) {
      console.error(
        `[novaclaw] WARNING: NovaClaw could not create its directories under the home it resolved ` +
          `(${failures.map((fault) => `${fault.directory}: ${fault.message}`).join("; ")}), so it is ` +
          `storing its files under ${root} for this run. Pass --home <dir> (or set NOVACLAW_HOME) to ` +
          `choose where they live.`,
      )
      chosen = relocated
      status = { state: "relocated", root, failures }
    } else {
      status = { state: "degraded", failures: [...failures, ...second] }
    }
  } else if (failures.length > 0) {
    status = { state: "degraded", failures }
  }

  if (status.state === "degraded") {
    // Nothing left to fall back to. The instance still comes up — a running process that can be
    // asked to repair itself beats a dead one — and every later write fails as an ordinary error at
    // its own call site, naming its own path.
    console.error(
      `[novaclaw] WARNING: NovaClaw could not create these directories and no fallback worked: ` +
        `${status.failures.map((fault) => `${fault.directory}: ${fault.message}`).join("; ")}. ` +
        `The instance is starting anyway; features that need those directories will fail and say so. ` +
        `Pass --home <dir> (or set NOVACLAW_HOME) to choose where they live.`,
    )
  }

  cached = chosen
  Flock.setGlobal({ state: chosen.state })

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
  get tmp() {
    return instanceTmp()
  },
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
