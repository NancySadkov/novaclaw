// What the hero tile reports: how loaded THIS instance is right now.
//
// The tile used to carry a fixed tagline, then a one-line activity string. A launcher's one 2×2 tile
// is the most valuable real estate in the product, and the owner's call (2026-08-13) is that it
// should read as a small system monitor — threads running, throughput, memory pressure — with no app
// label at all: the artwork says which app it is, so spending the headline on the word "Tasks" tells
// a person something they can already see.
//
// Threads and throughput are free (already synced per session). Memory is the one number that has to
// be asked for, so it is polled on a slow cadence and degrades to "unknown" rather than to zero —
// `pressure.ts` is emphatic that an unmeasurable host must never read as a healthy one.
import { createMemo, createResource, onCleanup, onMount } from "solid-js"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { instancePressure } from "@/utils/resource-api"
import { formatTokensPerSecond } from "@/utils/token-rate"
import type { HeroStat } from "./registry"

export interface ThreadActivity {
  /** Sessions whose agent is running right now. */
  readonly running: number
  /** Combined ~tokens/sec across those sessions; 0 when every stream has gone quiet. */
  readonly tps: number
}

/** Reactive running-count + combined throughput for the active server. */
export function useThreadActivity(): () => ThreadActivity {
  const serverSync = useServerSync()
  return createMemo(() => {
    const session = serverSync().session
    const ids = Object.keys(session.data.info)
    let running = 0
    let tps = 0
    for (const id of ids) {
      if (!session.data.session_working(id)) continue
      running += 1
      tps += session.data.session_live(id)?.tps ?? 0
    }
    return { running, tps }
  })
}

/** Memory as the hero needs it: a fraction and a severity, or nothing when the host cannot say. */
export interface MemoryLoad {
  /** Committed / limit, 0–1. */
  readonly fraction: number
  /** True once the instance's own thresholds call this warning-or-worse — never a number we invent. */
  readonly strained: boolean
}

export interface SystemLoad extends ThreadActivity {
  /** `undefined` while the first probe is in flight, or on a host that cannot be measured. */
  readonly memory: MemoryLoad | undefined
}

/**
 * How often the hero re-asks for memory. Deliberately slower than the Storage tab's 5 s: this poll
 * runs for as long as the launcher is on screen (which is the app's idle state), the Windows probe
 * costs 400–800 ms of PowerShell, and committed memory does not move fast enough for a person
 * watching a tile to notice the difference.
 */
export const MEMORY_POLL_MS = 10_000

