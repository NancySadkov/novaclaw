import { createHash } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"

/**
 * IMMUTABLE SNAPSHOT GENERATIONS FOR THE GRAPH STORE — NC-REL-018.
 *
 * 🔴 The graph used to publish by writing each MEMFS file straight over its live path and then
 * deleting whatever was left over. One generation, no commit marker, no validation. A crash inside
 * that window — a one-second debounce that runs after every write — left the directory holding a
 * truncated or mixed file set, and the next open copied exactly those bytes back in. Ladybug rejected
 * them, the lazy wrapper recorded an error and cleared only its in-process promise, so every retry
 * reopened the same damage. Recovery meant knowing which internal directory to delete by hand.
 *
 * The layout that replaces it:
 *
 *     <root>/CURRENT           a pointer file naming the live generation
 *     <root>/g-000007/         that generation: the db files plus a MANIFEST written LAST
 *     <root>/g-000006/         the retained known-good predecessor
 *     <root>/quarantine-g-…/   a generation that would not verify or would not open, kept for diagnosis
 *
 * ⚠️ **This module deliberately knows nothing about Ladybug.** The failure it exists to prevent lives
 * entirely in the publish and restore STEPS, so keeping it a pure file-set store is what makes crash
 * injection between those steps a plain test rather than an engine fixture.
 */
export namespace GraphSnapshot {
  /** How many generations survive a prune: the live one and one known-good predecessor. */
  export const KEEP = 2
  /** How many quarantined generations are retained — the newest damage, so this stays bounded. */
  const KEEP_QUARANTINE = 1
  const CURRENT = "CURRENT"
  /**
   * The newest generation that was READ BACK successfully after being written — not merely the newest
   * one published. `CURRENT` says what to try first; this says what is known to work, and `prune`
   * refuses to delete it. They are usually the same name and diverge exactly when it matters.
   */
  const LASTGOOD = "LASTGOOD"
  const MANIFEST = "MANIFEST"
  const GEN_PREFIX = "g-"
  const STAGE_PREFIX = ".staging-"
  const QUARANTINE_PREFIX = "quarantine-"
  const PAD = 6

  export interface Entry {
    readonly name: string
    readonly size: number
    readonly sha256: string
  }
  export interface Manifest {
    readonly files: readonly Entry[]
    readonly created: number
  }
  export interface Generation {
    readonly name: string
    readonly dir: string
    /** `-1` for the pre-generation flat layout, which has no index and no manifest. */
    readonly index: number
    readonly legacy: boolean
  }

