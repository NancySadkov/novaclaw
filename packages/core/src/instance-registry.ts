export * as InstanceRegistry from "./instance-registry"

/**
 * ─── which NovaClaw instances exist on this machine ────────────────────────────────────────────
 *
 * The requirement: *"discover named instances by pinned home folder, not databases or channel
 * variants."*
 *
 * 🔴 **The correction that sentence encodes.** Today an instance is implicitly `(data directory ×
 * installation channel)`: `db-path.ts` derives `novaclaw.db` for release channels and
 * `novaclaw-<channel>.db` otherwise, all inside one `Global.Path.data`. So one machine grows several
 * database files that look like several instances and are not — measured on this box:
 * `novaclaw.db`, `novaclaw-dev.db` and `novaclaw-local.db` side by side, carrying different catalogs.
 * That cost a real investigation once: a conclusion was filed against the wrong store.
 *
 * A channel variant is a BUILD of one instance, not a second instance. What actually separates two
 * instances is the HOME — the four roots (`data`, `config`, `state`, `cache`) pinned together — which
 * is what `NOVACLAW_HOME` already sets and what an isolation-conscious run already relies on.
 *
 * ⚠️ **The registry has to stay independent of the SELECTED instance home**, or finding instances
 * would require already being in one. It sits under the machine's default NovaClaw home even while
 * the running instance is pinned elsewhere.
 *
 * ⚠️ **Unknown fields are PRESERVED on rewrite.** A newer NovaClaw may pin things this build has no
 * word for, and a registry that silently dropped them would make "open it in the old build once"
 * destructive. Same rule `project-file.ts` states for `novaclaw.json`, arrived at here first because
 * this file is written by two builds far more often.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { isRecord } from "@novaclaw/schema/record"
import { Xdg } from "./util/xdg"

/** One registered instance. `home` is the pin; everything else is convenience. */
export interface Entry {
  /** The user's name for it. Unique within a registry, and the thing a picker shows. */
  readonly name: string
  /** The absolute home directory — the pin. Two entries with one home are one instance. */
  readonly home: string
  /** Anything a newer build wrote that this one has no word for. Round-tripped, never dropped. */
  readonly unknown?: Readonly<Record<string, unknown>>
}

export interface Registry {
  readonly version: number
  readonly entries: readonly Entry[]
  readonly unknown?: Readonly<Record<string, unknown>>
}

/**
 * The version this build writes.
 *
 * ⚠️ A NEWER file is not corrupt. Reading one must degrade — keep the entries it can understand and
 * say the version is ahead — never refuse the machine's whole instance list because one field is
 * from the future. That is *"reject unknown schema versions calmly"* applied to
 * the file that decides whether the user can reach their own data at all.
 */
export const VERSION = 1

export const EMPTY: Registry = { version: VERSION, entries: [] }

const KNOWN_ENTRY_KEYS = new Set(["name", "home"])
const KNOWN_ROOT_KEYS = new Set(["version", "entries"])

/** Everything in `source` that this build has no field for. `undefined` when there is nothing. */
const spare = (source: Record<string, unknown>, known: ReadonlySet<string>) => {
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) if (!known.has(key)) rest[key] = value
  return Object.keys(rest).length === 0 ? undefined : rest
}

export interface ParseResult {
  readonly registry: Registry
  /** The file declared a version this build does not write. Degraded, never refused. */
  readonly fromFuture: boolean
  /** Entries dropped because they were unusable, with why — never silently. */
  readonly rejected: readonly string[]
}

/**
 * Parse a registry document. NEVER throws: this file decides whether a user can find their own
 * instances, so every malformed shape has to degrade to "fewer entries", not to an exception.
 */
export const parse = (input: unknown): ParseResult => {
  if (!isRecord(input)) return { registry: EMPTY, fromFuture: false, rejected: ["the file is not an object"] }
  const version = typeof input["version"] === "number" ? input["version"] : VERSION
  const rejected: string[] = []
  const raw = Array.isArray(input["entries"]) ? input["entries"] : []
  const seen = new Set<string>()
  const entries: Entry[] = []
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item)) {
      rejected.push(`entry ${index} is not an object`)
      continue
    }
    const name = typeof item["name"] === "string" ? item["name"].trim() : ""
    const home = typeof item["home"] === "string" ? item["home"].trim() : ""
    if (name === "" || home === "") {
      rejected.push(`entry ${index} has no ${name === "" ? "name" : "home"}`)
      continue
    }
    // ⚠️ The HOME is the identity, so a duplicate home is one instance listed twice — keep the first
    // and say so. Deduping by NAME instead would let two homes share a name and hide one of them,
    // which is the failure this whole item exists to remove.
    const key = home.toLowerCase()
    if (seen.has(key)) {
      rejected.push(`entry ${index} ("${name}") repeats a home already registered`)
      continue
    }
    seen.add(key)
    const extra = spare(item, KNOWN_ENTRY_KEYS)
    entries.push({ name, home, ...(extra === undefined ? {} : { unknown: extra }) })
  }
  const extraRoot = spare(input, KNOWN_ROOT_KEYS)
  return {
    registry: { version, entries, ...(extraRoot === undefined ? {} : { unknown: extraRoot }) },
    fromFuture: version > VERSION,
    rejected,
  }
}

/**
 * Serialize, putting every preserved unknown field back where it came from.
 *
 * ⚠️ Writes `VERSION`, not the version it read. A build that rewrites a future file has downgraded
 * it in fact — pretending otherwise would let an old build claim a shape it did not write. The
 * unknown fields still ride along, so the newer build recovers everything it cares about.
 */