export function useSystemLoad(): () => SystemLoad {
  const activity = useThreadActivity()
  const server = useServer()
  const global = useGlobal()
  const connection = createMemo(() => server.current ?? global.servers.list()[0])
  // 🔴 `.catch`, and it is the whole difference between a degraded tile and a dead app. This
  // resource polls the INSTANCE, so it fails exactly when the instance is down — and a rejected
  // resource read inside the memo below throws out of the memo into the app's ErrorBoundary, which
  // replaces the entire UI with "Something went wrong" while the supervisor is calmly restarting
  // the sidecar underneath. Measured 2026-08-18 in dev Electron: the error page appeared ~2 s after
  // the sidecar was killed, BEFORE the connection banner's 2 s anti-flicker gate could show it, and
  // it never cleared when the sidecar came back. An unreachable host is the "cannot be measured"
  // case this file already documents — so it degrades to `undefined` and the tile reads "—".
  const [usage, actions] = createResource(connection, (value) => instancePressure(value.http).catch(() => undefined))

  // 🔴 GATED ON VISIBILITY, and that is not an optimisation (review H3, 2026-08-23).
  //
  // This poll hits `global/resources`, whose Windows memory reading spawns a `powershell.exe`
  // running `Get-CimInstance Win32_OperatingSystem` — measured on the owner's box at 360–657 ms,
  // median ≈530 ms. The probe is cached for `MEMORY_CACHE_MS = 3_000`, a TTL sized for a per-turn
  // path, so a 10-second poll misses it EVERY time: one fresh process per tick, ≈5% duty cycle,
  // forever, on the app's idle screen. And it ran with the window minimised or backgrounded, where
  // nobody can see the number it is refreshing.
  //
  // The house pattern is already here — `components/debug-bar.tsx` and `context/server-sync.tsx`
  // both gate their polls the same way. Coming back to visible refetches once, so the tile is
  // current the moment it is looked at rather than up to ten seconds stale.
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }
  const start = () => {
    if (timer !== undefined) return
    timer = setInterval(() => void actions.refetch(), MEMORY_POLL_MS)
  }
  const onVisibility = () => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      stop()
      return
    }
    void actions.refetch()
    start()
  }
  onMount(() => {
    // ⚠️ The listener is registered UNCONDITIONALLY. Registering it only on the visible branch would
    // leave a tile mounted while hidden with no way to ever start — the tile would sit at "—" for
    // the rest of the session.
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility)
    if (typeof document === "undefined" || document.visibilityState === "visible") start()
  })
  onCleanup(() => {
    stop()
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility)
  })

  return createMemo<SystemLoad>(() => {
    // `.latest`, not `usage()`: a refetch every 10 s would otherwise blank the number it is
    // refreshing, so the tile would flicker to "—" and back forever.
    const report = usage.latest
    const memory = report?.memory
    return {
      ...activity(),
      memory:
        report && memory?.known && memory.limitBytes > 0
          ? {
              fraction: memory.usedBytes / memory.limitBytes,
              // MEMORY's own verdict, not the instance-wide `level` (which is the worst of memory
              // and every disk) and not a threshold restated here: two places deciding what
              // "strained" means is how the copy and the guard drift apart.
              strained: report.memoryLevel === "warning" || report.memoryLevel === "floor",
            }
          : undefined,
    }
  })
}

/** The em dash the tile shows for a number this host cannot answer. Never a zero — see `pressure.ts`. */
const UNKNOWN = "—"

/**
 * The i18n keys this readout needs, spelled out rather than widened to `string`.
 *
 * A `(key: string) => string` parameter would REJECT the real `Translator` (its key type is the
 * literal union of shipped keys, and parameters are contravariant), and the cast that makes that
 * compile is exactly the hole `app-label.ts` exists to close: it lets an unshipped key reach the
 * translator and render raw at the user. Naming the three keys keeps the compiler checking them.
 */
type StatKey = "home.app.contacts.stat.running" | "home.app.contacts.stat.throughput" | "home.app.contacts.stat.memory"

/**
 * The three numbers, formatted for the tile.
 *
 * Zero running threads is shown as a dimmed "0" rather than hidden: this is a load report, and a
 * monitor that disappears when idle cannot be read at a glance ("is it quiet, or is it broken?").
 * Throughput dims with it, because a rate with nothing running is noise.
 */
export function systemLoadStats(load: SystemLoad, t: (key: StatKey) => string): readonly HeroStat[] {
  const idle = load.running === 0
  return [
    {
      id: "running",
      value: String(load.running),
      label: t("home.app.contacts.stat.running"),
      tone: idle ? "idle" : undefined,
    },
    {
      id: "throughput",
      // A running agent between steps (a tool call) legitimately reports 0 t/s, and printing "0"
      // there reads as stalled — the dash says "nothing to report" instead.
      value: formatTokensPerSecond(load.tps) ?? UNKNOWN,
      label: t("home.app.contacts.stat.throughput"),
      tone: load.tps > 0 ? undefined : "idle",
    },
    {
      id: "memory",
      value: load.memory ? `${Math.round(load.memory.fraction * 100)}%` : UNKNOWN,
      label: t("home.app.contacts.stat.memory"),
      tone: load.memory?.strained ? "warn" : undefined,
    },
  ]
}
