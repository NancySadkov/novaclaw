import { A } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import type { LogReadResult } from "@novaclaw/sdk/v2/types"
import type { SessionPresenceSnapshot } from "@novaclaw/sdk/v2/client"
import * as Timestamp from "@novaclaw/schema/time"
import { Icon } from "@novaclaw/ui/v2/icon"
import { instanceFetch } from "@/utils/instance-fetch"
import { useGlobal } from "@/context/global"
import { useServer, ServerConnection } from "@/context/server"
import type { ServerStreamStatus } from "@/context/server-sdk"
import { sessionHref } from "@/utils/session-route"
import { clearErrorLog, errorLogEntries } from "@/utils/error-log"
import { showToast } from "@/utils/toast"
import { schedulerSnapshot } from "@/utils/scheduler-api"
import { capabilities, retryCapability } from "@/utils/capability-api"
import { loadedPlugins } from "@/utils/plugin-api"
import { createSettledResource } from "@/utils/settled-resource"
import { retrySessionExecution, sessionExecutions, stopSessionExecution } from "@/utils/session-execution-api"
import { contextTurns, formatContextFinding, formatContextTokens } from "./debug-context"
import { debugPresenceBusy, debugPresenceCell, debugPresenceOrphanText, debugPresenceOrphans } from "./debug-presence"
import { VIEWER_TTL_SECONDS } from "./session/session-presence"
import { useSettingsDialog } from "@/components/settings-dialog"
import { AppPage, AppPageHeader } from "@/components/app-page"
import { ExpertiseGate } from "@/components/expertise-gate"
import { RequiresLevel } from "@/context/expertise"
import { useLanguage } from "@/context/language"
import { instanceGlobalDirectory } from "@/utils/routing-directory"
import { listDebugActiveSessions, listDebugSessions } from "./debug-process"

// The Debug app (dependability P5) — the Developer-mode diagnostic surface. Most panels are
// observational; the capability panel has one explicit recovery action that retries a cached startup
// failure. Strings inside the app stay untranslated on purpose — a Developer-only surface, like
// Registry. The GATE below is the exception and has to be: the only person who ever reads it is a
// user who is NOT in Developer mode, i.e. exactly the audience the English-only rule is wrong for.

const STATUS_TONE: Record<ServerStreamStatus, string> = {
  connected: "text-v2-state-fg-success",
  connecting: "text-v2-text-text-muted",
  reconnecting: "text-v2-state-fg-warning",
  idle: "text-v2-text-text-faint",
}

// ── the ROUTE gate ────────────────────────────────────────────────────────────────────────────────
//
// The home tile in `apps/builtins.tsx` carries `minLevel: "developer"`, and that hides the ICON —
// nothing more. It never defended the ADDRESS: measured 2026-08-19 in the running web app, `/debug`
// at `general.expertiseLevel = "normal"` rendered this whole page — connection panel, error log,
// instance log, and the `ps` table with raw session ids — for a user whose home screen had correctly
// hidden the tile. A tile is a suggestion; a typed URL, an OS notification and a pasted link all
// reach a page without one, so the gate has to live on the page.
//
// It EXPLAINS instead of bouncing (AGENTS.md principle 8, and `app-routes.test.ts`, which forbids the
// `fallback={<Navigate href="/" />}` that `/terminal` once shipped): the deep link is the one moment
// this product can teach what expertise levels are, and a silent redirect says nothing.
//
// The split into an outer gate and an inner page is load-bearing, not tidiness. `DebugAppPage` polls
// on mount — scheduler snapshot, capabilities, session executions, the instance log — so wrapping
// only its returned JSX in `RequiresLevel` would keep every one of those timers running for a user
// who is not permitted to see a single result.
export function DebugPage() {
  const language = useLanguage()
  return (
    <RequiresLevel
      min="developer"
      fallback={
        <AppPage class="flex">
          <ExpertiseGate
            glyph="debug"
            title={language.t("home.app.debug.name")}
            description={language.t("debug.gate.description")}
          />
        </AppPage>
      }
    >
      <DebugAppPage />
    </RequiresLevel>
  )
}

