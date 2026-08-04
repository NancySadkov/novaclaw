export * as Xdg from "./xdg"

import path from "path"

/** Just the environment entries this module consults — so tests can pass a literal. */
export interface Env {
  readonly NOVACLAW_TEST_HOME?: string | undefined
  readonly USERPROFILE?: string | undefined
  readonly HOMEDRIVE?: string | undefined
  readonly HOMEPATH?: string | undefined
  readonly HOME?: string | undefined
  readonly [key: string]: string | undefined
}

/**
 * Picks the first usable value, where "usable" excludes the literal string `"undefined"`.
 *
 * That exclusion is not paranoia — it is the exact bug that shipped. `Object.assign(process.env, {K:
 * undefined})` coerces to the STRING "undefined" (Node stringifies env values), and the desktop's
 * `preferAppEnv` did precisely that for three XDG variables. Because "undefined" is non-empty, every
 * `??`/`||` fallback downstream accepted it and the data directory became "undefined\novaclaw". The
 * writer is fixed, but any future caller can make the same mistake, so refuse the value here too — no
 * real directory is named exactly "undefined", and if one were, an absolute path would be given.
 */
const firstNonEmpty = (...values: Array<string | undefined>) =>
  values.find((v) => v !== undefined && v.trim() !== "" && v.trim() !== "undefined")

/**
 * The user's home directory, from every source the platform might actually carry it in.
 *
 * `os.homedir()` is authoritative WHEN IT ANSWERS. It does not always: in Electron's packaged
 * utilityProcess on Windows it came back empty, which is what made v0.1.0 resolve its data directory
 * to the literal string "undefined" (see `global.ts`). The env fallbacks cover that case — USERPROFILE
 * and HOMEDRIVE+HOMEPATH are the Windows-native pair, HOME is the POSIX one (and is also why the bug
 * never reproduced under Git Bash, which exports it).
 */
export const resolveHome = (env: Env, osHomedir: string | undefined): string | undefined =>
  firstNonEmpty(
    env.NOVACLAW_TEST_HOME,
    osHomedir,
    env.USERPROFILE,
    env.HOMEDRIVE && env.HOMEPATH ? path.join(env.HOMEDRIVE, env.HOMEPATH) : undefined,
    env.HOME,
  )

/**
 * An XDG base directory: the env var when set, else the spec's default under $HOME.
 *
 * Returns `undefined` rather than a half-built path when there is nowhere sane to put files — the
 * caller turns that into an actionable error. The one thing this must never do is hand back a string
 * with "undefined" in it, which is precisely how the original silently corrupted every path.
 */
export const baseDir = (
  env: Env,
  osHomedir: string | undefined,
  envVar: string,
  ...fallback: string[]
): string | undefined => {
  const fromEnv = firstNonEmpty(env[envVar])
  if (fromEnv) return fromEnv
  const home = resolveHome(env, osHomedir)
  return home === undefined ? undefined : path.join(home, ...fallback)
}

/** True when a resolved directory is unusable — relative, empty, or carrying an "undefined" segment. */
export const isSuspect = (value: string): boolean =>
  value.trim() === "" || !path.isAbsolute(value) || value.split(/[\\/]/).includes("undefined")

/**
 * An explicit instance home, from `--home <dir>` / `--home=<dir>` on the command line or
 * `NOVACLAW_HOME` in the environment. This is what lets several instances share one machine: each gets
 * its own self-contained folder holding config, data, state and cache, so a user can copy, move or
 * delete an entire instance as one directory.
 *
 * argv is parsed HERE rather than by the CLI's option parser on purpose. The directories are resolved
 * the first time any consumer touches `Global.Path`, which can happen before argument parsing has
 * run — reading argv directly removes the ordering dependency entirely.
 */
export const homeOverride = (argv: readonly string[], env: Env): string | undefined => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === "--home" || arg === "--home-dir") {
      const next = argv[i + 1]
      // A following flag means `--home` was given with no value; treat it as absent rather than
      // silently adopting "--port" as a directory name.
      if (next !== undefined && !next.startsWith("-") && next.trim() !== "") return next
      continue
    }
    const eq = /^--home(?:-dir)?=(.*)$/.exec(arg)
    if (eq?.[1] !== undefined && eq[1].trim() !== "") return eq[1]
  }
  return firstNonEmpty(env.NOVACLAW_HOME)
}

/**
 * Every base directory for an instance, resolved together.
 *
 * With an explicit home, the four live side by side underneath it — predictable, and the whole instance
 * is one folder. Without one, the XDG layout is reproduced EXACTLY as it was before, so existing
 * installs keep reading and writing the files they already have.
 */
export interface Dirs {
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  /** Set only when the caller pinned an instance home, so callers can report which mode is in use. */
  readonly explicitHome?: string
}

export const baseDirs = (
  argv: readonly string[],
  env: Env,
  osHomedir: string | undefined,
  app: string,
): Dirs | undefined => {
  const explicit = homeOverride(argv, env)
  if (explicit !== undefined) {
    // The pinned folder IS the instance, so no extra app segment inside it.
    const root = path.resolve(explicit)
    return {
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      explicitHome: root,
    }
  }
  const data = baseDir(env, osHomedir, "XDG_DATA_HOME", ".local", "share")
  const cache = baseDir(env, osHomedir, "XDG_CACHE_HOME", ".cache")
  const config = baseDir(env, osHomedir, "XDG_CONFIG_HOME", ".config")
  const state = baseDir(env, osHomedir, "XDG_STATE_HOME", ".local", "state")
  if (data === undefined || cache === undefined || config === undefined || state === undefined) return undefined
  return {
    data: path.join(data, app),
    cache: path.join(cache, app),
    config: path.join(config, app),
    state: path.join(state, app),
  }
}
