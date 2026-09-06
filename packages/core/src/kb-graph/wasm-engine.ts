import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import path, { join } from "node:path"
import { Global } from "../global"
import { KbChunk } from "./chunk"
import { KbClaim } from "./claim"
import { selectSlice, type SliceMeta } from "./graph-slice"
import { EngineFault } from "./engine-fault"
import { GraphSnapshot } from "./snapshot"

// The in-process Ladybug graph-memory engine (WASM) — the single engine that runs EVERYWHERE
// (the 2026-07-19 pivot). The native addon can't run in a phone app and
// segfaults under Bun; the WASM build runs in-process under Bun/Node (and, later, the browser) with
// vector + FTS BUILT-IN — no sidecar, no native binary, no extension vendoring. This module owns the
// graph in-process and IS the single-writer (§4.1).
//
// Persistence = MEMFS + snapshot (measured: real-disk NODEFS is fragile on Windows — a drive-letter
// path hits an emscripten getcwd bug; an explicit NODEFS mount + on-disk index creation hangs; MEMFS
// (pure-RAM) is rock-solid). So the DB lives in the emscripten MEMFS at `/<memfs>/graph`, and we
// SNAPSHOT it to a real directory: after writes CHECKPOINT (merges the WAL into one `graph` file),
// then copy the MEMFS files out to disk; on open, copy them back in before opening. Snapshots are
// debounced + forced on flush/close, so the loss window on a hard crash is bounded (the durability↔
// perf trade the owner accepted).
//
// ⚠️ WASM API: `@ladybugdb/wasm-core/nodejs/sync` is require-only (createRequire); `init()` once,
// globally; queries are SYNC (`conn.query`), rows via `.getAllObjects()`; params via prepare→execute.
// Open a SUBDIR (`/x/graph`), never the FS root. POSIX virtual paths only.

/** The `opened` value when no retained generation could be used and the graph started over. */
export const EMPTY_GENERATION = "(empty)"

/**
 * What it took to get a usable store open — NC-REL-018.
 *
 * ⚠️ Reported rather than logged-and-forgotten because a silent fallback is indistinguishable from a
 * healthy boot, and the user whose newest writes were dropped is entitled to know which generation
 * they are actually reading.
 */
export interface SnapshotRecovery {
  /** The generation in use, or `EMPTY_GENERATION`. */
  opened: string
  /** Generations passed over, newest first, each with why. */
  skipped: { name: string; reason: string }[]
  /** Damaged generations kept on disk for diagnosis instead of deleted. */
  quarantined: string[]
}

/**
 * ⚠️ `claim` and `source` are the lifecycle's two kinds and they are NOT interchangeable with the
 * older three. A `claim` is a governed statement — it carries a status, an identity and a supersession
 * chain. A `source` is the EVIDENCE a claim cites, and it is deliberately not a memory in its own
 * right: "evidence is not the claim", so a source never answers a question, it only says where an
 * answer came from.
 */
export type MemoryKind = "entity" | "episode" | "passage" | "claim" | "source"
export type Relation = "staged" | "core"

export interface MemoryInput {
  readonly id: string
  readonly kind: MemoryKind
  readonly text: string
  readonly name?: string
  readonly scope: string
  readonly source?: string
  readonly agent?: string
  readonly confidence?: number
  readonly relation?: Relation
  readonly embedding?: readonly number[]
  readonly validFrom?: string
  /** Lifecycle status. Claims only; everything else stores `active` and never changes it. */
  readonly status?: KbClaim.ClaimStatus
  /** Claim identity, denormalized onto the node so a scan can key on it without a traversal. */
  readonly subject?: string
  readonly predicate?: string
  readonly conflictKey?: string
  /** Source nodes only: what can MOVE, and what kind of thing it is. */
  readonly evidence?: string
  readonly evidenceKind?: KbClaim.EvidenceKind
}

export interface EdgeInput {
  readonly from: string
  readonly to: string
  readonly type: string
  readonly scope: string
  readonly source?: string
  readonly confidence?: number
}

export interface SearchInput {
  readonly query?: string
  readonly embedding?: readonly number[]
  readonly k?: number
  readonly scopes?: readonly string[]
  readonly kinds?: readonly MemoryKind[]
  /**
   * Which lifecycle statuses may come back. Defaults to `KbClaim.RECALL_STATUSES` — CURRENT TRUTH.
   *
   * 🔴 This default is the "separate current truth from history at retrieval" requirement, and it is a
   * DEFAULT rather than a filter the caller opts into for the same reason `MemoryAccess` is required:
   * a rule every call site must remember is a rule some call site will not. Timeline and explanation
   * reads pass the wider set explicitly, so the privileged view is visible at its call site.
   */
  readonly statuses?: readonly KbClaim.ClaimStatus[]
}

export interface MemoryRow {
  readonly id: string
  readonly kind: MemoryKind
  readonly text: string
  readonly name: string | null
  readonly scope: string
  readonly source: string | null
  readonly confidence: number | null
  readonly relation: Relation
  /** Lifecycle status. A row written before the lifecycle, or a non-claim, reads `active`. */
  readonly status: KbClaim.ClaimStatus
  readonly subject: string | null
  readonly predicate: string | null
  readonly conflictKey: string | null
  /** The claim that replaced this one, when it was superseded. */
  readonly supersededBy: string | null
  /** Source nodes: the locator that can move. */
  readonly evidence: string | null
  readonly evidenceKind: KbClaim.EvidenceKind | null
}

export interface SearchHit extends MemoryRow {
  readonly score: number
  /** Valid-time (ISO) — when the fact became true. The recency signal for ranking; absent = unknown. */
  readonly validAt?: string
}

/** Engine timestamps come back as a Date or a driver string; normalise to ISO, or undefined. */
const isoTime = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

/** What `candidates` selects. Short columns only — see the method for why `text` is not among them. */
export interface CandidateInput {
  readonly scopes?: readonly string[]
  readonly kinds?: readonly MemoryKind[]
  readonly statuses?: readonly KbClaim.ClaimStatus[]
  readonly relation?: Relation
  readonly includeInvalid?: boolean
  /** `oldest` (the default) is what "never used, oldest first" and the prune policy both want. */
  readonly order?: "oldest" | "newest"
  readonly limit?: number
}

/** A memory described by everything EXCEPT its body. */
export interface CandidateRow {
  readonly id: string
  readonly scope: string
  readonly kind: MemoryKind
  readonly name: string | null
  readonly source: string | null
  readonly confidence: number | null
  readonly relation: Relation
  readonly status: KbClaim.ClaimStatus
  readonly conflictKey: string | null
  /** ISO, when the engine had one. Absent rather than faked. */
  readonly createdAt?: string
}

export interface ListInput {
  readonly scopes?: readonly string[]
  readonly kinds?: readonly MemoryKind[]
  readonly includeInvalid?: boolean
  /** Lifecycle lens. Unset = every status, because the Memory app's job is to show what is THERE. */
  readonly statuses?: readonly KbClaim.ClaimStatus[]
  readonly limit?: number
  readonly offset?: number
}

/** What a caller asks the lifecycle to record. Every identity field is a PROPOSAL until validated. */
export interface ClaimInput {
  readonly scope: string
  /** The claim itself, as one standalone sentence. */
  readonly statement: string
  /** What it is about — an entity NAME, resolved to a node by `KbChunk.entityID`. */
  readonly subject?: string
  /** Which question about the subject it answers. Validated against `KbClaim.CLAIM_PREDICATES`. */
  readonly predicate?: string
  readonly confidence?: number
  readonly relation?: Relation
  readonly source?: string
  readonly agent?: string
  readonly embedding?: readonly number[]
  readonly validFrom?: string
  readonly evidence?: readonly KbClaim.Evidence[]
  /** The caller's reach. A scope outside it is REFUSED — see `addClaim`. */
  readonly scopes?: readonly string[]
}

export interface ClaimResult {
  readonly ok: boolean
  readonly id?: string
  readonly status?: KbClaim.ClaimStatus
  /** Did the harness accept a conflict identity? `false` = this claim corrects nothing, by design. */
  readonly identified?: boolean
  /** The statement was already recorded, unchanged; nothing new was written. */
  readonly deduped?: boolean
  /** Claims this one retired. Empty when there was nothing to correct. */
  readonly superseded: readonly string[]
  readonly reason?: "empty" | "refused-scope" | "too-many-revisions"
}

export interface EvidenceRow {
  readonly claimID: string
  readonly id: string
  readonly kind: KbClaim.EvidenceKind
  readonly locator: string
  readonly label: string
}

export interface ClaimHistory {
  /** The claim that was asked for. */
  readonly claim: MemoryRow
  /** The claim that answers this question NOW, when the one asked for has been replaced. */
  readonly current: MemoryRow | null
  /** The asked-for claim first, then everything it replaced, transitively. */
  readonly timeline: readonly MemoryRow[]
  /** Every source cited by anything on the timeline. */
  readonly evidence: readonly EvidenceRow[]
}

/** A supersession chain long enough to be a corruption rather than a history. Bounds both walks. */
const MAX_CLAIM_CHAIN = 64

export interface GraphInput {
  readonly scopes?: readonly string[]
  readonly limit?: number
}

export interface MemoryGraphResult {
  readonly nodes: MemoryRow[]
  readonly edges: EdgeRow[]
  readonly slice: SliceMeta
}

/**
 * How many ids the selection may consider per requested node — the pool the structure/recency split
 * chooses FROM. Larger than `limit` on purpose: choosing 600 nodes out of the newest 600 is the
 * defect, not the fix. Bounded because a scan of a very large store must stay one bounded read.
 */
const NODE_SCAN_FACTOR = 8
const NODE_SCAN_CAP = 20_000
/**
 * A memory bound on this process, NOT a guess at how many edges the client wants.
 *
 * ⚠️ The old code used `limit * 4` and applied it BEFORE filtering to the selected nodes, so the cap
 * was spent on edges of memories that were never returned and the edges actually on screen went
 * missing — silently, and worse the larger the store.
 */
const EDGE_SCAN_CAP = 200_000

export interface EdgeRow {
  readonly from: string
  readonly to: string
  readonly type: string
}

const toRow = (r: Record<string, unknown>): MemoryRow => ({
  id: String(r.id),
  kind: r.kind as MemoryKind,
  text: String(r.text ?? ""),
  name: (r.name as string | null) ?? null,
  scope: String(r.scope),
  source: (r.source as string | null) ?? null,
  confidence: (r.confidence as number | null) ?? null,
  relation: (r.relation as Relation) ?? "staged",
  // ⚠️ A NULL status reads `active`, not "unknown". Every non-claim row has no lifecycle, and a row
  // that predates the lifecycle was the current answer when it was written; making the absent case
  // mean "retired" would silently empty an upgraded store's recall.
  status: (r.status as KbClaim.ClaimStatus | null) ?? "active",
  subject: (r.subject as string | null) ?? null,
  predicate: (r.predicate as string | null) ?? null,
  conflictKey: (r.conflict_key as string | null) ?? null,
  supersededBy: (r.superseded_by as string | null) ?? null,
  evidence: (r.evidence as string | null) ?? null,
  evidenceKind: (r.evidence_kind as KbClaim.EvidenceKind | null) ?? null,
})

/** Every column `hydrate` and the history reads project. One list, because a column added to one of
 *  them and forgotten in the other is a field that is null in half the product. */
const ROW_PROJECTION =
  `m.id AS id, m.kind AS kind, m.text AS text, m.name AS name, m.scope AS scope, ` +
  `m.source AS source, m.confidence AS confidence, m.relation AS relation, m.status AS status, ` +
  `m.subject AS subject, m.predicate AS predicate, m.conflict_key AS conflict_key, ` +
  `m.superseded_by AS superseded_by, m.evidence AS evidence, m.evidence_kind AS evidence_kind`

const DEFAULT_DIM = 1024
const RRF_K = 60
/**
 * The exact-identifier leg's RRF weight.
 *
 * Two fuzzy legs contribute at most `2/(RRF_K+1)` to one id — the ceiling reached by a row that tops
 * BOTH vector and keyword search at once. 3 clears that ceiling STRICTLY, which is the property worth
 * having: at 2 the exact hit merely ties and survives on the stable sort's insertion order, and a
 * guarantee that rests on which loop ran first is not a guarantee. Measured by A/B — at 1 the
 * two-leg test reddens, at 2 it passes only by that tie-break.
 */
const EXACT_RANK_WEIGHT = 3
const SNAPSHOT_DEBOUNCE_MS = 1_000

const vectorLiteral = (v: readonly number[]) => `[${v.map((n) => (Number.isFinite(n) ? n : 0)).join(",")}]`

// --- global WASM module (init once) ------------------------------------------------------------