function DebugAppPage() {
  const language = useLanguage()
  const global = useGlobal()
  const server = useServer()
  const showModels = useSettingsDialog("models")

  const servers = createMemo(() => global.servers.list())
  const focused = createMemo(() => server.current ?? servers()[0])

  const [processRosterRefresh, setProcessRosterRefresh] = createSignal(0)
  const [processRoster] = createSettledResource(
    () => {
      const conn = focused()
      return conn ? { conn, refresh: processRosterRefresh() } : undefined
    },
    ({ conn }) => listDebugSessions(global.ensureServerCtx(conn).sdk.client),
  )
  const [activeRoster] = createSettledResource(
    () => {
      const conn = focused()
      return conn ? { conn, refresh: processRosterRefresh() } : undefined
    },
    ({ conn }) => listDebugActiveSessions(global.ensureServerCtx(conn).sdk.client),
  )

  const sessions = createMemo(() => {
    const conn = focused()
    if (!conn) return []
    const ctx = global.ensureServerCtx(conn)
    const key = ServerConnection.key(conn)
    const status = ctx.sync.session.data.session_status
    const active = activeRoster() ?? {}
    const rows = (processRoster() ?? [])
      .filter((s) => s.time.archived === undefined)
      .map((s) => ({
        id: s.id,
        title: s.title,
        agent: s.agent,
        model: s.model,
        tokens: s.tokens,
        parentID: s.parentID,
        status: active[s.id] !== undefined ? "busy" : (status[s.id]?.type ?? "idle"),
        // The presence column's busy half. Read from the session-status signal through its ONE
        // owner — never from the `status` column above, which shows the durable EXECUTION state
        // when there is one and would report an exited worker as busy.
        busy: active[s.id] !== undefined || debugPresenceBusy(status[s.id]),
        href: sessionHref(key, s.id),
      }))
    // working first, then newest ids first (ids are time-sortable)
    return rows.sort(
      (a, b) =>
        Number(["busy", "retry"].includes(b.status)) - Number(["busy", "retry"].includes(a.status)) ||
        (a.id < b.id ? 1 : -1),
    )
  })

  // ── presence: the `ps` metaphor's "who is attached / who is driving" half ────────────────────
  //
  // AGENTS.md's table asks `ps` for agent · model · parent · status · tokens — and the dependability
  // half of that is *who is looking at this chat*. Everything here READS the shipped presence
  // component: the same `session_presence` store the Chats row and the chat header render from, fed
  // by `GET /api/presence` + `session.presence.updated`. No second store, no second endpoint, and
  // nothing that would give presence a server: `all()` answers only for this instance's own
  // sessions, exactly as it does for every other surface.
  //
  // ⚠️ It re-reads on a timer, which the chat view does not need and this one does. The instance
  // publishes only on report/claim/detach and runs no sweeper, so a room whose LAST viewer died
  // silently is collected by the next `all()` and by nothing else. A chat has an attached viewer by
  // construction, so its rooms self-heal on the next heartbeat; a `ps` table is a list of rooms
  // nobody may be in, so without this it would show ghosts indefinitely. Half the expiry budget
  // keeps a healthy row verified between reads.
  const PRESENCE_REREAD_MS = (VIEWER_TTL_SECONDS / 2) * 1000
  const [presenceReadAt, setPresenceReadAt] = createSignal<number | undefined>(undefined)
  const [presenceClock, setPresenceClock] = createSignal(Date.now())

  const refreshPresence = () => {
    const conn = focused()
    if (!conn) return
    void global
      .ensureServerCtx(conn)
      .sync.session.loadPresence()
      // Only a read that ANSWERED may reset the clock — see `loadPresence`'s note. A failed read
      // leaves the previous stamp, so the column ages into "unverified" instead of lying.
      .then((ok) => {
        if (ok) setPresenceReadAt(Date.now())
      })
  }

  // A different instance is a different set of rooms: forget the stamp rather than carrying one
  // server's freshness onto another's rows.
  createEffect(
    on(focused, () => {
      setPresenceReadAt(undefined)
      refreshPresence()
    }),
  )

  onMount(() => {
    const timer = setInterval(() => {
      setPresenceClock(Date.now())
      const at = presenceReadAt()
      if (at === undefined || Date.now() - at >= PRESENCE_REREAD_MS) refreshPresence()
    }, 5_000)
    onCleanup(() => clearInterval(timer))
  })

  const presenceMap = createMemo(() => {
    const conn = focused()
    if (!conn) return {} as Record<string, SessionPresenceSnapshot | undefined>
    return global.ensureServerCtx(conn).sync.session.data.session_presence
  })

  const presenceFor = (sessionID: string, busy: boolean) =>
    debugPresenceCell({
      snapshot: presenceMap()[sessionID],
      // Busy has exactly one owner — the `session.status` signal. Presence carries no busy flag and
      // must not grow one; the row already carries the answer and this only composes the two.
      busy,
      readAt: presenceReadAt(),
      now: presenceClock(),
    })

  const presenceOrphans = createMemo(() =>
    debugPresenceOrphans(presenceMap(), new Set(sessions().map((row) => row.id))),
  )
  // The orphan line reads the same cached map as the cells, so it inherits the same doubt.
  const presenceUnverified = () => {
    const at = presenceReadAt()
    return at === undefined || presenceClock() - at > VIEWER_TTL_SECONDS * 1000
  }

  const config = createMemo(() => {
    const conn = focused()
    if (!conn) return ""
    try {
      return JSON.stringify(global.ensureServerCtx(conn).sync.data.config, null, 2)
    } catch {
      return "<config unavailable>"
    }
  })

  // The live scheduler view. Unlike the other panels this one is SERVER state (the per-instance EEVDF
  // ledger), so it is fetched rather than read from the client store, and refreshed on demand.
  const [schedTick, setSchedTick] = createSignal(0)
  const schedDirectory = () => {
    const conn = focused()
    if (!conn) return undefined
    const path = global.ensureServerCtx(conn).sync.data.path
    return instanceGlobalDirectory(path)
  }
  // Where the INSTANCE's own log lives. `GET /instance` already reports it (`path.log`), which is
  // the answer to *"the desktop GUESSES where the sidecar's logs are"* — ask
  // the instance, never rebuild the path from environment guesses.
  const serverLogPath = () => {
    const conn = focused()
    if (!conn) return undefined
    return (global.ensureServerCtx(conn).sync.data.path as { log?: string } | undefined)?.log
  }

  const [scheduler] = createResource(
    () => {
      const conn = focused()
      const dir = schedDirectory()
      return conn && dir !== undefined ? { conn, dir, t: schedTick() } : undefined
    },
    ({ conn, dir }) => schedulerSnapshot(conn.http, { directory: dir }).catch(() => undefined),
  )

  const [capabilityTick, setCapabilityTick] = createSignal(0)
  const [capabilityList] = createResource(
    () => {
      const conn = focused()
      const dir = schedDirectory()
      return conn && dir !== undefined ? { conn, dir, t: capabilityTick() } : undefined
    },
    ({ conn, dir }) => capabilities(conn.http, dir).catch(() => undefined),
  )
  // `createSettledResource`, not a bare `createResource` with a `.catch(() => undefined)`: swallowing
  // the rejection makes "the request failed" and "there are no plugins" the same observation, and on
  // a disclosure surface the wrong one of those is a claim that nothing third-party is loaded.
  const [pluginList] = createSettledResource(
    () => {
      const conn = focused()
      const dir = schedDirectory()
      return conn && dir !== undefined ? { conn, dir } : undefined
    },
    ({ conn, dir }) => loadedPlugins(conn.http, dir),
  )

  const retryUnavailableCapability = async (name: string) => {
    const conn = focused()
    if (!conn) return
    try {
      await retryCapability(conn.http, name, schedDirectory() ?? "")
      setCapabilityTick((value) => value + 1)
      showToast({ title: `${name} checked again` })
    } catch (error) {
      showToast({ title: `Could not retry ${name}`, description: String(error), variant: "error" })
    }
  }

  const [executionTick, setExecutionTick] = createSignal(0)
  const [executions] = createResource(
    () => {
      const conn = focused()
      return conn ? { conn, t: executionTick() } : undefined
    },
    ({ conn }) => sessionExecutions(conn.http).catch(() => []),
  )
  const executionBySession = createMemo(() =>
    Object.fromEntries((executions() ?? []).map((attempt) => [attempt.sessionID, attempt])),
  )
  const actOnExecution = async (action: "retry" | "stop", sessionID: string) => {
    const conn = focused()
    if (!conn) return
    const directory = schedDirectory() ?? ""
    try {
      if (action === "retry") await retrySessionExecution(conn.http, sessionID, directory)
      else await stopSessionExecution(conn.http, sessionID, directory)
      setExecutionTick((v) => v + 1)
      showToast({ title: action === "retry" ? "Session retry started" : "Session stopped" })
    } catch (error) {
      showToast({
        title: action === "retry" ? "Could not retry session" : "Could not stop session",
        description: String(error),
        variant: "error",
      })
    }
  }

  // Keep the context fetch keyed by the session identity, not by the derived `sessions()` rows.
  // That array also reads live status, so rebuilding it for every busy/idle event used to make the
  // resource below reload the selected session's entire message history on each status transition.
  // The context panel is a diagnostic sample of the newest session; status changes are already
  // visible in the `ps` table and must not invalidate its transcript.
  const contextSessionID = createMemo(() => {
    const conn = focused()
    if (!conn) return undefined
    return (processRoster() ?? [])
      .filter((row) => row.time.archived === undefined)
      .sort((a, b) => (a!.id < b!.id ? 1 : -1))[0]?.id
  })
  const contextSession = createMemo(() => {
    const id = contextSessionID()
    return id === undefined ? undefined : sessions().find((row) => row.id === id)
  })
  const [contextLoad, { refetch: refetchContext }] = createResource(
    () => {
      const conn = focused()
      const sessionID = contextSessionID()
      return conn && sessionID ? { conn, sessionID } : undefined
    },
    async ({ conn, sessionID }) => {
      await global
        .ensureServerCtx(conn)
        .sync.nativeMessages.load(sessionID)
        .catch(() => undefined)
      return sessionID
    },
  )
  const packedTurns = createMemo(() => {
    const conn = focused()
    const row = contextSession()
    if (!conn || !row) return []
    return contextTurns(global.ensureServerCtx(conn).sync.nativeMessages.messages(row.id) ?? [])
  })

  // ── the error log as a READER ───────────────────────────────────────────────────────────────
  //
  // 3f asks this panel to gain filters and a copyable line for a bug report rather than growing a
  // second viewer beside it. Two things about what it filters, both worth stating because both are
  // easy to get wrong from a distance:
  //
  // ⚠️ **These are the RENDERER's five levels, not the wire's four.** `error-log.ts`'s vocabulary is
  // `error·warn·notice·uncaught·rejection`, and it is deliberately *not* a severity scale —
  // `uncaught` and `rejection` say how a fault ARRIVED, `notice` is quieter than `warn`. So the
  // filter is a set of names with counts, never a `>=` floor: a floor would have to invent an order
  // that does not exist and would silently hide `rejection` behind `error`.
  //
  // ⚠️ **This panel shows the CLIENT's ring, and the instance's own `novaclaw.log` is a different
  // file.** Saying so in the panel is the honest move — a developer reading "Error log" in the Debug
  // app and finding no server faults would reasonably conclude the server had none. The server's log
  // now has its own panel below (`data-panel="server-log"`, `POST /api/log/read`), and the two stay
  // SEPARATE: they are two formats written by two processes, and interleaving them would need a
  // second renderer of a log line — the defect that route was shaped to make unbuildable.
  const [levelFilter, setLevelFilter] = createSignal<string | undefined>(undefined)
  const [logMatch, setLogMatch] = createSignal("")

  const logCounts = createMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of errorLogEntries()) counts.set(entry.level, (counts.get(entry.level) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  })

  const filteredLog = createMemo(() => {
    const level = levelFilter()
    const match = logMatch().trim().toLowerCase()
    return errorLogEntries().filter(
      (entry) =>
        (level === undefined || entry.level === level) &&
        (match.length === 0 || entry.text.toLowerCase().includes(match)),
    )
  })

  /** One entry as one line. The ONE rendering of an entry as text — `copyLog` reuses it. */
  const logLine = (entry: { at: number; level: string; text: string }) =>
    `${Timestamp.toISOString(entry.at) ?? "unknown-time"} [${entry.level}] ${entry.text}`

  const copyLog = () => {
    // A bug report wants to know WHICH instance and WHICH slice of the log, or the paste is a wall
    // of lines with no provenance. The header is ours and stays outside the copied lines.
    const conn = focused()
    const filtered = filteredLog()
    const header = [
      `# NovaClaw client error log — ${filtered.length} of ${errorLogEntries().length} entries`,
      `# instance: ${conn?.http.url ?? "(none)"}`,
      `# server log (a different file, not included here): ${serverLogPath() ?? "(unknown)"}`,
      levelFilter() ? `# filtered to level: ${levelFilter()}` : undefined,
      logMatch().trim() ? `# filtered to text: ${logMatch().trim()}` : undefined,
    ]
      .filter((line) => line !== undefined)
      .join("\n")
    const text = `${header}\n${filtered.map(logLine).join("\n") || "(empty)"}`
    void navigator.clipboard
      .writeText(text)
      .then(() => showToast({ title: `Copied ${filtered.length} log entr${filtered.length === 1 ? "y" : "ies"}` }))
      .catch(() => showToast({ variant: "error", title: "Copy failed" }))
  }

  // ── the SERVER's log (the half that was blocked) ────────────────────────────────────────────
  //
  // 3f shipped the panel above without server lines and recorded why: the read route's only legal
  // home is `/api/*` (ruling 11 pins the legacy surface shrink-only) and `formatLines` reaches
  // `node:fs`/`node:zlib`, so it can never run here. `POST /api/log/read` is that route.
  //
  // ⭐ **This displays a STRING and never re-derives one.** The response carries `text` and nothing
  // structured — no columns, no line array — so a second formatter beside `formatLines` +
  // `LogRead.project` + the class table is not merely discouraged here, it is unbuildable. That
  // pairing is the *one description existing twice* defect this repo has found repeatedly.
  //
  // ⚠️ **A SEPARATE panel from the Error log above, deliberately.** They are two files written by
  // two processes in two formats — the ring is `{at, level, text}`, the instance writes keyed
  // logfmt. Interleaving them into one list would need exactly the second renderer the paragraph
  // above refuses.
  //
  // ⚠️ **The subsystem filter is FREE TEXT and the vocabulary comes from the instance**, not from a
  // list compiled into this bundle. `packages/app` deliberately does not depend on
  // `@novaclaw/schema` (see `submit-draft-features.test.ts`), and there is a better reason than the
  // dependency: this UI can be driving a REMOTE instance on a different build, so a vocabulary read
  // out of the renderer could disagree with the machine being looked at. The route answers an
  // unknown subsystem with a 400 that NAMES the declared set, and that message is what the panel
  // shows — the instance teaches its own vocabulary.
  const LEVELS = ["debug", "info", "warn", "error"] as const
  const [logTick, setLogTick] = createSignal(0)
  const [serverLevel, setServerLevel] = createSignal<string | undefined>(undefined)
  const [serverPlane, setServerPlane] = createSignal<"local" | "maintenance">("local")
  // Draft vs applied: a keystroke here is an HTTP request and a 4 MB scan on the instance, so the
  // text filters commit on Enter/blur/Refresh rather than on input. The level chips and the plane
  // toggle are discrete acts and apply immediately.
  const [subsystemDraft, setSubsystemDraft] = createSignal("")
  const [matchDraft, setMatchDraft] = createSignal("")
  const [subsystem, setSubsystem] = createSignal("")
  const [match, setMatch] = createSignal("")
  const applyServerFilters = () => {
    setSubsystem(subsystemDraft().trim())
    setMatch(matchDraft().trim())
    setLogTick((t) => t + 1)
  }

  type ServerLog = { ok: true; data: LogReadResult } | { ok: false; message: string }
  const [serverLog] = createResource(
    () => {
      const conn = focused()
      if (!conn) return undefined
      return {
        conn,
        // One key so a change to any filter refetches exactly once.
        key: `${logTick()}|${serverLevel() ?? ""}|${serverPlane()}|${subsystem()}|${match()}`,
      }
    },
    async ({ conn }): Promise<ServerLog> => {
      try {
        const data = await instanceFetch<LogReadResult>(conn.http, {
          method: "POST",
          route: "api/log/read",
          body: {
            ...(serverLevel() === undefined ? {} : { level: serverLevel() }),
            ...(subsystem() ? { subsystem: subsystem() } : {}),
            ...(match() ? { match: match() } : {}),
            plane: serverPlane(),
            limit: 200,
          },
        })
        return { ok: true, data }
      } catch (error) {
        // The instance's own words. A 400 here is not noise — it is the vocabulary ("… is not a
        // subsystem. Subsystems: …") and the repair, which is the whole reason this branch renders
        // the message instead of a generic failure line.
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  /** The answer when there is one, so the JSX below branches on data rather than on a discriminant. */
  const serverLogData = createMemo(() => {
    const state = serverLog()
    return state?.ok === true ? state.data : undefined
  })
  const serverLogError = createMemo(() => {
    const state = serverLog()
    return state?.ok === false ? state.message : undefined
  })

  const copyServerLog = () => {
    const state = serverLog()
    if (!state?.ok) return
    const conn = focused()
    const header = [
      `# NovaClaw instance log — ${state.data.lines} line${state.data.lines === 1 ? "" : "s"} of ${state.data.scanned} examined`,
      `# instance: ${conn?.http.url ?? "(none)"}`,
      `# file: ${serverLogPath() ?? "(unknown)"}`,
      `# plane: ${state.data.plane}${state.data.plane === "maintenance" ? " (local-only columns shown as <class>)" : " (full detail — this has not been filtered for sharing)"}`,
      serverLevel() ? `# level at or above: ${serverLevel()}` : undefined,
      subsystem() ? `# subsystem: ${subsystem()}` : undefined,
      match() ? `# text: ${match()}` : undefined,
      state.data.truncated ? "# the scan ceiling was reached — older history was not examined" : undefined,
    ]
      .filter((line) => line !== undefined)
      .join("\n")
    void navigator.clipboard
      .writeText(`${header}\n${state.data.text || "(no matching lines)"}`)
      .then(() => showToast({ title: `Copied ${state.data.lines} log line${state.data.lines === 1 ? "" : "s"}` }))
      .catch(() => showToast({ variant: "error", title: "Copy failed" }))
  }

  const section = "border-b border-v2-border-border-base"
  const heading = "flex items-center gap-2 px-4 pt-3 pb-2"
  const title = "text-[13px] font-semibold text-v2-text-text-base"
  const hint = "text-[11px] text-v2-text-text-faint"
  const btn =
    "rounded-md px-2.5 py-1 text-xs font-medium text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-02 disabled:pointer-events-none disabled:opacity-40"

  return (
    <AppPage class="flex flex-col overflow-hidden">
      <AppPageHeader dense glyph="debug" title="Debug" hint="diagnostics and recovery" />
      <div class="min-h-0 flex-1 overflow-y-auto">
        {/* ── Connection ─────────────────────────────────────────────────────────────── */}
        <div class={section}>
          <div class={heading}>
            <span class={title}>{language.t("debug.page.connection")}</span>
            <span class={hint}>{language.t("debug.page.sseStreamStatusPerConfiguredServer")}</span>
          </div>
          <div class="px-4 pb-3">
            <Show when={servers().length > 0} fallback={<div class={hint}>no servers configured</div>}>
              <For each={servers()}>
                {(conn) => {
                  const ctx = global.ensureServerCtx(conn)
                  return (
                    <div class="flex items-center gap-3 py-1 text-[12px]">
                      <span class={`w-24 shrink-0 font-medium ${STATUS_TONE[ctx.sdk.streamStatus()]}`}>
                        {ctx.sdk.streamStatus()}
                      </span>
                      <span class="truncate font-mono text-v2-text-text-muted">{conn.http.url}</span>
                      <Show when={focused() === conn}>
                        <span class={hint}>(active)</span>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </Show>
          </div>
        </div>

        {/* ── Optional capabilities ─────────────────────────────────────────────────── */}
        <div class={section} data-panel="capabilities">
          <div class={heading}>
            <span class={title}>{language.t("debug.page.optionalCapabilities")}</span>
            <span class={hint}>live state — looking here does not start anything</span>
            <button class={`${btn} ml-auto`} onClick={() => setCapabilityTick((value) => value + 1)}>
              {language.t("debug.page.refresh")}
            </button>
          </div>
          <div class="px-4 pb-3">
            <Show
              when={capabilityList()}
              fallback={
                <div class={hint}>
                  {capabilityList.loading ? "checking…" : "unavailable (older server, or no instance connected)"}
                </div>
              }
            >
              {(items) => (
                <Show when={items().length > 0} fallback={<div class={hint}>no optional capabilities declared</div>}>
                  <For each={items()}>
                    {(item) => (
                      <div class="border-t border-v2-border-border-base py-2 first:border-t-0 first:pt-0">
                        <div class="flex items-center gap-2 text-[12px]">
                          <span class="font-mono font-medium text-v2-text-text-base">{item.name}</span>
                          <span
                            classList={{
                              "text-v2-state-fg-success": item.status.state === "ready",
                              "text-v2-state-fg-warning": item.status.state === "starting",
                              "text-v2-state-fg-danger": item.status.state === "unavailable",
                              "text-v2-text-text-faint": item.status.state === "idle",
                            }}
                          >
                            {item.status.state === "idle" ? "not used yet" : item.status.state}
                          </span>
                          <Show when={item.status.state === "unavailable"}>
                            <button
                              type="button"
                              class={`${btn} ml-auto`}
                              onClick={() => void retryUnavailableCapability(item.name)}
                            >
                              {language.t("debug.page.tryAgain")}
                            </button>
                          </Show>
                        </div>
                        <Show when={item.status.state === "unavailable" && item.status}>
                          {(status) => {
                            const unavailable = status() as Extract<typeof item.status, { state: "unavailable" }>
                            return (
                              <div class="mt-0.5 text-[11px] text-v2-text-text-muted">
                                <div>{unavailable.reason.summary}</div>
                                <Show when={unavailable.reason.repair?.length}>
                                  <div class={hint}>repairable settings: {unavailable.reason.repair?.join(", ")}</div>
                                </Show>
                                <details class="mt-1">
                                  <summary class="cursor-pointer text-v2-text-text-faint">
                                    {language.t("debug.page.technicalDetail")}
                                  </summary>
                                  <pre class="mt-1 whitespace-pre-wrap break-all font-mono text-v2-text-text-faint">
                                    {unavailable.reason.detail ?? "No additional detail."}
                                  </pre>
                                </details>
                              </div>
                            )
                          }}
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
              )}
            </Show>
          </div>
        </div>

        {/* ── Scheduler ──────────────────────────────────────────────────────────────── */}
        <div class={section} data-panel="plugins">
          <div class={heading}>
            <span class={title}>Loaded plugins</span>
            <span class={hint}>what each one DECLARES it needs — a claim, not a granted permission</span>
          </div>
          <div class="px-4 pb-3">
            <Show
              when={pluginList()}
              fallback={
                <div class={hint}>
                  {pluginList.loading
                    ? "checking…"
                    : pluginList.failed
                      ? "could not be read — this is NOT the same as no plugins being loaded"
                      : "no instance connected"}
                </div>
              }
            >
              {(items) => (
                <Show when={items().length > 0} fallback={<div class={hint}>no plugins loaded</div>}>
                  <For each={items()}>
                    {(item) => (
                      <div class="border-t border-v2-border-border-base py-2 first:border-t-0 first:pt-0">
                        <div class="flex items-center gap-2 text-[12px]">
                          <span class="font-mono font-medium text-v2-text-text-base">{item.id}</span>
                          <span
                            classList={{
                              "text-v2-state-fg-warning": item.source === "external",
                              "text-v2-text-text-faint": item.source === "internal",
                            }}
                          >
                            {item.source === "external" ? "third-party" : "built in"}
                          </span>
                        </div>
                        <div class={`${hint} mt-0.5 font-mono`}>
                          {/* Three DISTINCT states, never collapsed: an external plugin that declared
                              nothing is not the same as one that declared it needs nothing, and a
                              built-in's declaration is checked against its source by a core guard
                              while an external one is only ever a claim. */}
                          {item.capabilities === undefined
                            ? "declared nothing"
                            : item.capabilities.length === 0
                              ? "declares it needs nothing"
                              : item.capabilities.join(", ")}
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              )}
            </Show>
          </div>
        </div>

        <div class={section} data-panel="scheduler">
          <div class={heading}>
            <span class={title}>{language.t("debug.page.scheduler")}</span>
            <span class={hint}>live EEVDF state per device — in-flight, waiting, and the fair-share ledger</span>
            <button class={`${btn} ml-auto`} onClick={() => setSchedTick((t) => t + 1)}>
              {language.t("debug.page.refresh")}
            </button>
          </div>
          <div class="px-4 pb-3">
            <Show
              when={scheduler()}
              fallback={
                <div class={hint}>
                  {scheduler.loading ? "loading…" : "unavailable (older server, or no instance connected)"}
                </div>
              }
            >
              {(devices) => (
                <Show
                  when={devices().length > 0}
                  fallback={<div class={hint}>idle — no device has run a turn yet this process</div>}
                >
                  <For each={devices()}>
                    {(device) => (
                      <div class="py-1.5">
                        <div class="flex items-center gap-2 text-[12px]">
                          <span class="font-mono font-medium text-v2-text-text-base">{device.deviceKey}</span>
                          <span class={hint}>
                            {device.inFlightInteractive.length + device.inFlightBatch.length} in flight ·{" "}
                            {device.waiting.length} waiting
                          </span>
                        </div>
                        <Show when={device.waiting.length > 0}>
                          {/* Queued sessions reflect scheduler policy or configured capacity, not a hardware limit. */}
                          <div class="text-[11px] text-v2-state-fg-warning">queued: {device.waiting.join(", ")}</div>
                        </Show>
                        <For each={device.ledger}>
                          {(entry) => (
                            <div class="flex gap-3 py-0.5 font-mono text-[11px] text-v2-text-text-muted">
                              <span class="truncate">{entry.id}</span>
                              <span class="ml-auto shrink-0">w{entry.weight}</span>
                              <span class="shrink-0">{entry.sliceTokens} tok</span>
                              <span class="shrink-0">lag {entry.lag.toFixed(1)}</span>
                              <span class="shrink-0">vd {entry.vdeadline.toFixed(1)}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </Show>
              )}
            </Show>
          </div>
        </div>

        {/* ── Context findings ──────────────────────────────────────────────────────── */}
        <div class={section} data-panel="context-findings">
          <div class={heading}>
            <span class={title}>{language.t("debug.page.contextFindings")}</span>
            <span class={hint}>what shaped recent turns — concrete findings, never a mystery score</span>
            <button type="button" class={`${btn} ml-auto`} onClick={() => void refetchContext()}>
              {language.t("debug.page.refresh")}
            </button>
          </div>
          <div class="px-4 pb-3">
            <Show when={contextSession()} fallback={<div class={hint}>no cached session to inspect</div>}>
              {(row) => (
                <>
                  <div class="mb-2 flex items-center gap-2 text-[11px]">
                    <span class={hint}>latest cached session</span>
                    <A href={row().href} class="max-w-96 truncate text-v2-text-text-muted hover:underline">
                      {row().title || row().id}
                    </A>
                  </div>
                  <Show
                    when={packedTurns().length > 0}
                    fallback={
                      <div class={hint}>
                        {contextLoad.loading
                          ? "loading packed turns…"
                          : "no packed turns recorded yet — the next completed turn will appear here"}
                      </div>
                    }
                  >
                    <For each={packedTurns()}>
                      {(message) => (
                        <div class="border-t border-v2-border-border-base py-2 first:border-t-0 first:pt-0">
                          <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-v2-text-text-faint">
                            <span>
                              {Timestamp.toDate(message.time.completed ?? message.time.created)?.toLocaleString() ??
                                "—"}
                            </span>
                            <span>
                              {formatContextTokens(message.context.estimatedTokens)} /{" "}
                              {formatContextTokens(message.context.window)} tokens
                            </span>
                            <Show when={message.context.droppedMessages > 0}>
                              <span class="text-v2-state-fg-warning">
                                {message.context.droppedMessages} older message
                                {message.context.droppedMessages === 1 ? "" : "s"} left out
                              </span>
                            </Show>
                            <Show when={message.context.elidedOutputs > 0}>
                              <span>{message.context.elidedOutputs} repeated output folded</span>
                            </Show>
                          </div>
                          <Show
                            when={message.context.findings.length > 0}
                            fallback={
                              <div class={`${hint} pt-1`}>
                                {language.t("debug.page.noDuplicateOrDominantToolOutput")}
                              </div>
                            }
                          >
                            <ul class="list-disc space-y-0.5 pl-4 pt-1 text-[12px] text-v2-text-text-muted">
                              <For each={message.context.findings}>
                                {(finding) => <li>{formatContextFinding(finding)}</li>}
                              </For>
                            </ul>
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>
                </>
              )}
            </Show>
          </div>
        </div>

        {/* ── Error log ──────────────────────────────────────────────────────────────── */}
        <div class={section} data-panel="error-log">
          <div class={heading}>
            <span class={title}>{language.t("debug.page.errorLog")}</span>
            <span class={hint}>
              this UI's own uncaught errors, rejections, console error/warn and subsystem notices — newest first, last{" "}
              {200} kept
            </span>
            <span class="flex-1" />
            <button type="button" class={btn} onClick={copyLog} disabled={filteredLog().length === 0}>
              <Icon name="copy" size="normal" class="mr-1 inline-block align-[-2px]" />
              {language.t("debug.page.copy")}
            </button>
            <button type="button" class={btn} onClick={clearErrorLog} disabled={errorLogEntries().length === 0}>
              {language.t("debug.page.clear")}
            </button>
          </div>
          {/* ⚠️ Naming the OTHER file is the point of this line, not decoration. Someone reading
              "Error log" in the Debug app and seeing no server faults would reasonably conclude the
              server had none — this panel is the renderer's ring buffer and the instance writes a
              separate, keyed, rotated `novaclaw.log`, read by the Instance log panel below. The path
              comes from `GET /instance`, never from guessing (§0.6). */}
          <div class={`${hint} px-4 pb-2`} data-slot="debug-server-log-note">
            The instance's own log is a different file, shown below:{" "}
            <code class="select-all font-mono">{serverLogPath() ?? "(ask the instance — not connected)"}</code>
          </div>
          {/* Filters (3f). The levels come from what is actually IN the ring with their counts,
              rather than from a hard-coded list — a level nobody produced is not a useful chip, and
              a level somebody adds to `error-log.ts` appears here without a second edit. */}
          <div class="flex flex-wrap items-center gap-1.5 px-4 pb-2" data-slot="debug-log-filters">
            <button
              type="button"
              class={btn}
              classList={{ "bg-v2-background-bg-layer-02 text-v2-text-text-base": levelFilter() === undefined }}
              onClick={() => setLevelFilter(undefined)}
            >
              all {errorLogEntries().length}
            </button>
            <For each={logCounts()}>
              {([level, count]) => (
                <button
                  type="button"
                  class={btn}
                  classList={{ "bg-v2-background-bg-layer-02 text-v2-text-text-base": levelFilter() === level }}
                  onClick={() => setLevelFilter(levelFilter() === level ? undefined : level)}
                >
                  {level} {count}
                </button>
              )}
            </For>
            <input
              type="search"
              class="ml-auto min-w-0 rounded-md border border-v2-border-border-base bg-transparent px-2 py-1 text-[11px] text-v2-text-text-base placeholder:text-v2-text-text-faint"
              placeholder={language.t("debug.page.filterText")}
              aria-label={language.t("debug.page.filterTheErrorLogByText")}
              data-slot="debug-log-match"
              value={logMatch()}
              onInput={(event) => setLogMatch(event.currentTarget.value)}
            />
          </div>
          <div class="max-h-72 overflow-y-auto px-4 pb-3">
            <Show
              when={filteredLog().length > 0}
              fallback={
                <div class={hint} data-slot="debug-log-empty">
                  {errorLogEntries().length === 0
                    ? "nothing captured this session"
                    : `no entries match — ${errorLogEntries().length} hidden by the filter`}
                </div>
              }
            >
              <For each={[...filteredLog()].reverse()}>
                {(entry) => (
                  <div class="flex gap-2 py-0.5 text-[11px] leading-4">
                    <span class="shrink-0 tabular-nums text-v2-text-text-faint">
                      {Timestamp.toDate(entry.at)?.toLocaleTimeString() ?? "—"}
                    </span>
                    <span
                      class="w-14 shrink-0 font-medium"
                      classList={{
                        "text-v2-state-fg-danger": entry.level === "error" || entry.level === "uncaught",
                        "text-v2-state-fg-warning": entry.level === "warn",
                        "text-v2-text-text-muted": entry.level === "rejection",
                        // A notice is NOT a fault in the user's install — it is one of our own
                        // subsystems reporting something worth recording (a missing changelog file
                        // on our CDN, say). Without an entry here it renders in the inherited body
                        // colour, which reads as a styling bug rather than as the quietest level.
                        "text-v2-text-text-faint": entry.level === "notice",
                      }}
                    >
                      {entry.level}
                    </span>
                    <span class="min-w-0 whitespace-pre-wrap break-all font-mono text-v2-text-text-muted">
                      {entry.text}
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>

        {/* ── Instance log (the server half) ─────────────────────────────────────────── */}
        <div class={section} data-panel="server-log">
          <div class={heading}>
            <span class={title}>{language.t("debug.page.instanceLog")}</span>
            <span class={hint}>
              what the OS itself did — keyed, rotated, and read from the instance rather than from this UI
            </span>
            <span class="flex-1" />
            <button type="button" class={btn} onClick={copyServerLog} disabled={(serverLogData()?.lines ?? 0) === 0}>
              <Icon name="copy" size="normal" class="mr-1 inline-block align-[-2px]" />
              {language.t("debug.page.copy")}
            </button>
            <button type="button" class={btn} onClick={applyServerFilters}>
              {language.t("debug.page.refresh")}
            </button>
          </div>
          <div class="flex flex-wrap items-center gap-1.5 px-4 pb-2" data-slot="server-log-filters">
            <button
              type="button"
              class={btn}
              classList={{ "bg-v2-background-bg-layer-02 text-v2-text-text-base": serverLevel() === undefined }}
              onClick={() => setServerLevel(undefined)}
            >
              all levels
            </button>
            {/* A FLOOR, unlike the client ring's chips above: the wire's four levels ARE a severity
                scale, so "warn" meaning "warnings and errors" is what every reader expects. The
                names are the request schema's closed union — send one the instance does not know
                and it answers a 400 that this panel shows, so a drift is loud rather than silent. */}
            <For each={LEVELS}>
              {(level) => (
                <button
                  type="button"
                  class={btn}
                  classList={{ "bg-v2-background-bg-layer-02 text-v2-text-text-base": serverLevel() === level }}
                  onClick={() => setServerLevel(serverLevel() === level ? undefined : level)}
                >
                  {level}+
                </button>
              )}
            </For>
            <input
              type="search"
              class="min-w-0 rounded-md border border-v2-border-border-base bg-transparent px-2 py-1 text-[11px] text-v2-text-text-base placeholder:text-v2-text-text-faint"
              placeholder="subsystem…"
              aria-label={language.t("debug.page.filterTheInstanceLogBySubsystem")}
              data-slot="server-log-subsystem"
              value={subsystemDraft()}
              onInput={(event) => setSubsystemDraft(event.currentTarget.value)}
              onChange={applyServerFilters}
              onKeyDown={(event) => event.key === "Enter" && applyServerFilters()}
            />
            <input
              type="search"
              class="min-w-0 flex-1 rounded-md border border-v2-border-border-base bg-transparent px-2 py-1 text-[11px] text-v2-text-text-base placeholder:text-v2-text-text-faint"
              placeholder={language.t("debug.page.textInTheLinePressEnter")}
              aria-label={language.t("debug.page.filterTheInstanceLogByText")}
              data-slot="server-log-match"
              value={matchDraft()}
              onInput={(event) => setMatchDraft(event.currentTarget.value)}
              onChange={applyServerFilters}
              onKeyDown={(event) => event.key === "Enter" && applyServerFilters()}
            />
          </div>
          {/* The two planes, in the user's words rather than in ours. AGENTS.md principle 4: the
              data plane never egresses and the maintenance plane is scrubbed — so the toggle is
              "what you are looking at" vs "what you would send", never "safe/unsafe". Withheld
              columns are NAMED as `‹class›` by the server; nothing is silently dropped. */}
          <div class="flex flex-wrap items-center gap-1.5 px-4 pb-2" data-slot="server-log-plane">
            <button
              type="button"
              class={btn}
              classList={{ "bg-v2-background-bg-layer-02 text-v2-text-text-base": serverPlane() === "local" }}
              onClick={() => setServerPlane("local")}
            >
              {language.t("debug.page.fullDetail")}
            </button>
            <button
              type="button"
              class={btn}
              classList={{ "bg-v2-background-bg-layer-02 text-v2-text-text-base": serverPlane() === "maintenance" }}
              onClick={() => setServerPlane("maintenance")}
            >
              {language.t("debug.page.readyToSendOnward")}
            </button>
            <span class={hint}>
              {serverPlane() === "local"
                ? "everything the log holds — this stays on your computer"
                : "columns that may not leave this machine are shown as ‹their kind›, never dropped"}
            </span>
          </div>
          <div class="max-h-72 overflow-y-auto px-4 pb-3">
            <Show
              when={serverLog()}
              fallback={
                <div class={hint} data-slot="server-log-empty">
                  {serverLog.loading ? "reading the instance log…" : "no instance connected"}
                </div>
              }
            >
              <Show
                when={serverLogData()}
                fallback={
                  <div class="text-[11px] text-v2-state-fg-danger" data-slot="server-log-error">
                    {serverLogError()}
                  </div>
                }
              >
                {(data) => (
                  <Show
                    when={data().lines > 0}
                    fallback={
                      // Two different facts, and only one of them is about the instance:
                      // `scanned === 0` means there is no log file to read yet.
                      <div class={hint} data-slot="server-log-empty">
                        {data().scanned === 0
                          ? `no log file yet under ${serverLogPath() ?? "the instance's log directory"}`
                          : `no line matches — ${data().scanned} examined`}
                      </div>
                    }
                  >
                    {/* ⭐ The server's string, displayed. Not parsed, not re-rendered, not
                          re-coloured per column — there is one renderer of a log line and it ran
                          on the instance. */}
                    <pre
                      class="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-4 text-v2-text-text-muted"
                      data-slot="server-log-text"
                    >
                      {data().text}
                    </pre>
                    <div class={hint} data-slot="server-log-status">
                      {data().lines} line{data().lines === 1 ? "" : "s"} of {data().scanned} examined
                      {data().truncated ? " · scan ceiling reached, older history not examined" : ""}
                    </div>
                  </Show>
                )}
              </Show>
            </Show>
          </div>
        </div>

        {/* ── Sessions (ps) ───────────────────────────────────────────────────────────── */}
        <div class={section}>
          <div class={heading}>
            <span class={title}>{language.t("debug.page.sessions")}</span>
            {/* Naming the scope is the honest move, the same way the log panel says whose ring it
                shows: presence answers for THIS instance's own sessions and is not a directory of
                who is online — a developer view does not widen that. The rows themselves come from
                the instance's cursor-paginated roster, not this browser's bounded event cache. */}
            <span class={hint}>
              durable execution, recovery and attendance state for {sessions().length} session
              {sessions().length === 1 ? "" : "s"} on this instance
            </span>
            <button
              class="ml-auto text-[11px] text-v2-text-text-muted hover:underline"
              onClick={() => {
                setProcessRosterRefresh((v) => v + 1)
                setExecutionTick((v) => v + 1)
                refreshPresence()
              }}
            >
              {language.t("debug.page.refresh")}
            </button>
          </div>
          {/* overflow-x too: seven columns outgrow a narrow window, and a table that spills past
              the viewport drags the whole page wide instead of scrolling inside its panel. */}
          <div class="max-h-72 overflow-y-auto overflow-x-auto px-4 pb-3">
            <Show
              when={!processRoster.failed}
              fallback={
                <div class="text-[11px] text-v2-state-fg-danger">could not read the instance session roster</div>
              }
            >
              <Show
                when={!processRoster.loading && sessions().length > 0}
                fallback={
                  <div class={hint}>
                    {processRoster.loading ? "reading the instance session roster…" : "no sessions"}
                  </div>
                }
              >
                <table class="w-full border-collapse text-[11px]">
                  <thead>
                    <tr class="text-left text-v2-text-text-faint">
                      <th class="py-1 pr-2 font-medium">id</th>
                      <th class="py-1 pr-2 font-medium">status</th>
                      <th class="py-1 pr-2 font-medium">presence</th>
                      <th class="py-1 pr-2 font-medium">phase / recovery</th>
                      <th class="py-1 pr-2 font-medium">agent</th>
                      <th class="py-1 pr-2 font-medium">model</th>
                      <th class="py-1 pr-2 font-medium">tokens</th>
                      <th class="py-1 pr-2 font-medium">parent</th>
                      <th class="py-1 font-medium">title</th>
                      <th class="py-1 font-medium">actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={sessions()}>
                      {(row) => (
                        <tr class="align-top">
                          <td class="py-0.5 pr-2 font-mono">
                            <A href={row.href} class="text-v2-text-text-muted hover:underline">
                              {row.id}
                            </A>
                          </td>
                          <td
                            class="py-0.5 pr-2"
                            classList={{
                              "text-v2-state-fg-success": ["busy", "retry"].includes(row.status),
                              "text-v2-text-text-faint": ["idle", "exited"].includes(row.status),
                            }}
                          >
                            {executionBySession()[row.id]?.state ?? row.status}
                          </td>
                          {/* Attendance, composed with the status column's busy signal. The ids ride
                            the tooltip because two windows of one browser are honestly both "a
                            browser window" and only the opaque per-surface id separates them. */}
                          <td class="max-w-72 py-0.5 pr-2">
                            {(() => {
                              const cell = presenceFor(row.id, row.busy)
                              return (
                                <span
                                  data-slot="debug-session-presence"
                                  data-session={row.id}
                                  data-attached={String(cell.attached)}
                                  data-unverified={cell.unverified ? "true" : "false"}
                                  class={cell.attached > 0 ? "text-v2-text-text-muted" : "text-v2-text-text-faint"}
                                  title={cell.title}
                                >
                                  {cell.text}
                                </span>
                              )
                            })()}
                          </td>
                          <td class="max-w-72 py-0.5 pr-2 text-v2-text-text-muted">
                            <Show when={executionBySession()[row.id]} fallback="—">
                              {(attempt) => (
                                <span title={attempt().failureDetail}>
                                  {attempt().phase}
                                  {attempt().failureClass ? ` · ${attempt().failureClass}` : ""}
                                  {attempt().toolName
                                    ? ` · ${attempt().toolName} (${attempt().toolSideEffect}, ${attempt().toolState})`
                                    : ""}
                                  {attempt().failureCount
                                    ? ` · ${attempt().failureCount} failure${attempt().failureCount === 1 ? "" : "s"}`
                                    : ""}
                                </span>
                              )}
                            </Show>
                          </td>
                          <td class="py-0.5 pr-2 text-v2-text-text-muted">{row.agent}</td>
                          <td class="py-0.5 pr-2 font-mono text-v2-text-text-faint">
                            {row.model ? `${row.model.providerID}/${row.model.id}` : "inherit"}
                          </td>
                          <td class="py-0.5 pr-2 font-mono text-v2-text-text-faint">
                            {row.tokens.input + row.tokens.output + row.tokens.reasoning}
                          </td>
                          <td class="py-0.5 pr-2 font-mono text-v2-text-text-faint">{row.parentID ?? "—"}</td>
                          <td class="max-w-64 truncate py-0.5 text-v2-text-text-muted">{row.title}</td>
                          <td class="whitespace-nowrap py-0.5 text-v2-text-text-muted">
                            <Show
                              when={["paused", "failed", "interrupted"].includes(
                                executionBySession()[row.id]?.state ?? "",
                              )}
                            >
                              <button class="mr-2 hover:underline" onClick={() => void actOnExecution("retry", row.id)}>
                                {language.t("debug.page.retry")}
                              </button>
                            </Show>
                            <Show
                              when={["starting", "busy", "recovering"].includes(
                                executionBySession()[row.id]?.state ?? "",
                              )}
                            >
                              <button class="mr-2 hover:underline" onClick={() => void actOnExecution("stop", row.id)}>
                                {language.t("debug.page.stop")}
                              </button>
                            </Show>
                            <button class="hover:underline" onClick={showModels}>
                              {language.t("debug.page.models")}
                            </button>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
            </Show>
            {/* A room outlives the session row when the session is deleted (or was never cached
                here) while a surface was attached. The table is driven by the session list, so
                those rooms would be invisible — and a diagnostic panel that silently drops state is
                the thing it exists to prevent. Reported, never faked into a session row. */}
            <Show when={debugPresenceOrphanText(presenceOrphans(), presenceUnverified())}>
              {(text) => (
                <div class={hint} data-slot="debug-presence-orphans">
                  {text()}
                </div>
              )}
            </Show>
          </div>
        </div>

        {/* ── Config snapshot ────────────────────────────────────────────────────────── */}
        <div>
          <div class={heading}>
            <span class={title}>{language.t("debug.page.configSnapshot")}</span>
            <span class={hint}>the active server's resolved config (read-only — edit in Settings)</span>
          </div>
          <pre class="overflow-x-auto px-4 pb-4 font-mono text-[11px] leading-4 text-v2-text-text-muted">
            {config()}
          </pre>
        </div>
      </div>
    </AppPage>
  )
}
