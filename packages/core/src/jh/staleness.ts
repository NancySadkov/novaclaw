export * as JhStaleness from "./staleness"

// jh — derived-artifact staleness (jh-improve1 R1 / defect D1, the dominant reliability sink). A minimal
// build system over facts the harness already owns: which run PRODUCED each derived artifact (its command
// + the source fingerprint it consumed), so a check that would execute a STALE binary after source edits
// can auto-rebuild it (the make discipline) instead of re-running the stale product and reading every
// edit as "the same failure". Pure + deterministic — no fs, no clock; the engine feeds it snapshots of the
// working directory. Engine-run-scoped, in-memory (jh-improve1 L4 — not persisted in State this wave).

import { Hash } from "../util/hash"

export interface FileSnap {
  readonly name: string
  readonly hash: string
}

export interface StaleProduct {
  readonly file: string
  /** the remembered producing command to re-run; "" when the product was never seen produced (recompile). */
  readonly rebuild: string
}

export interface Tracker {
  /** hashes of the CURRENT workspace listing (name+content per file), sorted by name for determinism. */
  readonly snap: (files: ReadonlyArray<{ readonly name: string; readonly content: string }>) => ReadonlyArray<FileSnap>
  /** Called AFTER each action with (tool, ok, before, after, command?):
   *  - tool !== "run": files whose hash changed/appeared are MODEL-WRITTEN (sources).
   *  - tool === "run" && ok: files whose hash changed/appeared (and were not model-authored) are PRODUCTS —
   *    remember producedBy[file] = { command, sourceDigest(before) }. */
  readonly recordAction: (input: {
    readonly tool: string
    readonly ok: boolean
    readonly command?: string
    readonly before: ReadonlyArray<FileSnap>
    readonly after: ReadonlyArray<FileSnap>
  }) => void
  /** Products named in `command` (token/./\ tolerant filename match) whose recorded source fingerprint
   *  ≠ the current one — i.e. built before the latest source edits, hence STALE. */
  readonly staleProducts: (command: string, current: ReadonlyArray<FileSnap>) => ReadonlyArray<StaleProduct>
  /** EVERY stale product, in PRODUCTION order (a chain like pi.c→pi.o→pi.exe lists pi.o before pi.exe), so
   *  the engine can rebuild them bottom-up before a check runs — not just the one the check names. */
  readonly allStale: (current: ReadonlyArray<FileSnap>) => ReadonlyArray<StaleProduct>
  /** digest of a check + everything it can observe (the full workspace) — for the idempotence cache. */
  readonly checkDigest: (check: unknown, current: ReadonlyArray<FileSnap>) => string
}

// Build-product extensions — a file with one of these that we never attributed to a recorded run is
// treated as a product with an UNKNOWN rebuild, so a stale one still asks for a manual recompile.
const PRODUCT_EXT = new Set(["exe", "o", "out", "obj", "dll", "so", "a", "lib", "dylib", "class"])
const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".")
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase()
}
const isProductExt = (name: string): boolean => PRODUCT_EXT.has(extOf(name))

/** basename, lowercased, leading `./` or `.\` stripped — for tolerant filename matching against a command. */
const baseName = (name: string): string => {
  const parts = name.replace(/^\.[/\\]/, "").split(/[/\\]/)
  return (parts[parts.length - 1] ?? name).toLowerCase()
}

export function tracker(): Tracker {
  const products = new Map<string, { command: string; sourceDigest: string }>()
  const sources = new Set<string>() // files the model authored — never a product (product→source migration)

  const snap: Tracker["snap"] = (files) =>
    files
      .map((f) => ({ name: f.name, hash: Hash.sha256(`${f.name}|${f.content}`) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  // sha256 over the sorted (name:hash) of the files that are NOT products — the compiler INPUTS (sources).
  const sourceDigest = (files: ReadonlyArray<FileSnap>): string =>
    Hash.sha256(
      files
        .filter((f) => !products.has(f.name))
        .map((f) => `${f.name}:${f.hash}`)
        .sort()
        .join("\n"),
    )

  const recordAction: Tracker["recordAction"] = ({ tool, ok, command, before, after }) => {
    const beforeHash = new Map(before.map((f) => [f.name, f.hash]))
    const changed = after.filter((f) => beforeHash.get(f.name) !== f.hash) // changed or newly-appeared
    const changedNames = new Set(changed.map((f) => f.name))
    if (tool !== "run") {
      // A model write/edit means these files are SOURCES — remember them and migrate any that were products.
      for (const f of changed) {
        sources.add(f.name)
        products.delete(f.name)
      }
    } else if (ok && typeof command === "string" && command.trim() !== "") {
      // A successful run's changed/new files are its PRODUCTS (unless the model authored them) — remember the
      // producing command + the source fingerprint it consumed (the fingerprint BEFORE this run).
      const src = sourceDigest(before)
      for (const f of changed) if (!sources.has(f.name)) products.set(f.name, { command, sourceDigest: src })
    }
    // Seed pre-existing build-product binaries we never attributed to a run (no rebuild command), baselined
    // against `before` (the pre-action source state), once — so a later source edit marks them STALE.
    const orphans = before.filter(
      (f) => isProductExt(f.name) && !products.has(f.name) && !sources.has(f.name) && !changedNames.has(f.name),
    )
    if (orphans.length > 0) {
      for (const f of orphans) products.set(f.name, { command: "", sourceDigest: "" })
      const src = sourceDigest(before) // now excludes the just-added orphan products
      for (const f of orphans) products.set(f.name, { command: "", sourceDigest: src })
    }
  }

  const staleProducts: Tracker["staleProducts"] = (command, current) => {
    const tokens = new Set(
      command
        .split(/[\s"'=]+/)
        .filter(Boolean)
        .map(baseName),
    )
    const curDigest = sourceDigest(current)
    const out: StaleProduct[] = []
    for (const [file, rec] of products) {
      if (tokens.has(baseName(file)) && rec.sourceDigest !== curDigest) out.push({ file, rebuild: rec.command })
    }
    return out
  }

  const allStale: Tracker["allStale"] = (current) => {
    const curDigest = sourceDigest(current)
    const out: StaleProduct[] = []
    for (const [file, rec] of products) if (rec.sourceDigest !== curDigest) out.push({ file, rebuild: rec.command }) // Map order = production order
    return out
  }

  const checkDigest: Tracker["checkDigest"] = (check, current) =>
    Hash.sha256(
      `${JSON.stringify(check ?? null)}|${current
        .map((f) => `${f.name}:${f.hash}`)
        .slice()
        .sort()
        .join("\n")}`,
    )

  return { snap, recordAction, staleProducts, allStale, checkDigest }
}