let lbugModule: any
let initPromise: Promise<any> | undefined
let memfsCounter = 0
/** Resolved once by `ensureScratchRoot`: `SCRATCH_ROOT`, or the junction on a cross-drive home. */
let effectiveRoot: string | undefined

/**
 * Strip a leading `C:` so a Windows path becomes ROOT-ANCHORED but keeps all its segments.
 *
 * 🔴 **The engine's constraint is "no drive letter", NOT "one segment".** A root-anchored path
 * resolves against the process's CURRENT DRIVE, so with home and cwd on the same drive — every normal
 * install — this reaches exactly the home directory, with nothing created outside it. Do not
 * re-derive the single-root-name rule: it was measured wrong once. The tables are in
 * `notes/reports/kb-graph-scratch-path-and-rel-scope-2026-07-30.md`.
 */
const stripDriveLetter = (p: string): string => p.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/")

/**
 * Fallback only: the old root-anchored junction NAME. Reached solely when `scratchHome()` sits on a
 * DIFFERENT drive than the process cwd, because a drive-letter-free path cannot cross drives — it
 * would silently resolve onto the cwd's drive instead. `ensureScratchRoot` proves which case it is by
 * sentinel rather than assuming, and says so out loud when it falls back.
 */
const SCRATCH_ALIAS_WIN32 = "/novaclaw-kbmem"

/**
 * Where the scratch bytes REALLY live: under the instance home, like every other file we write.
 *
 * ⚠️ On POSIX this is used as-is — a real path under `<instance-home>/cache` already IS a
 * root-anchored path with no drive letter, which is all the engine needs. 🔴 **Never hand this engine
 * a bare root-level name on POSIX: `/novaclaw-kbmem` is the FILESYSTEM ROOT there and fails with
 * EACCES for any non-root user.** It shipped that way once and went unnoticed, because development
 * happens on a Windows box.
 */
export const scratchHome = (): string => path.join(Global.Path.cache, "kbmem")

/**
 * The path handed to the ENGINE. On POSIX it is `scratchHome()` itself.
 *
 * 🔴 On Windows it cannot be: the engine's `current_path()` fails for **anything carrying a drive
 * letter**, and it ignores emscripten's VFS mounts, so no `FS.mount` moves the bytes either — it
 * silently writes to `C:\<mountpoint>` instead. Stripping `C:` gives it a path it accepts that
 * already IS the home directory. See `stripDriveLetter`; the measurements, including the one the
 * first investigation skipped, are in
 * `notes/reports/kb-graph-scratch-path-and-rel-scope-2026-07-30.md`.
 */
export const SCRATCH_ROOT: string = process.platform === "win32" ? stripDriveLetter(scratchHome()) : scratchHome()

/** Age after which a scratch dir is assumed abandoned by a dead process and swept. */
const SCRATCH_STALE_MS = 24 * 60 * 60 * 1000

/**
 * Scratch dirs this process opened, so exit can remove any whose store was never `close()`d.
 *
 * `close()` is the primary reaper, but plenty of callers legitimately never close — a test that lets
 * the store fall out of scope, a short-lived CLI, a request-scoped open. Without this, each of those
 * leaks one directory until the age sweep, which is a whole day of accumulation on a machine that
 * runs the suite repeatedly. Measured: 8 survivors from two test files in one run.
 */
const openScratch = new Set<string>()
let exitHookInstalled = false

const removeScratch = (dir: string) => {
  openScratch.delete(dir)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* a handle is still open; the age sweep in `open` is the backstop */
  }
}

const installExitHook = () => {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // Sync only — an `exit` listener cannot await, which is why `removeScratch` uses `rmSync`.
  process.on("exit", () => {
    for (const dir of [...openScratch]) removeScratch(dir)
  })
}

/**
 * Best-effort sweep of scratch dirs left by processes that died before `close()` ran (a crash, a
 * SIGKILL, a wall-clock-killed test unit). Age-based rather than pid-based: a pid is reused, and
 * probing liveness cross-platform costs more than it saves for a throwaway directory.
 */
const sweepStaleScratch = (root: string) => {
  try {
    const now = Date.now()
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      try {
        if (now - statSync(dir).mtimeMs > SCRATCH_STALE_MS) rmSync(dir, { recursive: true, force: true })
      } catch {
        /* raced with another instance, or in use — leave it */
      }
    }
  } catch {
    /* no scratch root yet */
  }
}

/**
 * Make the scratch root exist and RETURN the path the engine should be handed.
 *
 * POSIX, and Windows whenever the home is on the current drive (the normal case): that is
 * `SCRATCH_ROOT` — `scratchHome()` with any drive letter stripped — so this is just `mkdir -p` plus
 * the sentinel that proves the stripped path resolves back to the same directory. **Nothing is
 * created outside the home.**
 *
 * The junction below is now a CROSS-DRIVE FALLBACK ONLY, not the normal path. Its three states are
 * still handled deliberately, because a machine upgrading from the old build may have one:
 *   • already a link → nothing to do
 *   • a real DIRECTORY left by an older build → migrate its contents, then replace it with the link.
 *     ⚠️ Not deleted blindly: it is the previous version's scratch and may hold a live store.
 *   • the link cannot be created → fall back to using the alias as a real directory. Memory is a
 *     re-derivable tier; refusing to open it would be worse, and the fault is named, not swallowed.
 */
const ensureScratchRoot = (): string => {
  const real = scratchHome()
  mkdirSync(real, { recursive: true })
  if (process.platform !== "win32") return real
  if (effectiveRoot) return effectiveRoot

  // Does the drive-letter-free form actually REACH `real`? It does iff `real` sits on the process's
  // current drive, since that is what a root-anchored path resolves against. Proven with a sentinel
  // rather than by comparing drive letters, because `subst` and mapped drives let two different
  // letters name one volume — and because this resolves the path exactly the way the engine will.
  const sentinel = `.driveprobe_${process.pid}`
  try {
    writeFileSync(join(real, sentinel), "")
    const reaches = existsSync(join(SCRATCH_ROOT, sentinel))
    rmSync(join(real, sentinel), { force: true })
    if (reaches) return (effectiveRoot = SCRATCH_ROOT)
  } catch {
    try {
      rmSync(join(real, sentinel), { force: true })
    } catch {
      /* nothing to clean */
    }
  }

  // Cross-drive: the home is on another volume, so no drive-letter-free path can reach it — it would
  // silently resolve onto the cwd's drive instead. This is the ONE case that still creates a name
  // outside the home, and it is named out loud rather than done quietly (ruling 2). Memory is a
  // re-derivable tier (§4.9), so degrading storage beats refusing to open it.
  console.warn(
    `kb-memory: ${real} is not on the current drive, so the engine cannot be given a path to it; ` +
      `falling back to the ${SCRATCH_ALIAS_WIN32} junction. This is the only thing NovaClaw writes ` +
      `outside your home directory — see AGENTS.md → design principle 11.`,
  )
  effectiveRoot = SCRATCH_ALIAS_WIN32

  let link: ReturnType<typeof lstatSync> | undefined
  try {
    link = lstatSync(SCRATCH_ALIAS_WIN32)
  } catch {
    /* nothing there yet */
  }
  if (link?.isSymbolicLink()) return effectiveRoot

  if (link?.isDirectory()) {
    // Migrate an old drive-root scratch into the home, then swap in the link. Best-effort: a
    // directory still open by another process stays where it is and is swept by age as before.
    for (const name of readdirSync(SCRATCH_ALIAS_WIN32)) {
      try {
        rmSync(join(real, name), { recursive: true, force: true })
        renameSync(join(SCRATCH_ALIAS_WIN32, name), join(real, name))
      } catch {
        /* in use — leave it for the age sweep */
      }
    }
    try {
      rmSync(SCRATCH_ALIAS_WIN32, { recursive: false, force: true })
    } catch {
      return effectiveRoot // still populated; keep using it as a real directory this run
    }
  }

  try {
    symlinkSync(real, SCRATCH_ALIAS_WIN32, "junction")
  } catch (error) {
    // Name the fault; do not disable memory over it.
    console.warn(
      `kb-memory: could not link ${SCRATCH_ALIAS_WIN32} -> ${real} (${(error as Error).message}); ` +
        `scratch will use ${SCRATCH_ALIAS_WIN32} directly this run.`,
    )
    mkdirSync(SCRATCH_ALIAS_WIN32, { recursive: true })
  }
  return effectiveRoot
}

const loadWasm = (): Promise<any> => {
  if (!initPromise) {
    initPromise = (async () => {
      const require = createRequire(import.meta.url)
      const lbug = require("@ladybugdb/wasm-core/nodejs/sync")
      await lbug.init()
      lbugModule = lbug
      return lbug
    })()
  }
  return initPromise
}

/** How long `close()` will wait for a final flush before giving up and saying so. */
const CLOSE_FLUSH_DEADLINE_MS = 10_000

export class WasmMemory {
  private readonly lbug: any
  private readonly db: any
  private readonly conn: any
  private readonly memfsDir: string
  private readonly realDir: string
  readonly dim: number
  private snapshotTimer: ReturnType<typeof setTimeout> | undefined
  private dirty = false
  private closed = false
  /**
   * Set once the WASM module has suffered a FATAL fault. Non-undefined means every later call must
   * fail immediately with this message rather than queue behind a lock that will never release.
   */
  private dead: string | undefined
  /**
   * What `open()` had to do to get a usable store. `opened` is the generation actually in use, so
   * `"(empty)"` means every retained generation was unusable and the graph started over.
   */
  recovery: SnapshotRecovery = { opened: EMPTY_GENERATION, skipped: [], quarantined: [] }
  private lastCheckpointError: string | undefined
  /** Why durable writes are not currently landing, or `undefined` when they are. */
  get publishBlocked(): string | undefined {
    return this.lastCheckpointError
  }
  // The WASM connection is single-threaded: an op does several awaited engine calls that must be
  // atomic w.r.t. the debounced snapshot (a CHECKPOINT interleaved mid-result-read corrupts it). All
  // public ops + persist run through this serial lock so they never interleave.
  private lock: Promise<unknown> = Promise.resolve()

