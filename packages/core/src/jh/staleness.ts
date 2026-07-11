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
  /** improve3 P5 (I4): the stale products the CHECK command references PLUS their transitive production chain
   *  (pi.exe's rebuild names pi.o → include pi.o), in PRODUCTION order — but NOT unrelated stale products
   *  (t_mul.exe stays stale until ITS check runs). Collapses the wave-2 rebuild-EVERY-stale storm (500+/run). */
  readonly staleChainFor: (command: string, current: ReadonlyArray<FileSnap>) => ReadonlyArray<StaleProduct>
  /** digest of a check + everything it can observe (the full workspace) — for the idempotence cache. */
  readonly checkDigest: (check: unknown, current: ReadonlyArray<FileSnap>) => string
  /** improve4 P1: the current SOURCE digest — a fingerprint over every non-product file (the compiler
   *  inputs), the SAME notion staleProducts/allStale compare against internally. The regression registry
   *  stamps a passing test with this; a later source edit changes it, marking the test stale + re-runnable.
   *  Global (not per-chain) on purpose — a shared header/source edit can break ANY test, so re-running the
   *  registered set on any source change is the SAFE choice (missing a regression is exactly the §I6 hazard;
   *  the MAX_SUITE_MS budget + registered-only re-run keep it cheap). */
  readonly sourceDigestNow: (current: ReadonlyArray<FileSnap>) => string
  /** improve4 P1: does `command` execute/reference a tracked build product (an .exe/.o we have attributed
   *  to a producing run)? — the regression registry only registers a passing run/output_equals check whose
   *  command actually runs a workspace product (a `note`/`echo` check is not a regression test). */
  readonly referencesProduct: (command: string) => boolean
  /** improve4 P1: does `command`'s referenced product still EXIST in the given workspace listing? A
   *  registered test whose product was deleted/renamed is pruned (its basename no longer present). */
  readonly productPresent: (command: string, current: ReadonlyArray<FileSnap>) => boolean
  /** improve4 P4: the re-derive TARGET — among the SOURCE files feeding `command`'s product chain, the one
   *  the MOST tracked products depend on: the shared FOUNDATION, deepest in the dependency order (the
   *  library everything links, NOT the most-edited file — run75's most-edited was the wrong one to rewrite).
   *  Dependency order, never content/name (L3). Returns the actual filename, or undefined if no source is
   *  traceable. Ties → the highest-scoring source first seen. */
  readonly deepestSource: (command: string, current: ReadonlyArray<FileSnap>) => string | undefined
  /** improve5 P2: the per-file OBJECT-COMPILE command for source `file` — a tracked product whose rebuild is
   *  a `-c`-shaped compile referencing `file` (e.g. bigint.c → `gcc -c bigint.c -o bigint.o`). The
   *  transactional edit gate runs it as a SYNTAX check on `file`'s own unit BEFORE accepting an edit; undefined
   *  when none exists (a header, a first write, or a model that only whole-links) → the gate is OPPORTUNISTIC,
   *  never inventing a command (L4). Matches by basename; needs a `-c` token (so links are excluded). */
  readonly objectCompileFor: (file: string) => string | undefined
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