  const genIndex = (name: string): number =>
    name.startsWith(GEN_PREFIX) && /^\d+$/.test(name.slice(GEN_PREFIX.length))
      ? Number(name.slice(GEN_PREFIX.length))
      : -1

  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * Write a file and force it to the platter before anything is allowed to depend on it.
   *
   * ⚠️ `writeFileSync` alone returns once the bytes reach the page cache, so a power loss can lose a
   * file the pointer has already committed to. Per-file fsync is what makes the publish ordering below
   * mean anything. Directory metadata is best-effort: Windows offers no directory handle to sync, so
   * on that platform the ordering guarantee covers a process crash, not a power cut.
   */
  const writeDurable = (file: string, bytes: Uint8Array): void => {
    const fd = openSync(file, "w")
    try {
      writeSync(fd, bytes, 0, bytes.byteLength, 0)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  const syncDir = (dir: string): void => {
    if (process.platform === "win32") return
    try {
      const fd = openSync(dir, "r")
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch {
      /* best effort — costs ordering on power loss, never correctness on a process crash */
    }
  }

  const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

  /**
   * Publish `files` as a new generation, then move the pointer.
   *
   * The ORDER is the whole design: stage every file and fsync each, write the MANIFEST last (so a
   * manifest's presence means the set is complete), rename the staging directory into its final name,
   * and only then swap `CURRENT`. Every prefix of that sequence leaves the previous generation live and
   * complete — an interrupted publish costs the newest writes, never the store.
   *
   * Returns the generation name.
   */
  export function publish(root: string, files: ReadonlyMap<string, Uint8Array>): string {
    mkdirSync(root, { recursive: true })
    const next = Math.max(-1, ...readdirSync(root).map(genIndex)) + 1
    const name = GEN_PREFIX + String(next).padStart(PAD, "0")
    const staging = join(root, `${STAGE_PREFIX}${process.pid}-${next}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })

    const entries: Entry[] = []
    for (const [file, bytes] of files) {
      writeDurable(join(staging, file), bytes)
      entries.push({ name: file, size: bytes.byteLength, sha256: sha(bytes) })
    }
    const manifest: Manifest = { files: entries, created: Date.now() }
    writeDurable(join(staging, MANIFEST), Buffer.from(JSON.stringify(manifest)))
    syncDir(staging)

    const dir = join(root, name)
    rmSync(dir, { recursive: true, force: true })
    renameSync(staging, dir)
    syncDir(root)

    // The commit. `rename` over an existing file replaces it in one step on every platform we ship on,
    // so `CURRENT` is never observed half-written: it names the old generation or the new one.
    const pointer = join(root, CURRENT)
    const tmp = `${pointer}.tmp`
    writeDurable(tmp, Buffer.from(name))
    renameSync(tmp, pointer)
    syncDir(root)

    /**
     * 🔴 **VERIFY WHAT WE JUST WROTE, BEFORE ANYTHING OLDER IS ELIGIBLE FOR DELETION.**
     *
     * A publish that cannot be read back is not a publish, and until 2026-08-26 nothing checked: two
     * such generations in a row filled the retention window and pruned the user's whole store behind
     * them. Recording the winner here is what gives `prune` something it is allowed to keep.
     *
     * ⚠️ `CURRENT` is still advanced either way. A generation that fails this check is exactly what
     * `candidates()`/`restore` already handle by falling back, and rolling the pointer back would add
     * a second recovery path competing with the one that is tested.
     */
    if (read({ name, dir, index: next, legacy: false }) !== undefined) {
      const good = join(root, LASTGOOD)
      const goodTmp = `${good}.tmp`
      writeDurable(goodTmp, Buffer.from(name))
      renameSync(goodTmp, good)
      syncDir(root)
    } else {
      console.warn(`kb-memory: ${name} did not read back after publish — pinning the last verified generation instead`)
    }

    prune(root)
    return name
  }

  /** The pinned generation, if one has ever verified and still exists. */
  function lastGood(root: string): string | undefined {
    try {
      const name = readFileSync(join(root, LASTGOOD), "utf8").trim()
      return name && isDir(join(root, name)) ? name : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Generations worth trying, newest-first, with `CURRENT`'s always first.
   *
   * ⚠️ An unreferenced generation NEWER than `CURRENT` is a publish that died before its commit, so it
   * is tried after the pointer's rather than before it — the pointer is the only thing that ever says a
   * generation was finished.
   */
  export function candidates(root: string): Generation[] {
    if (!isDir(root)) return []
    const names = readdirSync(root)
    const gens = names
      .filter((n) => genIndex(n) >= 0 && isDir(join(root, n)))
      .sort((a, b) => genIndex(b) - genIndex(a))
    const pointed = (() => {
      try {
        const target = readFileSync(join(root, CURRENT), "utf8").trim()
        return gens.includes(target) ? target : undefined
      } catch {
        return undefined
      }
    })()
    const ordered = pointed ? [pointed, ...gens.filter((n) => n !== pointed)] : gens
    const out: Generation[] = ordered.map((n) => ({
      name: n,
      dir: join(root, n),
      index: genIndex(n),
      legacy: false,
    }))
    // The pre-generation layout: db files sitting loose in `root`. Offered only when no generation
    // exists, so a store that has published even once never falls back to bytes it already superseded.
    if (
      out.length === 0 &&
      names.some((n) => n !== CURRENT && !n.startsWith(".") && !n.startsWith(QUARANTINE_PREFIX) && !isDir(join(root, n)))
    )
      out.push({ name: "(legacy)", dir: root, index: -1, legacy: true })
    return out
  }

  /**
   * The generation's files, or `undefined` when it does not verify.
   *
   * A missing or unparseable manifest means the publish never finished; a size or digest mismatch means
   * the bytes moved underneath it. Either way the caller must fall back rather than hand these to an
   * engine.
   */
  export function read(gen: Generation): Map<string, Buffer> | undefined {
    if (gen.legacy) {
      // No manifest existed before this design, so the legacy set can only be read, never verified. It
      // is accepted because it is exactly what the old code would have opened, and refusing it would
      // discard a real store on upgrade.
      const files = new Map<string, Buffer>()
      try {
        for (const name of readdirSync(gen.dir)) {
          const p = join(gen.dir, name)
          if (name === CURRENT || name === MANIFEST || isDir(p)) continue
          files.set(name, readFileSync(p))
        }
      } catch {
        return undefined
      }
      return files.size > 0 ? files : undefined
    }
    let manifest: Manifest
    try {
      manifest = JSON.parse(readFileSync(join(gen.dir, MANIFEST), "utf8")) as Manifest
      if (!Array.isArray(manifest.files)) return undefined
    } catch {
      return undefined
    }
    const files = new Map<string, Buffer>()
    for (const entry of manifest.files) {
      let bytes: Buffer
      try {
        bytes = readFileSync(join(gen.dir, entry.name))
      } catch {
        return undefined
      }
      if (bytes.byteLength !== entry.size || sha(bytes) !== entry.sha256) return undefined
      files.set(entry.name, bytes)
    }
    return files
  }

  /**
   * Move a generation aside, keeping its bytes. Returns the new name, or `undefined` if it could not be
   * moved (the legacy set has nowhere to go — it IS the root).
   */
  export function quarantine(root: string, gen: Generation): string | undefined {
    if (gen.legacy) return undefined
    const name = `${QUARANTINE_PREFIX}${gen.name}`
    const dest = join(root, name)
    try {
      rmSync(dest, { recursive: true, force: true })
      renameSync(gen.dir, dest)
    } catch {
      return undefined
    }
    // If the pointer named it, retract the pointer too — otherwise the next open resolves to a
    // directory that is no longer there and falls back for the wrong reason.
    try {
      if (readFileSync(join(root, CURRENT), "utf8").trim() === gen.name) rmSync(join(root, CURRENT), { force: true })
    } catch {
      /* no pointer to retract */
    }
    const olds = readdirSync(root)
      .filter((n) => n.startsWith(QUARANTINE_PREFIX))
      .sort()
    for (const old of olds.slice(0, Math.max(0, olds.length - KEEP_QUARANTINE)))
      rmSync(join(root, old), { recursive: true, force: true })
    return name
  }

  /**
   * Drop what the store no longer needs: generations older than the retained depth, abandoned staging
   * directories, and the loose legacy files a generation has now superseded.
   *
   * ⚠️ Runs only AFTER a successful publish. Pruning on open would delete the fallback at exactly the
   * moment the fallback is most likely to be needed.
   */
  export function prune(root: string, keep: number = KEEP): void {
    if (!isDir(root)) return
    const gens = readdirSync(root)
      .filter((n) => genIndex(n) >= 0 && isDir(join(root, n)))
      .sort((a, b) => genIndex(b) - genIndex(a))

    /**
     * 🔴 **THE LAST VERIFIED GENERATION IS PINNED AND NEVER PRUNED.**
     *
     * Retention counted by INDEX alone, so two unreadable generations filled both `KEEP = 2` slots
     * and the only good store the user had was deleted behind them. Measured 2026-08-26 on two
     * separate stores after a WASM abort during checkpoint:
     * `fell back to an EMPTY store; unusable: g-000111, g-000110 (both checksum failed)` →
     * `stats.total = 0`. **1516 nodes and 200 absorbed passages gone**, quarantine copies only. On a
     * real instance that is the user's entire memory, and nothing warned them.
     *
     * ⚠️ **"Spare the newest generation that still reads" does NOT fix this, which is why it is not
     * what this does.** Prune runs on every publish, so the steady state IS `keep` generations — by
     * the time both are known bad there is nothing older left to spare. The protection has to be
     * established while a generation is still known GOOD, so `publish` verifies its own output and
     * records the winner in `LASTGOOD`; this only refuses to delete it.
     */
    const pinned = lastGood(root)
    for (const old of gens.slice(keep))
      if (old !== pinned) rmSync(join(root, old), { recursive: true, force: true })
    for (const name of readdirSync(root)) {
      const p = join(root, name)
      if (name.startsWith(STAGE_PREFIX)) rmSync(p, { recursive: true, force: true })
      else if (
        name !== CURRENT &&
        name !== LASTGOOD && // the pin is a POINTER, not a superseded legacy file — sweeping it would un-pin the store
        !name.startsWith(QUARANTINE_PREFIX) &&
        genIndex(name) < 0 &&
        !isDir(p)
      )
        rmSync(p, { force: true })
    }
  }

  /**
   * Has a real GENERATION been published here?
   *
   * ⚠️ Deliberately false for the pre-generation flat layout, even though `candidates()` offers it.
   * The engine uses this to decide whether a non-dirty store still owes a publish, and answering
   * "yes, there is a snapshot" for loose legacy files meant an upgraded store stayed flat FOREVER —
   * restored on every boot, never protected by a manifest, never gaining a predecessor to fall back
   * to. Caught by `snapshot-recovery.test.ts`; the flat file was still there after an open.
   */
  export function exists(root: string): boolean {
    return candidates(root).some((gen) => !gen.legacy)
  }

  /** The generation the pointer names, when it is actually present. */
  export function current(root: string): string | undefined {
    try {
      const target = readFileSync(join(root, CURRENT), "utf8").trim()
      return existsSync(join(root, target)) ? target : undefined
    } catch {
      return undefined
    }
  }
}