  /**
   * Await `work`, but never past `ms`. Resolves true if it finished, false if the deadline won.
   *
   * The loser is left dangling on purpose: the only caller is `close()`, and a promise chained to a
   * dead WASM module will never settle, so there is nothing to cancel and nobody left to await it.
   */
  private async bounded(work: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
      timer.unref?.()
    })
    try {
      return await Promise.race([work.then(() => true, () => true), deadline])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 🔴 **THE DEAD LATCH IS ENFORCED HERE — and this is the only place it can be.**
   *
   * `dead`'s own doc says every later call must fail immediately "rather than queue behind a lock
   * that will never release", and until this line nothing honoured it: the latch had four readers
   * (`persist`, the branch that sets it, `touch`, and prose in `close`) and not one of them was an
   * operation. So after an `Aborted(...)` every op still ran `this.serialize(() => this._op())`,
   * chained onto `this.lock`, and issued a statement against a corpse. The lock is a promise chain,
   * so the FIRST call that never settles holds it for every later call in the process — and the
   * auto-recall leg (`session/runner/llm.ts`) has no timeout, so one fatal abort wedged every
   * subsequent turn of every session, permanently, at 0.1% CPU with nothing in the log.
   *
   * ⚠️ **Before the lock, deliberately.** Queueing the rejection behind `this.lock` would inherit
   * the very hang it exists to prevent. `close()` is unaffected: it reaches `flush()` through
   * `bounded()`, which treats a rejection as "finished".
   *
   * The message names the ORIGINAL fault, not this call — see `EngineFault.deadMessage`.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    if (this.dead) return Promise.reject(new Error(this.dead))
    const run = this.lock.then(fn, fn)
    this.lock = run.then(
      () => {},
      () => {},
    )
    return run
  }

  private constructor(lbug: any, db: any, conn: any, memfsDir: string, realDir: string, dim: number) {
    this.lbug = lbug
    this.db = db
    this.conn = conn
    this.memfsDir = memfsDir
    this.realDir = realDir
    this.dim = dim
  }

  /** Open (or create) the memory graph persisted at real directory `realDir`. Loads the WASM engine,
   *  restores any prior snapshot into MEMFS, opens the DB there, and ensures the schema + indexes. */
  static async open(realDir: string, opts: { dim?: number } = {}): Promise<WasmMemory> {
    const dim = opts.dim ?? DEFAULT_DIM
    const lbug = await loadWasm()
    const FS = lbug.getFS()
    // Unique per open (pid + counter) so a new instance never reads a previous run's leftover DB
    // file — the stale-node symptom that motivated the pid in the first place. Durability is OUR
    // real-disk snapshot at `realDir`, restored below; this scratch dir is throwaway and `close()`
    // removes it. See SCRATCH_ROOT for why it may not live at the filesystem root.
    const scratchRoot = ensureScratchRoot()
    sweepStaleScratch(scratchRoot)
    installExitHook()
    const memfsDir = `${scratchRoot}/${process.pid}_${memfsCounter++}`
    mkdirSync(memfsDir, { recursive: true })
    openScratch.add(memfsDir)
    // `FS.mkdir` is not recursive, so create the parent first. Both may already exist.
    for (const dir of [scratchRoot, memfsDir]) {
      try {
        FS.mkdir(dir)
      } catch {
        /* exists, or the host FS already has it */
      }
    }
    // Self-heal a stale/incompatible artifact at realDir. Memory is a re-derivable tier (§4.9), so a
    // path we can't restore from must never brick the engine — we discard it and start fresh instead:
    //   • a single FILE named `graph` left by the RETIRED native sidecar (native Ladybug DB = one file;
    //     the WASM engine expects `graph/` to be a snapshot DIRECTORY) — the observed upgrade breakage,
    //   • or any non-directory / unreadable path.
    // Without this, `mkdirSync`/`readdirSync` throw ENOTDIR and memory silently degrades to disabled.
    if (existsSync(realDir) && !statSync(realDir).isDirectory()) {
      rmSync(realDir, { recursive: true, force: true })
    }
    mkdirSync(realDir, { recursive: true })

    /**
     * RESTORE, NEWEST GENERATION FIRST, FALLING BACK RATHER THAN FAILING — NC-REL-018.
     *
     * 🔴 The old restore copied whatever sat in `realDir` into MEMFS and opened it. A generation torn
     * by a crash mid-publish therefore came back on every single retry: the wrapper cleared its
     * in-process promise and re-read the same bytes, so a one-second window could cost the user every
     * durable memory they had. Each candidate now has to VERIFY (manifest digests) and then actually
     * OPEN before it is accepted; one that does neither is moved aside, not deleted, and the previous
     * generation is tried.
     *
     * ⚠️ Starting empty is the last resort, not the first branch. Memory is a re-derivable tier (§4.9)
     * so an empty store is survivable, but reaching for it before exhausting the retained generations
     * would turn recoverable damage into permanent loss.
     */
    const clearScratch = () => {
      for (const f of (FS.readdir(memfsDir) as string[]).filter((n) => n !== "." && n !== "..")) {
        try {
          FS.unlink(`${memfsDir}/${f}`)
        } catch {
          /* nothing to remove */
        }
      }
    }
    const recovery: SnapshotRecovery = { opened: EMPTY_GENERATION, skipped: [], quarantined: [] }
    let store: WasmMemory | undefined
    for (const gen of GraphSnapshot.candidates(realDir)) {
      const files = GraphSnapshot.read(gen)
      if (!files) {
        recovery.skipped.push({ name: gen.name, reason: "did not verify" })
        const held = GraphSnapshot.quarantine(realDir, gen)
        if (held) recovery.quarantined.push(held)
        continue
      }
      clearScratch()
      for (const [name, bytes] of files) FS.writeFile(`${memfsDir}/${name}`, bytes)
      try {
        const db = new lbug.Database(`${memfsDir}/graph`)
        const conn = new lbug.Connection(db)
        const candidate = new WasmMemory(lbug, db, conn, memfsDir, realDir, dim)
        await candidate.ensureSchema()
        // ⚠️ The DDL alone is not proof: `ensureSchema` swallows "already exists", which is exactly
        // what a restored store reports. A read that touches the storage is what says the bytes work.
        //
        // 🔴 And it names `m.status` on purpose. A generation written before the claim lifecycle has a
        // `Memory` table WITHOUT the lifecycle columns, and `CREATE NODE TABLE` on a table that
        // already exists is swallowed as "already exists" — so that store would open and then fail on
        // the first governed read, at recall time, in front of a user. Referencing a new column here
        // turns that into an ordinary unusable generation: skipped, quarantined for diagnosis, and the
        // graph starts over.
        //
        // This IS the no-migration ruling (AGENTS.md principle 1) executed rather than argued: memory
        // is a re-derivable tier, there is no install whose rows we owe continuity to, and the cost of
        // the clean schema is that a dev instance's old graph is dropped instead of carried.
        await candidate.q(`MATCH (m:Memory) WHERE m.status IS NULL RETURN count(m)`)
        store = candidate
        recovery.opened = gen.name
        break
      } catch (error) {
        recovery.skipped.push({ name: gen.name, reason: (error as Error).message.slice(0, 200) })
        const held = GraphSnapshot.quarantine(realDir, gen)
        if (held) recovery.quarantined.push(held)
      }
    }
    if (!store) {
      clearScratch()
      const db = new lbug.Database(`${memfsDir}/graph`)
      const conn = new lbug.Connection(db)
      store = new WasmMemory(lbug, db, conn, memfsDir, realDir, dim)
      await store.ensureSchema()
    }
    store.recovery = recovery
    // Publishing here is what makes a fresh store durable and what retires the legacy flat layout. A
    // restored store is not dirty and already has a generation, so for it this is a no-op.
    await store.flush()
    if (recovery.skipped.length > 0)
      console.warn(
        `kb-memory: fell back to ${recovery.opened === EMPTY_GENERATION ? "an EMPTY store" : recovery.opened}; ` +
          `unusable: ${recovery.skipped.map((skip) => `${skip.name} (${skip.reason})`).join(", ")}` +
          `${recovery.quarantined.length > 0 ? `; kept for diagnosis: ${recovery.quarantined.join(", ")}` : ""}`,
      )
    return store
  }

  // Ladybug params go through prepare→execute (query() alone runs a bare statement). The sync build's
  // calls may be sync or promise-returning — awaiting a non-promise is harmless.
  private async q(cypher: string, params?: Record<string, unknown>): Promise<any> {
    if (!params) return this.conn.query(cypher)
    const stmt = await this.conn.prepare(cypher)
    return this.conn.execute(stmt, params)
  }

  private async rows(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const result = await this.q(cypher, params)
    return (await result.getAllObjects()) as Record<string, unknown>[]
  }

  private async ddl(cypher: string): Promise<void> {
    try {
      await this.q(cypher)
    } catch (error) {
      if (!/already exists|Binder exception: .* exists/i.test(String((error as Error).message))) throw error
    }
  }

  private async ensureSchema(): Promise<void> {
    await this.ddl(
      `CREATE NODE TABLE Memory(
         id STRING, kind STRING, text STRING, name STRING, scope STRING,
         source STRING, agent STRING, confidence DOUBLE, relation STRING,
         status STRING, subject STRING, predicate STRING, conflict_key STRING, superseded_by STRING,
         evidence STRING, evidence_kind STRING,
         t_valid TIMESTAMP, t_invalid TIMESTAMP, t_created TIMESTAMP, t_expired TIMESTAMP,
         embedding FLOAT[${this.dim}], PRIMARY KEY(id))`,
    )
    /**
     * 🔴 **`Rel` carries NO scope, and must not grow one.** An edge's reach is a pure function of
     * its two endpoints, so a stored copy is a second spelling of a fact the nodes already hold — and
     * the copy is the one that goes stale (`moveScope` retargets a cabinet with one `SET m.scope` and
     * would never update it). A claim's reach is the CLAIM NODE's scope, which is exactly why a claim
     * is a node rather than an edge property.
     *
     * ⚠️ **The refusal did NOT go away with the column** — see `addEdge`. Full argument and the
     * measurement in `notes/reports/kb-graph-scratch-path-and-rel-scope-2026-07-30.md`.
     */
    await this.ddl(
      `CREATE REL TABLE Rel(
         FROM Memory TO Memory, type STRING, source STRING, confidence DOUBLE,
         t_valid TIMESTAMP, t_invalid TIMESTAMP, t_created TIMESTAMP, t_expired TIMESTAMP)`,
    )
    await this.ddl(`CALL CREATE_VECTOR_INDEX('Memory', 'mem_vec', 'embedding', metric := 'cosine')`)
    await this.ddl(`CALL CREATE_FTS_INDEX('Memory', 'mem_fts', ['text', 'name'])`)
    // ⚠️ No publish here. `open()` runs this against every CANDIDATE generation while deciding which
    // one is usable, and a publish from inside that trial would commit a generation built from bytes
    // that had not been accepted yet. `open()` flushes once, after it has chosen.
  }

  // --- persistence (MEMFS ↔ real disk snapshot) ------------------------------------------------

  /** Force a snapshot now (serialized with ops): checkpoint the WAL, then mirror the MEMFS db files
   *  to disk. */
  async flush(): Promise<void> {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer)
      this.snapshotTimer = undefined
    }
    // ⚠️ The old guard asked whether `realDir/graph` existed. Under generations the db file lives one
    // level down, so that test would answer "no snapshot" forever and every flush would republish.
    if (!this.dirty && GraphSnapshot.exists(this.realDir)) return
    await this.serialize(() => this.persist())
  }

  private async persist(): Promise<void> {
    if (this.dead) return
    try {
      await this.q(`CHECKPOINT`)
    } catch (error) {
      /**
       * 🔴 A FAILED CHECKPOINT NOW STOPS THE PUBLISH. It used to be swallowed as "nothing to
       * checkpoint / transient", which meant a generation could be staged out of a file set whose
       * consistency had never been established.
       *
       * ⚠️ Measured on this engine 2026-08-25: `CHECKPOINT` succeeds on a fresh database and succeeds
       * again immediately afterwards with nothing to merge. So a throw here is NOT routine, and the
       * swallowing comment described a case that does not arise. `dirty` stays set and the prior
       * generation stays live, so the next debounced attempt retries against the same memory state.
       */
      this.lastCheckpointError = (error as Error).message
      /**
       * 🔴 A FATAL fault is not a failed statement — the module is gone, and retrying is what WEDGED
       * this store for ~30 minutes at 0.1% CPU with nothing in the log after the abort. Mark it dead
       * so `touch()` stops re-arming the debounce and every later call fails LOUD instead of hanging.
       */
      if (EngineFault.isFatal(error)) {
        this.dead = EngineFault.deadMessage(this.lastCheckpointError)
        if (this.snapshotTimer) {
          clearTimeout(this.snapshotTimer)
          this.snapshotTimer = undefined
        }
        this.dirty = false // nothing can ever flush it now; leaving it set only re-arms the retry
        console.error(this.dead)
        return
      }
      console.warn(`kb-memory: checkpoint failed, keeping the prior snapshot generation: ${this.lastCheckpointError}`)
      return
    }
    this.lastCheckpointError = undefined
    const FS = this.lbug.getFS()
    const files = new Map<string, Uint8Array>()
    for (const f of (FS.readdir(this.memfsDir) as string[]).filter((n) => n !== "." && n !== ".."))
      files.set(f, FS.readFile(`${this.memfsDir}/${f}`) as Uint8Array)
    GraphSnapshot.publish(this.realDir, files)
    this.dirty = false
  }

  /** After a mutation: mark dirty and (re)arm a debounced snapshot so bursts coalesce into one write. */
  private touch(): void {
    this.dirty = true
    if (this.closed || this.dead) return // re-arming against a dead module is the wedge itself
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined
      void this.serialize(() => this.persist()).catch(() => {})
    }, SNAPSHOT_DEBOUNCE_MS)
    this.snapshotTimer.unref?.()
  }

  // --- ops (Cypher identical to the native store; the surface never changes across engines) -----

  addMemory(input: MemoryInput): Promise<void> {
    if (input.embedding && input.embedding.length !== this.dim)
      return Promise.reject(new Error(`embedding length ${input.embedding.length} != store dim ${this.dim}`))
    return this.serialize(() => this._addMemory(input))
  }

  /**
   * ⚠️ **UNSERIALIZED — every public op must wrap this in `serialize`, and a composite op must call
   * THIS one rather than the public `addMemory`.**
   *
   * The lock is a promise chain: `serialize` queues behind whatever is already running, including
   * itself. So a claim write — which is several node and edge writes that must be atomic against the
   * debounced snapshot — cannot reach the public methods without waiting forever on the lock it is
   * already holding. Splitting the body out is what lets one lock cover the whole transaction.
   */
  private async _addMemory(input: MemoryInput): Promise<void> {
    {
      const validFrom = input.validFrom ? `timestamp($validFrom)` : `current_timestamp()`
      const embedding = input.embedding ? `, embedding: ${vectorLiteral(input.embedding)}` : ``
      await this.q(
        `CREATE (:Memory {
           id: $id, kind: $kind, text: $text, name: $name, scope: $scope,
           source: $source, agent: $agent, confidence: $confidence, relation: $relation,
           status: $status, subject: $subject, predicate: $predicate, conflict_key: $conflictKey,
           evidence: $evidence, evidence_kind: $evidenceKind,
           t_valid: ${validFrom}, t_created: current_timestamp()${embedding} })`,
        {
          id: input.id,
          kind: input.kind,
          text: input.text,
          name: input.name ?? null,
          scope: input.scope,
          source: input.source ?? null,
          agent: input.agent ?? null,
          confidence: input.confidence ?? null,
          relation: input.relation ?? "staged",
          // Every row carries a status, including the ones with no lifecycle. A nullable column would
          // make "no status" and "active" two spellings of one state, and the search filter would then
          // need to know about both forever.
          status: input.status ?? "active",
          subject: input.subject ?? null,
          predicate: input.predicate ?? null,
          conflictKey: input.conflictKey ?? null,
          evidence: input.evidence ?? null,
          evidenceKind: input.evidenceKind ?? null,
          ...(input.validFrom ? { validFrom: input.validFrom } : {}),
        },
      )
      this.touch()
    }
  }

  /**
   * 🔴 THE EDGE TAKES THE NARROWEST ENDPOINT, and the caller's `scope` is ADVISORY.
   *
   * This is the bridge NC-SEC-016 crossed. The model-facing `relate` wrote every edge as `global`, so
   * joining a shared memory to a private one made the private one reachable from every chat — and
   * `neighbors` then handed over its text. An ordinary relation must never PROMOTE visibility;
   * consolidation is the one deliberate promotion and it says so in its own name.
   *
   * Deriving it HERE rather than trusting `input.scope` is the point. A rule enforced at the call site
   * is a rule every future call site must remember, and the one that forgets is exactly how this
   * started. `input.scope` is still accepted so existing writers read naturally, but the stored value
   * is computed from the endpoints.
   *
   * ⚠️ Two DIFFERENT private scopes are REFUSED, not narrowed. No scope contains both, so any edge
   * between them widens one of them. `ok: false` comes back rather than a silent no-op — a relation
   * that quietly did not happen is how a model learns to believe a graph that is not there.
   *
   * ⚠️ **The narrower endpoint is COMPUTED AND RETURNED, never stored.** Returning it puts the
   * value where a caller, a user-facing message and a test can all check it, which is the only form
   * in which a rule stays honest — an edge column holding the same thing was unreadable and already
   * stale. See `ensureSchema`.
   */
  addEdge(input: EdgeInput & { readonly scopes?: readonly string[] }): Promise<{ ok: boolean; scope?: string }> {
    return this.serialize(() => this._addEdge(input))
  }

  /** ⚠️ UNSERIALIZED — see `_addMemory`. */
  private async _addEdge(
    input: EdgeInput & { readonly scopes?: readonly string[] },
  ): Promise<{ ok: boolean; scope?: string }> {
    {
      const access = input.scopes ? `AND a.scope IN $scopes AND b.scope IN $scopes` : ``
      const rows = await this.rows(
        `MATCH (a:Memory {id: $from}), (b:Memory {id: $to})
         WHERE (a.scope = b.scope OR a.scope = 'global' OR b.scope = 'global') ${access}
         CREATE (a)-[:Rel { type: $type,
                            source: $source, confidence: $confidence,
                            t_valid: current_timestamp(), t_created: current_timestamp() }]->(b)
         RETURN CASE WHEN a.scope = 'global' THEN b.scope ELSE a.scope END AS scope`,
        {
          from: input.from,
          to: input.to,
          type: input.type,
          source: input.source ?? null,
          confidence: input.confidence ?? null,
          ...(input.scopes ? { scopes: input.scopes } : {}),
        },
      )
      this.touch()
      const scope = rows[0]?.scope
      return scope === undefined || scope === null ? { ok: false } : { ok: true, scope: String(scope) }
    }
  }

  // --- the claim lifecycle ----------------------------------------------------------------------

  /**
   * WRITE A GOVERNED CLAIM — the whole transaction, under one lock.
   *
   * `Entity <-subject- Claim -supported_by-> Source`, plus `Claim -supersedes-> Claim` when a
   * correction fires. All of it happens inside a single `serialize`, because a claim that landed
   * without its subject edge, or a supersession that marked the old claim before the new one existed,
   * is a graph state no reader can make sense of and the debounced snapshot could publish either.
   *
   * 🔴 **Supersession keys ONLY on the validated conflict key**, never on how the sentences read.
   * `KbClaim.conflictKey` returns one for a `single`-cardinality predicate and `undefined` for
   * everything else, so "works at Acme" retires "works at Initech" and "knows Rust" retires nothing.
   * When no key exists the new claim is simply stored, and the two statements coexist for a person to
   * reconcile — which is the honest outcome, not a degraded one.
   *
   * 🔴 **The write is ACCESS-CHECKED, and this is not decoration.** Without it, a chat could hand
   * `scope: "session:alice"` to its own `remember` and have supersession retire Alice's current
   * answer — mutating another chat's private claim without ever naming its id. Reads were already
   * guarded; this closes the write door the lifecycle opened.
   */
  addClaim(input: ClaimInput): Promise<ClaimResult> {
    if (input.embedding && input.embedding.length !== this.dim)
      return Promise.reject(new Error(`embedding length ${input.embedding.length} != store dim ${this.dim}`))
    return this.serialize(async () => {
      const scope = input.scope.trim()
      const statement = input.statement.trim()
      if (scope === "" || statement === "") return { ok: false, reason: "empty" as const, superseded: [] }
      if (input.scopes && !input.scopes.includes(scope))
        return { ok: false, reason: "refused-scope" as const, superseded: [] }

      const identity = KbClaim.proposeIdentity({ scope, subject: input.subject, predicate: input.predicate })
      const key = identity === undefined ? undefined : KbClaim.conflictKey(identity)
      const subject = input.subject?.trim()

      // The id is content-addressed over identity + statement, so a genuine restatement dedupes. A
      // RE-assertion of something already retired is different: reviving the old row in place would
      // rewrite history, so it gets a fresh id and supersedes whatever is current now.
      let id = KbClaim.claimID(identity, scope, statement)
      const existing = await this.rows(`MATCH (m:Memory {id: $id}) RETURN m.status AS status`, { id })
      const priorStatus = existing[0]?.status as KbClaim.ClaimStatus | undefined
      if (priorStatus !== undefined && !KbClaim.isRetired(priorStatus))
        return { ok: true, id, status: priorStatus, deduped: true, identified: key !== undefined, superseded: [] }
      if (priorStatus !== undefined) {
        // ⚠️ BOUNDED. An open `for (;;)` doing a database read per turn is a hang wearing a loop's
        // clothes, and this file already carries two query shapes that hang the engine outright. The
        // bound is far past any real history — nobody asserts, retires and re-asserts one sentence
        // five hundred times — so reaching it means something is wrong, and saying so beats spinning.
        let minted: string | undefined
        for (let n = 2; n <= MAX_CLAIM_CHAIN * 8; n++) {
          const candidate = `${id}_r${n}`
          const taken = await this.rows(`MATCH (m:Memory {id: $id}) RETURN m.id AS id`, { id: candidate })
          if (taken.length === 0) {
            minted = candidate
            break
          }
        }
        if (minted === undefined) return { ok: false, reason: "too-many-revisions" as const, superseded: [] }
        id = minted
      }

      // WHAT THIS CORRECTION REPLACES, decided before anything is written. Scoped twice over: the key
      // already hashes the scope, and the query filters on it again — a hash is a compression, and the
      // cabinet boundary is not something to leave resting on 96 bits of one.
      const priors =
        key === undefined
          ? []
          : (
              await this.rows(
                `MATCH (m:Memory)
                 WHERE m.conflict_key = $key AND m.scope = $scope AND m.t_invalid IS NULL
                   AND m.status IN $live
                 RETURN m.id AS id LIMIT 100`,
                { key, scope, live: ["active", "needs_review"] },
              )
            )
              .map((row) => String(row.id))
              .filter((prior) => prior !== id)

      await this._addMemory({
        id,
        kind: "claim",
        text: statement,
        ...(subject === undefined || subject === "" ? {} : { name: subject }),
        scope,
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        relation: input.relation ?? "staged",
        status: "active",
        // The PROPOSAL is stored even when it failed validation: it is what somebody said this claim
        // was about, and a reader deserves to see it. Only `conflict_key` is gated on validation,
        // because only the key carries authority to retire another claim.
        ...(subject === undefined || subject === "" ? {} : { subject }),
        ...(input.predicate === undefined ? {} : { predicate: input.predicate }),
        ...(key === undefined ? {} : { conflictKey: key }),
        ...(input.embedding === undefined ? {} : { embedding: input.embedding }),
        ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
      })

      // The SUBJECT edge, onto the shared entity node. `KbChunk.entityID` is the same formula
      // conversational extraction and document ingestion use, so a claim about "TypeScript" lands on
      // the node the rest of the graph already calls TypeScript instead of minting a private twin.
      if (subject !== undefined && subject !== "") {
        const entity = KbChunk.entityID(scope, subject)
        await this._addMemory({ id: entity, kind: "entity", text: subject, name: subject, scope, status: "active" })
        await this._addEdge({
          from: id,
          to: entity,
          type: KbClaim.SUBJECT_EDGE,
          scope,
          source: input.source ?? "claim",
        })
      }

      // EVIDENCE IS NOT THE CLAIM. A source is its own node with its own locator, shared by every
      // claim that cites it, so one moved file flags every claim that rested on it — and so a
      // citation never competes with the fact it supports at retrieval.
      for (const item of input.evidence ?? []) {
        const locator = item.locator.trim()
        if (locator === "") continue
        const sourceNode = KbClaim.sourceID(scope, item.kind, locator)
        await this._addMemory({
          id: sourceNode,
          kind: "source",
          text: KbClaim.describeEvidence(item, new Date()),
          name: locator,
          scope,
          source: input.source ?? "claim",
          status: "active",
          evidence: locator,
          evidenceKind: item.kind,
        })
        await this._addEdge({
          from: id,
          to: sourceNode,
          type: KbClaim.SUPPORTED_BY_EDGE,
          scope,
          source: input.source ?? "claim",
        })
      }

      // Retire the priors LAST, so there is never a window in which the old answer is marked replaced
      // and the replacement does not exist yet.
      for (const prior of priors) {
        await this.q(
          `MATCH (m:Memory {id: $prior}) SET m.status = 'superseded', m.superseded_by = $id,
             m.t_expired = current_timestamp()`,
          { prior, id },
        )
        await this._addEdge({ from: id, to: prior, type: KbClaim.SUPERSEDES_EDGE, scope, source: "supersede" })
      }
      this.touch()
      return { ok: true, id, status: "active" as const, identified: key !== undefined, superseded: priors }
    })
  }

  /**
   * THE TIMELINE AND THE EXPLANATION — what this claim is now, and every claim it replaced.
   *
   * ⚠️ Access-checked on EVERY row, not only the one asked for. The chain is the disclosure surface
   * the lifecycle adds: knowing one id and walking `superseded_by` would otherwise read out a whole
   * history the caller was never entitled to. Rows the caller may not see are dropped, and an
   * inaccessible head returns `null` — indistinguishable from a claim that does not exist, which is
   * the same rule `path` follows and for the same reason.
   */
  claimHistory(id: string, opts: { scopes?: readonly string[] } = {}): Promise<ClaimHistory | null> {
    return this.serialize(async () => {
      const admits = (scope: string) => opts.scopes === undefined || opts.scopes.includes(scope)
      const load = async (target: string): Promise<MemoryRow | undefined> => {
        const rows = await this.rows(`MATCH (m:Memory {id: $id}) RETURN ${ROW_PROJECTION}`, { id: target })
        const row = rows[0]
        if (!row) return undefined
        const built = toRow(row)
        return admits(built.scope) ? built : undefined
      }
      const head = await load(id)
      if (head === undefined) return null

      // FORWARD to the answer that is current now, so "you asked about a retired claim" can say what
      // replaced it. Bounded: a corrupted chain must not spin.
      let current = head
      for (let hop = 0; hop < MAX_CLAIM_CHAIN && current.supersededBy !== null; hop++) {
        const next = await load(current.supersededBy)
        if (next === undefined) break
        current = next
      }

      // BACKWARD through what this claim replaced. `supersedes` edges, one hop at a time — a variable
      // -length traversal would need the shapes this engine hangs on.
      const timeline: MemoryRow[] = [head]
      const seen = new Set([head.id])
      const frontier = [head.id]
      while (frontier.length > 0 && timeline.length < MAX_CLAIM_CHAIN) {
        const from = frontier.shift()!
        const rows = await this.rows(
          `MATCH (a:Memory {id: $from})-[r:Rel {type: '${KbClaim.SUPERSEDES_EDGE}'}]->(b:Memory)
           RETURN b.id AS id LIMIT 50`,
          { from },
        )
        for (const row of rows) {
          const prior = String(row.id)
          if (seen.has(prior)) continue
          seen.add(prior)
          const loaded = await load(prior)
          if (loaded === undefined) continue
          timeline.push(loaded)
          frontier.push(prior)
        }
      }

      /**
       * THE SOURCES ARE PICKED BY TRAVERSAL AND READ BY KEY — the same rule as `neighbors` and
       * `list`, which this pass used to be the exception to.
       *
       * 🔴 It projected `b.text` (and the locator and kind beside it) straight out of the
       * relationship traversal and used it as the label. That is a non-key read, and on this engine
       * a non-key read can hand back an empty string for an intact row — see `hydrate`, where the
       * measurement is. The surface it feeds is the claim timeline, whose entire job is *"why is
       * this claim here"*, so the failure rendered blank source labels with no way for a reader to
       * tell a source that has no description from one the engine failed to project.
       *
       * ⚠️ **One deduped hydration for the whole chain, not one per entry.** A source is its own
       * node shared by every claim that cites it (see `addClaim`), so a 64-hop chain cites far fewer
       * than 64 × 25 distinct sources — and hydrating per entry would have paid ~4 ms a row for the
       * same body over and over, inside the single engine lock.
       */
      const cited: { claimID: string; sourceID: string }[] = []
      for (const entry of timeline) {
        const rows = await this.rows(
          `MATCH (a:Memory {id: $from})-[r:Rel {type: '${KbClaim.SUPPORTED_BY_EDGE}'}]->(b:Memory)
           WHERE b.t_invalid IS NULL
           RETURN b.id AS id LIMIT 25`,
          { from: entry.id },
        )
        for (const row of rows) cited.push({ claimID: entry.id, sourceID: String(row.id) })
      }
      const sources = new Map(
        (await this.hydrate([...new Set(cited.map((c) => c.sourceID))])).map((row) => [row.id, row]),
      )
      const evidence: EvidenceRow[] = []
      for (const { claimID, sourceID } of cited) {
        const body = sources.get(sourceID)
        // Skipped rather than faked, exactly as `hydrate` does: the caller asked what is there now.
        if (body === undefined) continue
        evidence.push({
          claimID,
          id: body.id,
          locator: body.evidence ?? "",
          kind: body.evidenceKind ?? "chat",
          label: body.text,
        })
      }
      return { claim: head, current: current.id === head.id ? null : current, timeline, evidence }
    })
  }

  /**
   * THE EVIDENCE MOVED — flag every claim that rested on it, deterministically.
   *
   * 🔴 This is what replaces guessing from prose. The retired approach read a failed file access and
   * invalidated any recalled memory whose TEXT mentioned that path, which both over-fires (a sentence
   * that merely names the file) and under-fires (a claim that came from the file but never quotes its
   * path). Here the link is a stored edge to a source node whose locator IS the thing that moved, so
   * the set of affected claims is a traversal rather than a judgement.
   *
   * ⚠️ It marks `needs_review`, never `superseded` or invalid. A file being renamed is not evidence
   * that the fact is false; it is evidence that the CITATION is stale, and destroying a true claim
   * because its footnote moved is a worse error than carrying a flagged one.
   */
  reviewEvidence(locator: string, opts: { scopes?: readonly string[] } = {}): Promise<number> {
    return this.serialize(async () => {
      const target = locator.trim()
      if (target === "") return 0
      const sources = await this.rows(
        `MATCH (m:Memory) WHERE m.kind = 'source' AND m.evidence = $locator RETURN m.id AS id LIMIT 200`,
        { locator: target },
      )
      let flagged = 0
      for (const row of sources) {
        const scopeFilter = opts.scopes ? `AND c.scope IN $scopes` : ``
        const claims = await this.rows(
          `MATCH (c:Memory)-[r:Rel {type: '${KbClaim.SUPPORTED_BY_EDGE}'}]->(s:Memory {id: $source})
           WHERE c.status = 'active' AND c.t_invalid IS NULL ${scopeFilter}
           RETURN c.id AS id LIMIT 500`,
          { source: String(row.id), ...(opts.scopes ? { scopes: opts.scopes } : {}) },
        )
        for (const claim of claims) {
          await this.q(`MATCH (m:Memory {id: $id}) SET m.status = 'needs_review'`, { id: String(claim.id) })
          flagged++
        }
      }
      if (flagged > 0) this.touch()
      return flagged
    })
  }

  /**
   * Move a claim between the statuses a PERSON controls — `archived` (retire it, reversibly) and
   * `active` (restore it).
   *
   * ⚠️ `superseded` is deliberately not settable here. That status exists only as the other half of a
   * `superseded_by` pointer and a `supersedes` edge, and a status set without them is a claim that
   * claims it was replaced by nothing. Corrections go through `addClaim`; this is the Archive/Restore
   * pair and nothing else.
   *
   * 🔴 **…AND A SUPERSEDED CLAIM CANNOT BE MOVED OUT OF IT EITHER — the other direction of the same
   * rule, which was missing.** Refusing to SET `superseded` while allowing a superseded row to be set
   * back to `active` is one rule with one door: the retired claim's `superseded_by` pointer and its
   * `supersedes` edge both survive, so the store ends up with TWO active answers to one question, one
   * of them still saying it was replaced. Measured 2026-08-26 against this engine the moment
   * `POST /api/memory/claim/status` first made the operation reachable from outside a model turn:
   * `setClaimStatus(<a superseded claim>, "active")` answered `true` and recall then returned both
   * the retired answer and the one that replaced it.
   *
   * The way back from a correction is to record a NEW claim, which retires the current one under the
   * same lock. That keeps "which claim answers this question now" a property of the lifecycle rather
   * than something two surfaces can disagree about.
   */
  setClaimStatus(
    id: string,
    status: "active" | "archived" | "needs_review",
    opts: { scopes?: readonly string[] } = {},
  ): Promise<boolean> {
    return this.serialize(async () => {
      const scopeFilter = opts.scopes ? `AND m.scope IN $scopes` : ``
      const rows = await this.rows(
        `MATCH (m:Memory {id: $id}) WHERE m.kind = 'claim' AND m.status <> 'superseded' ${scopeFilter}
         SET m.status = $status RETURN m.id AS id`,
        { id, status, ...(opts.scopes ? { scopes: opts.scopes } : {}) },
      )
      if (rows.length === 0) return false
      this.touch()
      return true
    })
  }

  /** Hybrid retrieval: vector KNN (if `embedding`) + FTS (if `query`), RRF-fused, scope/validity filtered. */
  search(input: SearchInput): Promise<SearchHit[]> {
    return this.serialize(async () => this._search(input))
  }

  private async _search(input: SearchInput): Promise<SearchHit[]> {
    const k = input.k ?? 10
    const pool = Math.max(k * 4, 20)
    const ranks = new Map<string, number>()
    const fuse = (ids: string[], weight = 1) =>
      ids.forEach((id, i) => ranks.set(id, (ranks.get(id) ?? 0) + weight / (RRF_K + i + 1)))

    /**
     * THE EXACT LEG — "exact identifiers stay reachable when semantic similarity is weak".
     *
     * 🔴 Both fuzzy legs are bad at exactly this and in opposite ways: a vector index has no useful
     * neighbourhood for `clm_9f2a…` or `packages/core/src/tool/kb.ts`, and FTS tokenizes a path into
     * common words that match half the store. So an identifier-shaped token in the query is looked up
     * by EQUALITY — by primary key when it is one of our ids, and against `name`/`evidence` otherwise.
     *
     * ⚠️ **Its WEIGHT is what makes it win, not the order it runs in.** RRF is a sum, so fusing this
     * leg "first" contributes nothing on its own; `EXACT_RANK_WEIGHT` holds the arithmetic.
     *
     * ⚠️ No `WHERE m.id IN $ids` and no `WITH … ORDER BY` — both HANG this engine. Ids go through
     * single-key lookups and the rest through one equality scan projecting no long string.
     */
    for (const token of KbClaim.identifierTokens(input.query ?? "")) {
      const byKey = await this.rows(`MATCH (m:Memory {id: $id}) RETURN m.id AS id`, { id: token })
      if (byKey.length > 0) {
        fuse(
          byKey.map((row) => String(row.id)),
          EXACT_RANK_WEIGHT,
        )
        continue
      }
      const byLabel = await this.rows(
        `MATCH (m:Memory) WHERE m.name = $token OR m.evidence = $token RETURN m.id AS id LIMIT ${pool}`,
        { token },
      )
      fuse(
        byLabel.map((row) => String(row.id)),
        EXACT_RANK_WEIGHT,
      )
    }

    if (input.embedding) {
      if (input.embedding.length !== this.dim)
        throw new Error(`query embedding length ${input.embedding.length} != store dim ${this.dim}`)
      const hits = await this.rows(
        `CALL QUERY_VECTOR_INDEX('Memory', 'mem_vec', ${vectorLiteral(input.embedding)}, ${pool})
         RETURN node.id AS id ORDER BY distance`,
      )
      fuse(hits.map((h) => String(h.id)))
    }
    if (input.query && input.query.trim()) {
      const hits = await this.rows(
        `CALL QUERY_FTS_INDEX('Memory', 'mem_fts', $query) RETURN node.id AS id ORDER BY score DESC LIMIT ${pool}`,
        { query: input.query },
      )
      fuse(hits.map((h) => String(h.id)))
    }
    if (ranks.size === 0) return []

    const ordered = [...ranks.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
    const scopeFilter = input.scopes ? `AND m.scope IN $scopes` : ``
    const kindFilter = input.kinds ? `AND m.kind IN $kinds` : ``
    // 🔴 CURRENT TRUTH ONLY, unless the caller says otherwise out loud. A superseded claim is still in
    // the graph, still a neighbour, still in `list` and still in the visualizer — it is excluded HERE,
    // at retrieval, which is the one place where competing with the current answer does damage.
    const statuses = input.statuses ?? KbClaim.RECALL_STATUSES
    // The filter pass carries NO long string: the ranked ids are checked for validity, scope and kind
    // here, and the bodies come back by primary key below (`hydrate` holds the why). Keeping `text`
    // in this projection is what made every hit render blank.
    const allowed = await this.rows(
      `MATCH (m:Memory) WHERE m.id IN $ids AND m.t_invalid IS NULL AND m.status IN $statuses
       ${scopeFilter} ${kindFilter}
       RETURN m.id AS id, m.t_valid AS validAt, m.kind AS kind`,
      {
        ids: ordered,
        statuses,
        ...(input.scopes ? { scopes: input.scopes } : {}),
        ...(input.kinds ? { kinds: input.kinds } : {}),
      },
    )
    const validAtOf = new Map(allowed.map((row) => [String(row.id), row.validAt]))
    const kindOf = new Map(allowed.map((row) => [String(row.id), String(row.kind ?? "")]))
    // Only as many as the caller asked for — hydration costs one lookup per row, so the `k` cut moves
    // ahead of it rather than after it.
    const eligible = ordered.filter((id) => validAtOf.has(id))
    /**
     * 🔴 **RAW PASSAGES MAY NOT TAKE THE WHOLE ANSWER.**
     *
     * "Raw passages are source material, not hundreds of equal-weight top-level memories" — and the
     * measurement behind that sentence is that ONE ingested document is hundreds of rows, every one a
     * plausible lexical match for anything it discusses. Measured here on the shipping engine: 20
     * handbook passages echoing a claim's own words took every slot of a `k = 10` recall and the claim
     * did not appear at all.
     *
     * ⚠️ **A ranking weight cannot fix that, and believing it could is the trap.** Re-ranking chooses
     * among what retrieval RETURNED; a fact crowded out of the candidate pool is not slow to appear,
     * it is absent. So the demotion has to happen here, at selection, and the ranker's `kindPassage`
     * only orders what survives.
     *
     * ⚠️ It is a CAP, not an exclusion, and the deferred passages are backfilled. A question whose
     * only answers are passages — "ingest this manual, then search it", the shipped promise — still
     * gets a full page of them, because the cap releases when nothing else is competing.
     */
    const passageCap = Math.max(1, Math.ceil(k / 2))
    const wanted: string[] = []
    const deferred: string[] = []
    let passagesTaken = 0
    for (const id of eligible) {
      if (wanted.length >= k) break
      if (kindOf.get(id) === "passage" && passagesTaken >= passageCap) {
        deferred.push(id)
        continue
      }
      if (kindOf.get(id) === "passage") passagesTaken++
      wanted.push(id)
    }
    for (const id of deferred) {
      if (wanted.length >= k) break
      wanted.push(id)
    }
    const props = await this.hydrate(wanted)
    const byId = new Map(props.map((p) => [String(p.id), p]))
    const hits: SearchHit[] = []
    for (const id of ordered) {
      const p = byId.get(id)
      if (!p) continue
      hits.push({
        // `hydrate` already produced a complete row through `toRow`; re-listing the columns here is
        // how a field added to the store arrives everywhere except search results.
        ...p,
        score: ranks.get(id)!,
        // VALID time (when the fact became true — e.g. the date of the statement), not ingestion time:
        // the recency signal a ranker should weigh. Optional — an engine row predating this projection
        // simply has none, and the ranker treats a missing time as neutral.
        ...(isoTime(validAtOf.get(id)) === undefined ? {} : { validAt: isoTime(validAtOf.get(id))! }),
      })
      if (hits.length >= k) break
    }
    return hits
  }

  /**
   * ⚠️ **The SOURCE node is checked too, not only the targets.** The old query filtered `n.scope` and
   * never looked at `m` — so knowing a private id let a caller enumerate whatever it pointed at, and
   * the filter it did apply was skipped entirely when the caller passed no scopes.
   */
  neighbors(
    id: string,
    opts: { scopes?: readonly string[]; k?: number } = {},
  ): Promise<{ id: string; type: string; text: string }[]> {
    return this.serialize(async () => {
      const scopeFilter = opts.scopes ? `AND n.scope IN $scopes AND m.scope IN $scopes` : ``
      const rows = await this.rows(
        // 🔴 UNDIRECTED. This matched `->` only, and the claim lifecycle points `subject` edges
        // claim→entity — so an entity, the thing a question is ABOUT and therefore the thing a
        // traversal starts from, was a pure SINK and this returned nothing on any real store.
        // Measured on the board-game corpus: the graph is worth 45% vs 10% for passages alone, and
        // the outgoing-only walk reached the gold answer 0/40. The whole benefit was unreachable
        // through this accessor. Direction is a storage detail; `r.type` still carries the relation.
        `MATCH (m:Memory {id: $id})-[r:Rel]-(n:Memory)
         WHERE r.t_invalid IS NULL AND n.t_invalid IS NULL ${scopeFilter}
         RETURN n.id AS id, r.type AS type LIMIT ${opts.k ?? 25}`,
        { id, ...(opts.scopes ? { scopes: opts.scopes } : {}) },
      )
      // Same rule as `list`: the traversal picks the neighbours, the bodies come back by key.
      const bodies = new Map((await this.hydrate(rows.map((r) => String(r.id)))).map((row) => [row.id, row.text]))
      return rows.map((r) => ({ id: String(r.id), type: String(r.type), text: bodies.get(String(r.id)) ?? "" }))
    })
  }

  /** Hydrate one current row behind an engine-owned reference, enforcing scope before the body leaves. */
  get(id: string, opts: { scopes?: readonly string[] } = {}): Promise<MemoryRow | null> {
    return this.serialize(async () => {
      const scopeFilter = opts.scopes ? `AND m.scope IN $scopes` : ``
      const rows = await this.rows(
        `MATCH (m:Memory {id: $id}) WHERE m.t_invalid IS NULL ${scopeFilter} RETURN m.id AS id`,
        { id, ...(opts.scopes ? { scopes: opts.scopes } : {}) },
      )
      if (rows.length === 0) return null
      return (await this.hydrate([id]))[0] ?? null
    })
  }

  /**
   * ⚠️ EVERY HOP is checked, not the endpoints. A path that merely *passes through* a private memory
   * still discloses that it exists and how it connects, which is most of what the id was protecting.
   * The engine's shortest-path call cannot take a per-hop predicate, so the scopes come back with the
   * nodes and the filter is applied here — a path with any inaccessible hop is `null`, exactly like a
   * path that does not exist. A caller must not be able to tell those two apart.
   */
  path(
    from: string,
    to: string,
    maxHops = 5,
    opts: { scopes?: readonly string[] } = {},
  ): Promise<{ ids: string[]; hops: number } | null> {
    return this.serialize(async () => {
      const rows = await this.rows(
        `MATCH p = (a:Memory {id: $from})-[:Rel* SHORTEST 1..${Math.max(1, maxHops | 0)}]->(b:Memory {id: $to})
         RETURN length(p) AS hops, nodes(p) AS ns`,
        { from, to },
      )
      const r = rows[0]
      if (!r) return null
      const ns = (r.ns as Array<{ id?: unknown; scope?: unknown }>) ?? []
      if (opts.scopes) {
        const allowed = new Set(opts.scopes)
        if (!ns.every((n) => allowed.has(String(n?.scope)))) return null
      }
      return { hops: Number(r.hops), ids: ns.map((n) => String(n?.id)) }
    })
  }

  /**
   * ⚠️ A restricted caller can only invalidate what it can SEE. Mutating by id alone is how one chat
   * came to forget another chat's memory — and the silent version of that is worse than an error,
   * because it looks like spontaneous forgetting.
   */
  invalidate(id: string, at?: string, opts: { scopes?: readonly string[] } = {}): Promise<void> {
    return this.serialize(async () => {
      const scopeFilter = opts.scopes ? `WHERE m.scope IN $scopes` : ``
      const params = { id, ...(opts.scopes ? { scopes: opts.scopes } : {}) }
      await this.requireErasable("forget", id, scopeFilter, params, opts.scopes !== undefined)
      const when = at ? `timestamp($at)` : `current_timestamp()`
      await this.q(`MATCH (m:Memory {id: $id}) ${scopeFilter} SET m.t_invalid = ${when}`, {
        ...params,
        ...(at ? { at } : {}),
      })
      this.touch()
    })
  }

  /** ⚠️ Same rule as `invalidate`, and it matters more: this one destroys the history too. */
  purge(id: string, opts: { scopes?: readonly string[] } = {}): Promise<void> {
    return this.serialize(async () => {
      const scopeFilter = opts.scopes ? `WHERE m.scope IN $scopes` : ``
      const params = { id, ...(opts.scopes ? { scopes: opts.scopes } : {}) }
      await this.requireErasable("purge", id, scopeFilter, params, opts.scopes !== undefined)
      await this.q(`MATCH (m:Memory {id: $id}) ${scopeFilter} DETACH DELETE m`, params)
      this.touch()
    })
  }

  /**
   * 🔴 **A REFUSED ERASE MUST SAY SO.** Both erase statements used to run and resolve whether or not
   * their `MATCH` bound anything: a `SET`/`DETACH DELETE` over zero rows is not an error, so a caller
   * asking to erase a memory it may not see was told the erase happened. `MemoryObserved` then
   * published `MemoryEvent.Forgotten` and dropped the access-ledger rows for a memory that is still
   * in the store, and the `kb` tool answered *"Purged … — no history kept."* to a model whose next
   * search can still find the text. That is a failed mutation reporting success, which is the one
   * thing this class of op may never do.
   *
   * ⚠️ **A THROW, not a boolean, and the reason is the plumbing.** Every consumer of this pair —
   * `MemoryClient.fromEngine`'s `Effect.tryPromise`, `MemoryObserved`'s `Effect.tap` chain, the
   * `kb` tool's `Effect.catch`, the HTTP handler's `asBadRequest` — already routes a failure to the
   * user and already SKIPS the success-only side effects. A boolean would have had to be threaded
   * through five signatures for the same outcome, and every site that forgot to read it would be the
   * present bug again. The refusal reaches the model as *"Couldn't forget …"* with no change above.
   *
   * ⚠️ The probe is a PRIMARY-KEY lookup returning one short column. A scan on this engine can hand
   * back an empty `text` for an intact row (see `hydrate`), and an empty result is indistinguishable
   * from a failed query — so the probe reads the id it matched on and nothing else, and a genuine
   * engine fault throws rather than being read as "no such row". It runs inside the SAME `serialize`
   * block as the statement it guards, so nothing can slip between the check and the erase.
   */
  private async requireErasable(
    what: "forget" | "purge",
    id: string,
    scopeFilter: string,
    params: Record<string, unknown>,
    scoped: boolean,
  ): Promise<void> {
    const seen = await this.rows(`MATCH (m:Memory {id: $id}) ${scopeFilter} RETURN m.id AS id`, params)
    if (seen.length > 0) return
    throw new Error(
      `kb-memory: refused to ${what} "${id}" — nothing was erased. ` +
        (scoped
          ? `No memory with that id is one this caller can see.`
          : `No memory with that id is in the store.`),
    )
  }

  /**
   * Move every memory from one scope to another, keeping ids, embeddings and edges.
   *
   * 🔴 What a RETIREMENT does to a colleague's cabinet (`agent/retire.ts`). Deleting it satisfied the
   * anti-bleed rule — a retired id returns to the name pool, so `agent:<id>` must not still hold the
   * old holder's memories — but it made a retirement UNRECOVERABLE, and Nova may retire on its own
   * judgement. A model with a delete key and no undo is the thing that breaks in your hands.
   *
   * Moving satisfies the same rule for free: `agent:<id>` ends up empty either way, and the bytes are
   * still there under a scope nothing recalls from (`recallScopes` reads session, agent and global —
   * never `retired:`). One `SET`, so ids, vectors and relationships survive; a read-and-rewrite would
   * have minted new ids and dropped the graph edges between them.
   */
  moveScope(from: string, to: string): Promise<void> {
    return this.serialize(async () => {
      await this.q(`MATCH (m:Memory) WHERE m.scope = $from SET m.scope = $to`, { from, to })
      this.touch()
    })
  }

  /**
   * Erase EVERY memory, in every scope, for every agent — Nova included.
   *
   * 🔴 Owner, 2026-08-22: *"erases all RAGs from all agents, including Nova — that will simplify
   * running tabula rasa tests, without resetting entire Novaclaw install."* So it is deliberately
   * total: not "the ones you can see", not "everything but the governing agent's". A partial erase
   * would leave a tabula-rasa run standing on someone's leftovers, which is the one thing this exists
   * to prevent.
   *
   * ⚠️ A hard `DETACH DELETE`, like `clearScope`, not the soft `t_invalid` that `forget` uses. An
   * invalidated row still occupies the store and still answers `stats().total`, so "erased" would be
   * a claim the file contradicts.
   */
  eraseAll(): Promise<number> {
    return this.serialize(async () => {
      const before = await this.rows(`MATCH (m:Memory) RETURN count(m) AS n`)
      await this.q(`MATCH (m:Memory) DETACH DELETE m`)
      this.touch()
      return Number(before[0]?.n ?? 0)
    })
  }

  /**
   * Discard the memories a pre-roster NovaClaw left in the household pile.
   *
   * 🔴 Owner, 2026-08-22: *"we do not migrate the memories created by Novaclaw versions pre corporate
   * structure — just discard them."* Before the roster, auto-extraction wrote to `session:<id>` and a
   * consolidation pass promoted those rows into `global`, so one colleague's automatically-learned
   * facts became readable by every other. Extraction now files into `agent:<id>` and consolidate does
   * not touch those, so `global` + `auto-extract` names exactly the legacy set and nothing current.
   *
   * ⚠️ **That last clause was FALSE until 2026-08-25** and it cost a data-loss bug: consolidation
   * copied its source from the original, so every twin it promoted was `global` + `auto-extract` and
   * this pass deleted it at the next boot — after the original had already been invalidated. Twins
   * are `source: 'consolidated'` now, which is what makes the sentence true.
   *
   * ⚠️ Idempotent BY CONSTRUCTION rather than by a marker: after one run the predicate matches
   * nothing, and nothing writes rows that match it again. A "have I run this?" flag would be a second
   * thing to keep true.
   */
  discardLegacyGlobalExtracts(): Promise<number> {
    return this.serialize(async () => {
      const doomed = await this.rows(
        `MATCH (m:Memory) WHERE m.scope = 'global' AND m.source = 'auto-extract' RETURN count(m) AS n`,
      )
      const n = Number(doomed[0]?.n ?? 0)
      if (n === 0) return 0
      await this.q(`MATCH (m:Memory) WHERE m.scope = 'global' AND m.source = 'auto-extract' DETACH DELETE m`)
      this.touch()
      return n
    })
  }

  /**
   * Hard-delete every memory in a scope — and any consolidated twin that scope was the last origin of.
   *
   * 🔴 **A twin outlived the chat it came from.** Consolidation promotes an ownerless auto-extracted
   * fact to a GLOBAL twin, and deleting the chat cleared `session:<id>` while the twin stayed —
   * readable forever, from a conversation the product promised was gone permanently. The twin now
   * carries a `consolidated_from` edge to each original it was promoted from, so this can ask a
   * question it could not before: does anything still support it?
   *
   * ⚠️ **The LAST origin, not the first.** The twin id is a content hash, so the same fact learned in
   * two chats is ONE twin with two origins. Deleting either chat must not remove a fact the other
   * still supports — so the twin goes only when no origin remains. That is why this counts edges
   * rather than deleting the twin alongside its origin.
   *
   * ⚠️ `DETACH DELETE` removes the origin edges with the originals, so the count is already correct by
   * the time the second statement runs — the two must stay in this order.
   */
  clearScope(scope: string): Promise<void> {
    return this.serialize(async () => {
      await this.q(`MATCH (m:Memory) WHERE m.scope = $scope DETACH DELETE m`, { scope })
      await this.q(
        `MATCH (t:Memory)
         WHERE t.scope = 'global' AND t.source = 'consolidated'
           AND NOT EXISTS { MATCH (t)-[:Rel {type: 'consolidated_from'}]->(:Memory) }
         DETACH DELETE t`,
      )
      this.touch()
    })
  }

  stats(): Promise<{ total: number; valid: number }> {
    return this.serialize(async () => {
      const rows = await this.rows(
        `MATCH (m:Memory) RETURN count(m) AS total, count(CASE WHEN m.t_invalid IS NULL THEN 1 END) AS valid`,
      )
      const r = rows[0] ?? {}
      return { total: Number(r.total ?? 0), valid: Number(r.valid ?? 0) }
    })
  }

  /**
   * Fetch full rows for ids the caller already selected — BY PRIMARY KEY, one at a time.
   *
   * 🔴 **A table scan on this engine can return an empty string for `text` while the row is intact.**
   * Measured on the owner's store 2026-08-21: a scan found text on 64 of 745 rows, and **40 of 40**
   * rows it reported as empty came back complete through `MATCH (m:Memory {id: $id})`. New writes
   * enter that state about a second after they are stored (the snapshot debounce); a from-scratch
   * store does not reproduce it at 100 rows × 20 KB. Ids, kinds and scopes survive scans — only the
   * long string comes back blank — so the selection can stay a scan and only the bodies move.
   *
   * ⚠️ Per id, deliberately. `WHERE m.id IN $ids` HANGS on that store, pinning gigabytes before it is
   * killed, and so does `WITH m ORDER BY … RETURN …`. A page of single-key lookups is the shape that
   * works.
   *
   * A row that has vanished between the scan and the hydration is skipped rather than faked: the
   * caller asked what is there now.
   *
   * **Cost, measured on that store (745 rows):** a 25-row page 319 ms, 100 rows 478 ms, a full
   * 200-row page 756 ms — ~4 ms/row amortised, and it replaces one scan that returned nothing worth
   * showing. `search` hydrates only `k` rows (10 by default), so per-turn recall pays ~50 ms.
   */
  private async hydrate(ids: readonly string[]): Promise<MemoryRow[]> {
    const out: MemoryRow[] = []
    for (const id of ids) {
      const rows = await this.rows(`MATCH (m:Memory {id: $id}) RETURN ${ROW_PROJECTION}`, { id })
      const row = rows[0]
      if (row) out.push(toRow(row))
    }
    return out
  }

  /** Enumerate memories (for the viewer/editor), newest first, filterable by scope/kind/validity and
   *  paginated. Unlike `search` this needs no query — it's the "show me everything" list. */
  list(opts: ListInput = {}): Promise<MemoryRow[]> {
    return this.serialize(async () => {
      const validity = opts.includeInvalid ? `` : `AND m.t_invalid IS NULL`
      const scopeFilter = opts.scopes ? `AND m.scope IN $scopes` : ``
      const kindFilter = opts.kinds ? `AND m.kind IN $kinds` : ``
      // ⚠️ NO default lens here, unlike `search`. Enumeration answers "what do you remember", and a
      // superseded claim IS remembered — it is the history the Memory app's timeline is made of. The
      // separation the lifecycle needs is at RETRIEVAL, where a retired answer would compete with the
      // current one; hiding it from the list as well would make the correction unexplainable.
      const statusFilter = opts.statuses ? `AND m.status IN $statuses` : ``
      const limit = Math.max(1, Math.min(opts.limit ?? 200, 2000))
      const offset = Math.max(0, opts.offset ?? 0)
      // Select ids with the scan (ordering and pagination unchanged), then hydrate by key — see
      // `hydrate`. The projection here carries no long string, which is the column a scan loses.
      const selected = await this.rows(
        `MATCH (m:Memory) WHERE true ${validity} ${scopeFilter} ${kindFilter} ${statusFilter}
         RETURN m.id AS id
         ORDER BY m.t_created DESC SKIP ${offset} LIMIT ${limit}`,
        {
          ...(opts.scopes ? { scopes: opts.scopes } : {}),
          ...(opts.kinds ? { kinds: opts.kinds } : {}),
          ...(opts.statuses ? { statuses: opts.statuses } : {}),
        },
      )
      return this.hydrate(selected.map((row) => String(row.id)))
    })
  }

  /**
   * A COHERENT graph slice for the visualizer: `limit` nodes chosen for structure and recency, the
   * valid edges among them, and metadata saying what was left out.
   *
   * 🔴 Two defects this replaces, both silent.
   *
   * **The selection was `ORDER BY t_created DESC LIMIT n`.** Ingesting one document writes hundreds
   * of passages in a burst, so the newest `n` rows become that one document and every older entity
   * hub falls off the end — the graph got emptier the more was put into it. `graph-slice.ts` has the
   * reasoning and the budget split; the selection is computed HERE in JS because this engine hangs on
   * `WHERE m.id IN $ids` and on `WITH m ORDER BY … RETURN …`, which is what a query-side selection
   * would need.
   *
   * **The edge query took `LIMIT limit * 4` BEFORE filtering to the selected nodes.** So the cap was
   * spent on edges belonging to memories that were never returned, and edges among the nodes actually
   * on screen were dropped — arbitrarily, and more often the larger the store. The scan is now bounded
   * by its own cap and filtered afterwards, and `EDGE_SCAN_CAP` is a memory bound on this process
   * rather than a guess at how many edges the client wants.
   *
   * ⚠️ The scan reads IDS, never text: a table scan on this engine can return an empty string for
   * `text` while the row is intact (see `hydrate`). Only the chosen ids are hydrated, so the cost is
   * one scan plus `limit` single-key lookups, not a scan of every body in the store.
   */
  graph(opts: GraphInput = {}): Promise<MemoryGraphResult> {
    return this.serialize(async () => {
      const scopeFilter = opts.scopes ? `AND m.scope IN $scopes` : ``
      const params = { ...(opts.scopes ? { scopes: opts.scopes } : {}) }
      const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000))

      // The count is asked SEPARATELY so `total` describes the store rather than the scan — a scan
      // that hit its cap cannot tell you how much it did not read.
      const counted = await this.rows(
        `MATCH (m:Memory) WHERE m.t_invalid IS NULL ${scopeFilter} RETURN count(m) AS n`,
        params,
      )
      const total = Number(counted[0]?.n ?? 0)

      const scanCap = Math.min(Math.max(limit * NODE_SCAN_FACTOR, limit), NODE_SCAN_CAP)
      const scanned = await this.rows(
        `MATCH (m:Memory) WHERE m.t_invalid IS NULL ${scopeFilter}
         RETURN m.id AS id, m.kind AS kind
         ORDER BY m.t_created DESC LIMIT ${scanCap}`,
        params,
      )
      const candidates = scanned.map((row) => ({ id: String(row.id), kind: String(row.kind ?? "entity") }))

      const edgeRows = await this.rows(
        `MATCH (a:Memory)-[r:Rel]->(b:Memory) WHERE r.t_invalid IS NULL
         RETURN a.id AS from, b.id AS to, r.type AS type LIMIT ${EDGE_SCAN_CAP}`,
      )
      const allEdges = edgeRows.map((e) => ({
        from: String(e.from),
        to: String(e.to),
        type: String(e.type ?? ""),
      }))

      const slice = selectSlice(candidates, allEdges, {
        limit,
        total,
        ...(candidates.length >= scanCap && total > candidates.length ? { scanCapped: true } : {}),
      })
      const nodes = await this.hydrate(slice.ids)
      // Hydration is the authority on what exists NOW, so the edge filter keys on the rows that came
      // back rather than on the ids that were asked for — a memory purged between the two is gone.
      const present = new Set(nodes.map((n) => n.id))
      const edges = allEdges.filter((e) => present.has(e.from) && present.has(e.to))
      return { nodes, edges, slice: { ...slice.meta, returned: nodes.length } }
    })
  }

  /**
   * Consolidation (§1.3.4): promote each still-valid SESSION-scope memory to a GLOBAL twin (so
   * auto-extracted facts become cross-session), then supersede the session original bitemporally
   * (invalidate — kept in history, dropped from search). Deduped by a content-hash global id, so the
   * same fact from two sessions collapses to one global memory, and re-running is idempotent
   * (already-invalidated originals are skipped). Returns the number promoted.
   *
   * 🔴 **The twin's `source` is `consolidated`, NOT the original's `auto-extract`, and that one word
   * was a DATA-LOSS bug.** `discardLegacyGlobalExtracts` deletes every `global` + `auto-extract` row
   * at startup, and its comment asserted that predicate "names exactly the legacy set and nothing
   * current". It did not: consolidation copied the original's source, so every twin it made matched.
   * Measured 2026-08-25 against this engine — consolidate, then discard, and the fact is GONE: the
   * twin deleted, and the session original left invalidated on the assumption the twin represented
   * it. An ownerless auto-extracted fact silently vanished at the next restart.
   *
   * ⚠️ The two passes were fighting, and the loss was invisible from either side: consolidation
   * reported a promotion, the discard reported a legacy cleanup, and both were telling the truth
   * about themselves.
   */
  consolidate(): Promise<number> {
    return this.serialize(async () => {
      // Only AUTO-EXTRACTED session memories flow up. A deliberate `remember` scoped "session" is a
      // "this chat only" note the user chose — never force it global.
      //
      // ⚠️ **CLAIMS DO NOT FLOW UP, and that is a decision rather than an omission.** The twin is
      // built by the CREATE below, which copies text, name, kind and confidence — not the conflict
      // key. A claim promoted through here would land in `global` as a claim with NO identity: it
      // could never be corrected, and nothing could correct it, which is a worse state than the
      // session claim it came from. Carrying the key instead is not a free fix either — it would let
      // a claim made in one chat retire the household's current answer, which is a promotion of
      // AUTHORITY and belongs to whoever decides that deliberately. Excluded until then.
      const rows = await this.rows(
        `MATCH (m:Memory)
         WHERE m.t_invalid IS NULL AND starts_with(m.scope, 'session:') AND m.source = 'auto-extract'
           AND m.status = 'active' AND m.kind <> 'claim'
         RETURN ${ROW_PROJECTION}`,
      )
      let promoted = 0
      /** session memory id -> its global twin id, so promoted EDGES can be remapped below. */
      const twinOf = new Map<string, string>()
      for (const row of rows) {
        const text = String(row.text ?? "")
        if (!text) continue
        const gid =
          "mem_g" + createHash("sha256").update(`global\n${text.trim().toLowerCase()}`).digest("hex").slice(0, 24)
        const existing = await this.rows(`MATCH (g:Memory {id: $gid}) WHERE g.t_invalid IS NULL RETURN g.id AS id`, {
          gid,
        })
        if (existing.length === 0) {
          await this.q(
            // ⚠️ `status` is written explicitly, like every other CREATE in this file. The search
            // filter is `m.status IN $statuses` in the ENGINE, so a twin created without one would be
            // NULL there and invisible to recall — the promotion would report success and the fact
            // would be unreachable, which is the exact shape of the consolidation bug above it.
            `CREATE (:Memory {
               id: $id, kind: $kind, text: $text, name: $name, scope: 'global',
               source: 'consolidated', confidence: $confidence, relation: $relation, status: 'active',
               t_valid: current_timestamp(), t_created: current_timestamp() })`,
            {
              id: gid,
              kind: String(row.kind ?? "episode"),
              text,
              name: (row.name as string | null) ?? null,
              confidence: (row.confidence as number | null) ?? null,
              relation: (row.relation as string) ?? "staged",
            },
          )
        }
        twinOf.set(String(row.id), gid)
        /**
         * PROVENANCE: the twin points back at the original it was promoted from.
         *
         * Without it, deleting the chat left the twin behind with nothing to say where it came from —
         * and `clearScope` had no way to tell a twin whose chat is gone from one whose chat is not.
         * The edge is scoped to the ORIGINAL's scope, so it dies with that chat, which is exactly the
         * signal `clearScope` counts.
         *
         * ⚠️ Guarded against duplication: this pass re-runs every few minutes, and an already-promoted
         * original is skipped by the validity filter above — but a re-promoted twin (its own chat
         * deleted, the same fact learned again elsewhere) must not accumulate parallel edges.
         */
        const already = await this.rows(
          `MATCH (t:Memory {id: $gid})-[r:Rel {type: 'consolidated_from'}]->(o:Memory {id: $origin})
           RETURN r.type AS type`,
          { gid, origin: String(row.id) },
        )
        if (already.length === 0) {
          await this.q(
            `MATCH (t:Memory {id: $gid}), (o:Memory {id: $origin})
             CREATE (t)-[:Rel { type: 'consolidated_from', source: 'consolidated',
                                confidence: null,
                                t_valid: current_timestamp(), t_created: current_timestamp() }]->(o)`,
            { gid, origin: String(row.id) },
          )
        }
        // Supersede the session original (bitemporal): it's now represented globally.
        await this.q(`MATCH (m:Memory {id: $id}) SET m.t_invalid = current_timestamp()`, { id: String(row.id) })
        promoted++
      }
      // Carry the RELATIONSHIPS up with the nodes. Without this, consolidation silently destroyed every
      // auto-extracted edge: the twins are NEW ids, the session originals get invalidated above, and
      // `graph()` returns edges only among VALID nodes — so ~5 minutes after a chat the graph collapsed
      // back to disconnected facts, defeating the whole point of KB-D (a). MEASURED before the fix:
      // 3 session nodes + 2 edges -> 3 global nodes + 0 edges.
      // Only edges whose BOTH endpoints were promoted can be carried (an edge to a non-promoted node has
      // no global counterpart to point at). Idempotent: consolidation re-runs every ~5 min, so an
      // existing twin edge of the same type must not be duplicated.
      let edgesCarried = 0
      if (twinOf.size > 0) {
        const sessionIDs = [...twinOf.keys()]
        const edges = await this.rows(
          `MATCH (a:Memory)-[r:Rel]->(b:Memory)
           WHERE r.t_invalid IS NULL AND list_contains($ids, a.id) AND list_contains($ids, b.id)
           RETURN a.id AS from, b.id AS to, r.type AS type, r.source AS source, r.confidence AS confidence`,
          { ids: sessionIDs },
        )
        for (const edge of edges) {
          const from = twinOf.get(String(edge.from))
          const to = twinOf.get(String(edge.to))
          if (from === undefined || to === undefined || from === to) continue
          const type = String(edge.type ?? "related_to")
          const dup = await this.rows(
            `MATCH (a:Memory {id: $from})-[r:Rel {type: $type}]->(b:Memory {id: $to})
             WHERE r.t_invalid IS NULL RETURN r.type AS type`,
            { from, to, type },
          )
          if (dup.length > 0) continue
          await this.q(
            `MATCH (a:Memory {id: $from}), (b:Memory {id: $to})
             CREATE (a)-[:Rel { type: $type, source: $source, confidence: $confidence,
                                t_valid: current_timestamp(), t_created: current_timestamp() }]->(b)`,
            {
              from,
              to,
              type,
              source: (edge.source as string | null) ?? null,
              confidence: (edge.confidence as number | null) ?? null,
            },
          )
          edgesCarried++
        }
      }
      if (promoted > 0 || edgesCarried > 0) this.touch()
      return promoted
    })
  }

  /** How many still-valid `staged` memories a scope holds — the cheap check that decides whether the
   *  forgetting pass has anything to do at all. Deliberately a COUNT and nothing more, so the pass can
   *  ask "is there anything to do?" without paying for a candidate scan; a scope inside its cap costs
   *  one aggregate and stops there. The policy that decides who is evicted lives in `prune-policy.ts`
   *  and the wiring in `memory.ts`'s `forgetOverCap` — never here. */
  stagedCount(scope?: string): Promise<number> {
    return this.serialize(async () => {
      const scopeFilter = scope ? `AND m.scope = $scope` : ``
      const rows = await this.rows(
        `MATCH (m:Memory) WHERE m.t_invalid IS NULL AND m.relation = 'staged' ${scopeFilter} RETURN count(m) AS n`,
        scope ? { scope } : {},
      )
      return Number(rows[0]?.n ?? 0)
    })
  }

  /**
   * Every scope beginning with `prefix` that currently holds staged memories.
   *
   * 🔴 Exists so each colleague's cabinet can be capped SEPARATELY. A single cap over `agent:%` as a
   * whole would let one talkative officer evict another's memories — the same reasoning the
   * colleague rate window follows ("one loud colleague never spends another's allowance"), and the
   * reason this returns scopes rather than pruning by prefix in one pass.
   */
  stagedScopes(prefix: string): Promise<string[]> {
    // The query is part of the same single-threaded graph transaction as every other public op.
    // Keeping it behind the lock also makes a debounced CHECKPOINT unable to interleave with the
    // result read, and lets the dead latch reject it before it reaches a failed WASM connection.
    return this.serialize(async () => {
      const rows = await this.rows(
        `MATCH (m:Memory)
         WHERE m.t_invalid IS NULL AND m.relation = 'staged' AND starts_with(m.scope, $prefix)
         RETURN DISTINCT m.scope AS scope`,
        { prefix },
      )
      return rows.map((row) => String(row.scope ?? "")).filter((scope) => scope !== "")
    })
  }

  /**
   * SHORT rows for the pruning policy and the noise views — id, provenance, lifecycle, age.
   *
   * 🔴 **No `text` in the projection, and that is not an optimisation.** A table scan on this engine
   * can return an empty string for `text` while the row is intact (see `hydrate`), so a scan that
   * projected it would hand the policy blank bodies and the "never used" list blank captions. Ids,
   * kinds, scopes, sources, confidences and timestamps all survive a scan; only the long string does
   * not. Callers that need the body ask `hydrate` for the handful they chose.
   *
   * ⚠️ `ORDER BY m.t_created … LIMIT n` returning only short columns is the same shape `list` already
   * uses. `WITH m ORDER BY … RETURN …` is the shape that HANGS, and it is not used here.
   */
  candidates(opts: CandidateInput = {}): Promise<CandidateRow[]> {
    return this.serialize(async () => {
      const validity = opts.includeInvalid ? `` : `AND m.t_invalid IS NULL`
      const scopeFilter = opts.scopes ? `AND m.scope IN $scopes` : ``
      const relationFilter = opts.relation ? `AND m.relation = $relation` : ``
      const kindFilter = opts.kinds ? `AND m.kind IN $kinds` : ``
      const statusFilter = opts.statuses ? `AND m.status IN $statuses` : ``
      const direction = opts.order === "newest" ? "DESC" : "ASC"
      // A higher ceiling than `list`/`graph` because these rows are SHORT: no body, so a wide window
      // costs a scan and a few numbers per row rather than a page of text.
      const limit = Math.max(1, Math.min(opts.limit ?? 500, 20000))
      const rows = await this.rows(
        `MATCH (m:Memory) WHERE true ${validity} ${scopeFilter} ${relationFilter} ${kindFilter} ${statusFilter}
         RETURN m.id AS id, m.scope AS scope, m.kind AS kind, m.name AS name, m.source AS source,
                m.confidence AS confidence, m.relation AS relation, m.status AS status,
                m.conflict_key AS conflict_key, m.t_created AS created_at
         ORDER BY m.t_created ${direction} LIMIT ${limit}`,
        {
          ...(opts.scopes ? { scopes: opts.scopes } : {}),
          ...(opts.relation ? { relation: opts.relation } : {}),
          ...(opts.kinds ? { kinds: opts.kinds } : {}),
          ...(opts.statuses ? { statuses: opts.statuses } : {}),
        },
      )
      return rows.map((row) => ({
        id: String(row.id),
        scope: String(row.scope ?? ""),
        kind: String(row.kind ?? "entity") as MemoryKind,
        name: (row.name as string | null) ?? null,
        source: (row.source as string | null) ?? null,
        confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
        relation: (String(row.relation ?? "staged") as Relation) ?? "staged",
        status: String(row.status ?? "active") as KbClaim.ClaimStatus,
        conflictKey: (row.conflict_key as string | null) ?? null,
        ...(isoTime(row.created_at) === undefined ? {} : { createdAt: isoTime(row.created_at)! }),
      }))
    })
  }

  /** Full rows for ids the caller already chose — the public door onto `hydrate`. */
  byIds(ids: readonly string[]): Promise<MemoryRow[]> {
    return this.serialize(async () => this.hydrate(ids))
  }

  /** The backfill queue for the embed drain: still-valid memories that have NO vector yet — stored
   *  before an embedding device was configured, or while it was unreachable. Without draining these,
   *  the vector leg would only ever cover NEW writes and an instance with history stays keyword-only.
   *  Newest first (recent memories are the ones most likely to be recalled). */
  pendingEmbeddings(limit = 64): Promise<{ id: string; text: string }[]> {
    return this.serialize(async () => {
      // Select only ids through the scan: this engine can return an empty `text` for a table scan
      // after snapshotting, while the row is still intact. Hydrate the bounded result set by primary
      // key before handing bodies to the embedder, just like `list` and `search` do.
      const selected = await this.rows(
        `MATCH (m:Memory) WHERE m.t_invalid IS NULL AND m.embedding IS NULL
         RETURN m.id AS id
         ORDER BY m.t_created DESC LIMIT ${Math.max(1, Math.min(limit | 0, 512))}`,
      )
      return (await this.hydrate(selected.map((row) => String(row.id))))
        .map((row) => ({ id: row.id, text: row.text }))
        .filter((row) => row.text.length > 0)
    })
  }

  /**
   * Attach a vector to an existing memory (the embed drain). Idempotent — re-running is harmless.
   *
   * ⚠️ **A `MATCH` that binds nothing is not an error**, so this used to report success for a row
   * that had been forgotten between `pendingEmbeddings` and here — the same silent-success shape
   * `invalidate`/`purge` were carrying, one table over. It matters more here than it looks: the
   * drain's whole purpose is that a memory stored before an embedding device existed eventually gets
   * a vector, and a no-op that answers success is indistinguishable from that having happened.
   *
   * The probe is a PRIMARY-KEY lookup returning one short column, inside the SAME `serialize` block
   * as the write — a scan can hand back an empty `text` for an intact row (see `hydrate`) and an
   * empty result is indistinguishable from a failed query, so it reads the id it matched on and
   * nothing else. A THROW rather than a boolean, for the reason spelled out at `requireErasable`:
   * every consumer already routes a rejection somewhere and already skips the success-only work.
   */
  setEmbedding(id: string, embedding: readonly number[]): Promise<void> {
    if (embedding.length !== this.dim)
      return Promise.reject(new Error(`embedding length ${embedding.length} != store dim ${this.dim}`))
    return this.serialize(async () => {
      await this.q(`MATCH (m:Memory {id: $id}) SET m.embedding = ${vectorLiteral(embedding)}`, { id })
      const seen = await this.rows(`MATCH (m:Memory {id: $id}) RETURN m.id AS id`, { id })
      if (seen.length === 0) throw new Error(`setEmbedding: no memory ${id} — the row went away before the vector did`)
      this.touch()
    })
  }

  /** Flush a final snapshot, close the DB + connection, and remove the scratch dir. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    /**
     * 🔴 **`close()` MUST RETURN.** It used to `await this.flush()`, which awaits `serialize()`, which
     * chains on `this.lock` — so one call that never settles against a dead module made closing the
     * store hang forever. That is the wedge: measured 2026-08-26 at 0.1% CPU with commit charge frozen
     * to the byte, a process that could not finish and could not be diagnosed from its own output.
     *
     * ⚠️ The deadline is a BOUND, not a fix for slowness. A flush that genuinely needs longer than this
     * has already written its files durably or is not going to; either way the last VERIFIED generation
     * is on disk (`GraphSnapshot`'s `LASTGOOD` pin), so giving up here costs the newest writes, never
     * the store. Silence is the one outcome that is not acceptable, so it SAYS it gave up.
     */
    if (!(await this.bounded(this.flush(), CLOSE_FLUSH_DEADLINE_MS)))
      console.error(`kb-memory: the final flush did not finish within ${CLOSE_FLUSH_DEADLINE_MS}ms — closing anyway`)
    try {
      await this.bounded(Promise.resolve(this.conn.close?.()), CLOSE_FLUSH_DEADLINE_MS)
      await this.bounded(Promise.resolve(this.db.close?.()), CLOSE_FLUSH_DEADLINE_MS)
    } catch {
      /* already closed */
    }
    // The scratch dir is throwaway — `flush()` above copied everything durable out to `realDir`.
    // Removing it AFTER the DB is closed, and only then, is what stops one directory per open
    // accumulating forever. Best-effort: a failure here must never surface as a close() error.
    removeScratch(this.memfsDir)
  }
}