/** the base-named tokens a command references (module-level twin of the tracker's internal refsOf). */
const refsOfCommand = (command: string): Set<string> => new Set(command.split(/[\s"'=]+/).filter(Boolean).map(baseName))

/** improve6 P1 (gate surgery): extract ONLY the compile segment for `baseFile` from a possibly-COMPOUND
 *  command, keeping the leading environment-setup segments (`set PATH=…` / `export …`) it needs in a fresh
 *  shell. The wave-5 tx gate ran the WHOLE recorded compound — build AND test — so an edit that compiled
 *  and passed 13/15 tests was rejected 73× with a false "does not compile" (run104 [28]); the gate must
 *  never execute anything but the compiler. A `-c` segment cannot run a product, so the gate's
 *  "no longer compiles" message becomes truthful STRUCTURALLY. Returns undefined when the command has no
 *  `-c` segment referencing this file (the gate stays off for it — L4, opportunistic). */
export const compileSegment = (command: string, baseFile: string): string | undefined => {
  const base = baseName(baseFile)
  const env: string[] = []
  for (const raw of command.split("&&")) {
    const seg = raw.trim()
    if (seg === "") continue
    if (/^set\s+\w+=/i.test(seg) || /^export\s+\w+/.test(seg)) {
      env.push(seg)
      continue
    }
    if (/(^|\s)-c(\s|$)/.test(seg) && refsOfCommand(seg).has(base)) return [...env, seg].join(" && ")
  }
  return undefined
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

  const recordAction: Tracker["recordAction"] = ({ tool, command, before, after }) => {
    const beforeHash = new Map(before.map((f) => [f.name, f.hash]))
    const changed = after.filter((f) => beforeHash.get(f.name) !== f.hash) // changed or newly-appeared
    const changedNames = new Set(changed.map((f) => f.name))
    if (tool !== "run") {
      // A model write/edit means these files are SOURCES — remember them and migrate any that were products.
      for (const f of changed) {
        sources.add(f.name)
        products.delete(f.name)
      }
    } else if (typeof command === "string" && command.trim() !== "") {
      // A run's changed/new files are its PRODUCTS (unless the model authored them) — remember the producing
      // command + the source fingerprint it consumed (BEFORE this run). NOTE: recorded EVEN WHEN the run
      // reported failure — a compound like `gcc -c x.c && gcc x.o -o x.exe && .\x.exe` whose final exec
      // crashes reports ok=false, yet the `-c` step produced a VALID x.o; not recording it here left x.o an
      // unattributed orphan that nagged "STALE ARTIFACT … rebuild it" forever (P1 baseline run58, 194×). The
      // remembered command IS the rebuild; re-running it either regenerates the product or surfaces the real error.
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

  // basenames a command references (its arguments), for chain discovery.
  const refsOf = (command: string): Set<string> => new Set(command.split(/[\s"'=]+/).filter(Boolean).map(baseName))

  const staleChainFor: Tracker["staleChainFor"] = (command, current) => {
    const curDigest = sourceDigest(current)
    const isStale = (rec: { sourceDigest: string }): boolean => rec.sourceDigest !== curDigest
    // BFS: include a stale product if the check command references it, then follow each included product's
    // rebuild command to the products IT references (pi.exe → gcc pi.o -o pi.exe → include pi.o), etc.
    const want = new Set<string>()
    let frontier = refsOf(command)
    for (let hops = 0; hops < 32 && frontier.size > 0; hops++) {
      const next = new Set<string>()
      for (const [file, rec] of products) {
        if (want.has(file) || !frontier.has(baseName(file)) || !isStale(rec)) continue
        want.add(file)
        for (const t of refsOf(rec.command)) next.add(t)
      }
      frontier = next
    }
    const out: StaleProduct[] = []
    for (const [file, rec] of products) if (want.has(file) && isStale(rec)) out.push({ file, rebuild: rec.command }) // Map order = production order
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

  const sourceDigestNow: Tracker["sourceDigestNow"] = (current) => sourceDigest(current)

  const referencesProduct: Tracker["referencesProduct"] = (command) => {
    const refs = refsOf(command)
    for (const file of products.keys()) if (refs.has(baseName(file))) return true
    return false
  }

  const productPresent: Tracker["productPresent"] = (command, current) => {
    const refs = refsOf(command)
    const present = new Set(current.map((f) => baseName(f.name)))
    for (const file of products.keys()) if (refs.has(baseName(file)) && present.has(baseName(file))) return true
    return false
  }

  const deepestSource: Tracker["deepestSource"] = (command, current) => {
    const nameByBase = new Map(current.map((f) => [baseName(f.name), f.name]))
    const isSourceBase = (b: string): boolean => nameByBase.has(b) && !isProductExt(b) // present, non-product file
    // Collect the SOURCE files feeding `command`'s product chain: the sources the command names directly,
    // plus those named by each product's rebuild command as we walk the chain (product → its rebuild's refs).
    const chainSources = new Set<string>()
    for (const r of refsOf(command)) if (isSourceBase(r)) chainSources.add(r)
    const seen = new Set<string>()
    let frontier = refsOf(command)
    for (let hops = 0; hops < 32 && frontier.size > 0; hops++) {
      const next = new Set<string>()
      for (const [file, rec] of products) {
        if (seen.has(file) || !frontier.has(baseName(file))) continue
        seen.add(file)
        for (const r of refsOf(rec.command)) {
          if (isSourceBase(r)) chainSources.add(r)
          else next.add(r)
        }
      }
      frontier = next
    }
    if (chainSources.size === 0) return undefined
    // Score each candidate by how many tracked products' rebuild commands reference it — the shared
    // foundation (a library linked by every primitive test + the final program) scores highest.
    let best: string | undefined
    let bestScore = -1
    for (const src of chainSources) {
      let score = 0
      for (const [, rec] of products) if (refsOf(rec.command).has(src)) score++
      if (score > bestScore) {
        bestScore = score
        best = src
      }
    }
    return best !== undefined ? (nameByBase.get(best) ?? best) : undefined
  }

  const objectCompileFor: Tracker["objectCompileFor"] = (file) => {
    // improve6 P1: return the compile SEGMENT only (env prefixes + the `-c` part), NEVER the recorded
    // compound — the wave-5 gate executed build+TEST chains and rejected compiling edits on test failures
    // (run104: 13/15 passing, rejected 73× as "does not compile").
    for (const [, rec] of products) {
      if (rec.command === "") continue
      const seg = compileSegment(rec.command, file)
      if (seg !== undefined) return seg
    }
    return undefined
  }

  return { snap, recordAction, staleProducts, allStale, staleChainFor, checkDigest, sourceDigestNow, referencesProduct, productPresent, deepestSource, objectCompileFor }
}
