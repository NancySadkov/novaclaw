/**
 * What the packaged desktop startup actually costs, phase by phase.
 *
 * `todo/startup.md`: *instrument the packaged desktop path from process start through sidecar ready,
 * server health, renderer interactive, and first chat token; attribute time and per-process memory.*
 * Until this exists every startup claim in the roadmap is an opinion — including the one written the
 * same week about retiring native dependencies to make boot faster.
 *
 * Deliberately free of Electron: the clock, the process-start instant and the memory reader are all
 * injected, so the ordering and the arithmetic can be tested without a display. `index.ts` supplies
 * the real ones.
 */

/**
 * The phases, in the order they can occur.
 *
 * A CLOSED vocabulary rather than free strings, because the whole value of this file is comparing
 * one run against another — and two runs that spell a phase differently cannot be compared at all.
 */
export const BOOT_PHASES = [
  /** Electron finished its own startup and the main script can draw. */
  "electron-ready",
  /** The sidecar child has been spawned; nothing has been asked of it yet. */
  "sidecar-spawned",
  /** `/global/health` answered — the server is genuinely serving, not merely running. */
  "sidecar-health",
  /** A window exists on screen. May precede `sidecar-health`: the desktop boots window-first. */
  "window-shown",
  /** The renderer says it has finished its first paint and is accepting input. */
  "renderer-interactive",
  /** The first token of the first assistant reply reached the renderer. */
  "first-chat-token",
] as const

export type BootPhase = (typeof BOOT_PHASES)[number]

/** One process's memory at a moment. Bytes, so no reader has to remember a unit. */
export interface ProcessMemory {
  /** `browser` (Electron main), `renderer`, `gpu`, `utility`, or `sidecar` for the server child. */
  readonly kind: string
  readonly pid: number
  /**
   * ⚠️ WORKING SET, and it UNDERSTATES — badly, and in the direction that flatters us. A zombie bun
   * on this project once held 6.21 GB of commit charge at a working set of zero. Electron's
   * `getAppMetrics` exposes no commit figure, so this is what can be had per Electron process; read
   * it as "at least this much", never as the cost. Where commit charge matters, measure the process
   * directly — `PagedMemorySize64` on Windows.
   */
  readonly workingSetBytes: number
}

export interface BootMark {
  readonly phase: BootPhase
  /** Milliseconds since the OS created this process — NOT since this module loaded. */
  readonly elapsedMs: number
  readonly memory: readonly ProcessMemory[]
}

export interface BootTimelineOptions {
  /** Monotonic-ish wall clock, in epoch milliseconds. */
  readonly now: () => number
  /**
   * When the OS created this process, in epoch milliseconds.
   *
   * 🔴 The whole point of taking this rather than using `performance.now()`. In a packaged build the
   * main script starts well after the process does — Electron's own startup, the asar mount and V8's
   * snapshot all happen first, and on a cold disk that is the LARGEST single slice of the boot. A
   * timeline anchored at module load reports a fast startup by excluding the slow part, which is
   * worse than no measurement because it looks like one.
   */
  readonly processStartedAt: number
  /** Per-process memory right now. Returning an empty list is fine — a mark is still worth its time. */
  readonly memory: () => readonly ProcessMemory[]
}

export interface BootTimeline {
  /** Record `phase` if it has not been recorded. Returns the mark, or `undefined` if it was a repeat. */
  readonly mark: (phase: BootPhase) => BootMark | undefined
  /** Every mark taken, in the order it was taken. */
  readonly marks: () => readonly BootMark[]
  readonly summary: () => BootSummary
}

export interface BootSummary {
  readonly marks: readonly BootMark[]
  /**
   * Phases that never happened.
   *
   * 🔴 Reported by NAME, never folded into a zero. A boot that never reached `first-chat-token`
   * and a boot that reached it instantly are opposite outcomes, and a series that spells them the
   * same way will average them together into a number describing neither run.
   */
  readonly missing: readonly BootPhase[]
  /** Milliseconds between each mark and the one before it, keyed by the LATER phase. */
  readonly deltasMs: Readonly<Partial<Record<BootPhase, number>>>
}

export function createBootTimeline(options: BootTimelineOptions): BootTimeline {
  const taken: BootMark[] = []
  const seen = new Set<BootPhase>()

  const mark = (phase: BootPhase): BootMark | undefined => {
    // ⚠️ FIRST wins, and later ones are dropped rather than overwriting. `first-chat-token` fires
    // once per assistant reply and `renderer-interactive` fires again on every reload; letting a
    // later one win would silently turn "time to first token" into "time to the most recent token",
    // which still looks like a plausible startup number.
    if (seen.has(phase)) return undefined
    seen.add(phase)
    const entry: BootMark = {
      phase,
      // Rounded: `process.getCreationTime()` is a float, and twelve decimal places of a millisecond
      // is noise that makes two runs look different when they are not.
      elapsedMs: Math.round(Math.max(0, options.now() - options.processStartedAt)),
      memory: options.memory(),
    }
    taken.push(entry)
    return entry
  }

  const summary = (): BootSummary => {
    // Ordered by WHEN THEY HAPPENED, not by the vocabulary's order: the desktop boots window-first,
    // so `window-shown` legitimately precedes `sidecar-health`, and sorting by the declaration would
    // invent a negative delta and report it as though the clock had gone backwards.
    const ordered = [...taken].sort((a, b) => a.elapsedMs - b.elapsedMs)
    const deltasMs: Partial<Record<BootPhase, number>> = {}
    ordered.forEach((entry, index) => {
      const previous = index === 0 ? 0 : ordered[index - 1]!.elapsedMs
      deltasMs[entry.phase] = entry.elapsedMs - previous
    })
    return {
      marks: ordered,
      missing: BOOT_PHASES.filter((phase) => !seen.has(phase)),
      deltasMs,
    }
  }

  return { mark, marks: () => [...taken], summary }
}

/**
 * One line per mark, for the log.
 *
 * Flat `key=value` because this is read by a human tailing a log during a slow boot, and because the
 * fields are then greppable across runs without a parser.
 */
export function formatMark(mark: BootMark): string {
  const memory = mark.memory
    .map((entry) => `${entry.kind}=${Math.round(entry.workingSetBytes / 1024 / 1024)}MB`)
    .join(" ")
  return `boot phase=${mark.phase} elapsed=${mark.elapsedMs}ms${memory ? ` ${memory}` : ""}`
}

/**
 * The whole boot as one line, for the end.
 *
 * ⚠️ Names what is MISSING. A summary that lists only what happened reads as complete no matter how
 * much did not, and the phases most worth knowing about are exactly the ones a bad boot never reaches.
 */
export function formatSummary(summary: BootSummary): string {
  const reached = summary.marks.map((mark) => `${mark.phase}=${mark.elapsedMs}ms`).join(" ")
  const missing = summary.missing.length > 0 ? ` missing=${summary.missing.join(",")}` : ""
  return `boot summary ${reached}${missing}`
}