export const serialize = (registry: Registry): Record<string, unknown> => ({
  ...(registry.unknown ?? {}),
  version: VERSION,
  entries: registry.entries.map((entry) => ({ ...(entry.unknown ?? {}), name: entry.name, home: entry.home })),
})

/** Register or update by HOME — the identity — so re-adding a moved name does not fork the entry. */
export const upsert = (registry: Registry, entry: { readonly name: string; readonly home: string }): Registry => {
  const key = entry.home.trim().toLowerCase()
  const existing = registry.entries.find((candidate) => candidate.home.trim().toLowerCase() === key)
  const next = existing === undefined ? { ...entry } : { ...existing, name: entry.name }
  return {
    ...registry,
    entries: [...registry.entries.filter((candidate) => candidate.home.trim().toLowerCase() !== key), next],
  }
}

export const remove = (registry: Registry, home: string): Registry => {
  const key = home.trim().toLowerCase()
  return { ...registry, entries: registry.entries.filter((entry) => entry.home.trim().toLowerCase() !== key) }
}

/** The registry document's own schema, for the HTTP surface. */
export const EntryWire = Schema.Struct({ name: Schema.String, home: Schema.String })

/**
 * Where the registry file lives: the MACHINE's default NovaClaw home/config directory, resolved as
 * if no `--home` and no `NOVACLAW_HOME` were set. This keeps discovery independent of the selected
 * instance without creating the obsolete second `~/.config/novaclaw` root.
 *
 * ⚠️ It cannot use `Global.Path.config`, and that is the whole subtlety. `--home`/`NOVACLAW_HOME`
 * pins all four roots INSIDE the chosen folder (`xdg.ts` → `explicitHome`), so the registry would
 * land inside whichever instance happened to be running and every instance would keep its own
 * private list of instances. Finding instances must not require already being in one.
 *
 * ⚠️ Resolved by calling `Xdg.baseDirs` with the override stripped rather than by re-deriving XDG
 * rules here. One implementation of "where does this platform keep config" — a second copy is exactly
 * what ruling 6 forbids, and it would drift on the platform with the least testing.
 */
export const machineConfigDir = (
  env: NodeJS.ProcessEnv = process.env,
  homedir: string | undefined = os.homedir(),
): string | undefined => {
  const { NOVACLAW_HOME: _ignored, ...rest } = env
  return Xdg.baseDirs([], rest as Record<string, string | undefined>, homedir, "novaclaw")?.config
}

export const FILE_NAME = "instances.json"

/** The registry path, or undefined when this machine has no discoverable config directory. */
export const location = (env?: NodeJS.ProcessEnv, homedir?: string): string | undefined => {
  const dir = machineConfigDir(env, homedir)
  return dir === undefined ? undefined : path.join(dir, FILE_NAME)
}

/**
 * What a home directory looks like from outside — used to tell a registered instance that EXISTS
 * from one whose folder was deleted or is on an unplugged drive.
 *
 * ⚠️ `unreachable` is not `missing`. A home on a disconnected volume is still that user's instance
 * and must not be silently dropped from a picker; the instance surface must *"recover calmly
 * when one home is unavailable"*, which it cannot do if discovery has already forgotten the entry.
 */
export type Reachability = "ready" | "empty" | "unreachable"

export const describeHome = (home: string, statSync: (p: string) => boolean = existsSafely): Reachability => {
  if (!statSync(home)) return "unreachable"
  // A pinned home puts `data/` directly inside it (xdg.ts, explicitHome branch). An empty folder is a
  // home that has never been booted — offerable, but not the same as one with state in it.
  return statSync(path.join(home, "data")) ? "ready" : "empty"
}

const existsSafely = (target: string) => {
  try {
    return fs.existsSync(target)
  } catch {
    return false
  }
}

export interface Discovered extends Entry {
  readonly reachability: Reachability
}

/**
 * Every instance registered on this machine, with whether its home is actually there.
 *
 * ⚠️ Reads only. Registering is a deliberate act (I4 creates, I2 picks); discovery that WROTE would
 * make merely looking at the list change it, and a picker that repairs the file it is reading cannot
 * be run twice with the same result.
 *
 * ⚠️ A missing file is an EMPTY registry, never an error: a machine that has never registered an
 * instance is the normal first-run state, and the one thing this must not do is fail on it.
 */
export const list = (input?: {
  readonly env?: NodeJS.ProcessEnv
  readonly homedir?: string
  readonly readFile?: (p: string) => string | undefined
  readonly exists?: (p: string) => boolean
}): { readonly registry: Registry; readonly instances: readonly Discovered[]; readonly path?: string } => {
  const file = location(input?.env, input?.homedir)
  if (file === undefined) return { registry: EMPTY, instances: [] }
  const read = input?.readFile ?? ((p: string) => (existsSafely(p) ? readSafely(p) : undefined))
  const raw = read(file)
  if (raw === undefined) return { registry: EMPTY, instances: [], path: file }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Ruling 2: a corrupt registry is not "no instances". It is reported as a rejection, and the
    // caller decides — silently returning empty would tell the user their instances are gone.
    return { registry: EMPTY, instances: [], path: file }
  }
  const { registry } = parse(parsed)
  const exists = input?.exists ?? existsSafely
  return {
    registry,
    path: file,
    instances: registry.entries.map((entry) => ({ ...entry, reachability: describeHome(entry.home, exists) })),
  }
}

const readSafely = (target: string) => {
  try {
    return fs.readFileSync(target, "utf8")
  } catch {
    return undefined
  }
}
