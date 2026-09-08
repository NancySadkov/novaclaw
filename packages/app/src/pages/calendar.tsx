import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useLanguage } from "@/context/language"
import { fireStatusLabel } from "./calendar-status"
import { Icon } from "@novaclaw/ui/v2/icon"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { useServerSDK } from "@/context/server-sdk"
import { useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { roster, type AgentLike } from "@/apps/contacts"
import { useDirectoryPicker } from "@/components/directory-picker"
import {
  createSchedule,
  listFires,
  listSchedules,
  removeSchedule,
  updateSchedule,
  type Fire,
  type Recurrence,
  type Schedule,
} from "@/utils/calendar-api"
import { AppPage, AppPageHeader } from "@/components/app-page"
import { scopedDirectory } from "@/utils/routing-directory"
import { createSettledResource } from "@/utils/settled-resource"
import { createListState } from "@/utils/list-state"
import { ControlScope } from "@/components/control-scope"
import * as Timestamp from "@novaclaw/schema/time"

// Calendar app: the home tile's page. Shows the live date/time, the next
// scheduled run, the list of schedules with their next-fire, and a form to add one. Data comes from the
// /api/calendar/schedule endpoints via the raw-fetch calendar-api client. Schedules are
// instance-global; writes also route through the current server-side directory so the instance can
// validate unpinned agent/model choices against the right ambient catalog.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const RECURRENCE_KINDS: Recurrence["kind"][] = ["once", "daily", "weekly", "monthly", "yearly"]

// Plain-language permission postures for an UNATTENDED scheduled run. Default "bypass" = act on anything
// inside the work folder (external-directory writes still gate); "ask" stalls (no human to approve).
const PERMISSION_MODES: { value: string; label: string }[] = [
  { value: "bypass", label: "Act within its folder (recommended)" },
  { value: "", label: "Whatever the colleague is allowed" },
  { value: "surgical", label: "Edit files, no full rewrites" },
  { value: "plan", label: "Read-only (no file changes)" },
  { value: "ask", label: "Ask each time (needs you watching)" },
  { value: "yolo", label: "Unrestricted (incl. outside the folder)" },
]

const pad = (n: number) => String(n).padStart(2, "0")
const hm = (t: { hour: number; minute: number }) => `${pad(t.hour)}:${pad(t.minute)}`
const datetimeLocal = (ms: number) => {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const localeDateTime = (value: unknown) => Timestamp.toDate(value)?.toLocaleString() ?? "—"

/** Preserve the draft text until submit, then accept only a real calendar day. */
export function calendarDay(raw: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 31) throw new Error("Choose a whole day from 1 to 31")
  return value
}

function describeRecurrence(r: Recurrence): string {
  switch (r.kind) {
    case "once":
      return `Once — ${localeDateTime(r.at)}`
    case "daily":
      return `Every day at ${hm(r.time)}`
    case "weekly":
      return `Weekly on ${[...r.weekdays]
        .sort()
        .map((d) => WEEKDAYS[d] ?? d)
        .join(", ")} at ${hm(r.time)}`
    case "monthly":
      return `Monthly on day ${r.day} at ${hm(r.time)}`
    case "yearly":
      return `Every year on ${MONTHS[r.month - 1] ?? r.month} ${r.day} at ${hm(r.time)}`
  }
}

function relative(value: unknown, now: number): string {
  const ms = Timestamp.toEpochMillis(value)
  if (ms === undefined) return "time unknown"
  const d = ms - now
  if (d <= 0) return "due now"
  const s = Math.round(d / 1000)
  if (s < 60) return `in ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `in ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `in ${h}h ${m % 60}m`
  const days = Math.floor(h / 24)
  return `in ${days}d ${h % 24}h`
}

const FIELD =
  "rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2.5 py-1.5 text-sm text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
const BTN =
  "rounded-md border border-v2-border-border-strong bg-v2-background-bg-layer-02 px-3 py-1.5 text-sm font-medium outline-none hover:bg-v2-background-bg-layer-03 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-border-border-focus disabled:opacity-50"
const CARD = "rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-4"

export function CalendarPage() {
  const language = useLanguage()
  let editor: HTMLFormElement | undefined
  const sdk = useServerSDK()
  const httpBase = createMemo(() => sdk()?.server?.http)

  // The folder browser reuses the app's directory picker (browses the SERVER host's filesystem — where the
  // scheduled agent actually runs, not the client). Same hook the "new agent" folder chip uses.
  const server = useServer()
  const conn = createMemo(() => server.current)
  const pickDirectory = useDirectoryPicker()

  // WHO is responsible for a scheduled task (owner, 2026-08-21: *"the calendar / schedule should have
  // a model responsible for each task, defaulting to the Nova itself"*).
  //
  // 🔴 **A picker, not a text box.** Typing an agent name meant a typo produced a schedule that fires
  // for months into a colleague who does not exist — and the fallback made that failure invisible,
  // because the run still happened, just under the instance default. A task nobody is named on is
  // Nova's: the CEO routes work it does not do itself, and every scheduled run then lands in a chat
  // the user can find on the roster.
  const global = useGlobal()
  const rosterCtx = createMemo(() => {
    const current = conn()
    return current ? global.ensureServerCtx(current) : undefined
  })
  const routingDirectory = createMemo(() => {
    const path = rosterCtx()?.sync.data.path
    return scopedDirectory(path)
  })
  /**
   * 🔴 **A disabled control that gives no reason is a broken form.**
   *
   * Add task, Pause and Resume all need a directory to route their write, and `routingDirectory()`
   * is `""` both while `GET /path` is still in flight and if it never lands — so three controls
   * greyed themselves out with nothing on screen to say why, and the only reading available to the
   * user was *"this page is broken"*. `debug.tsx` sets the standard: name the capability that is
   * missing, beside the control that needs it.
   *
   * ⚠️ Two sentences, because they are two situations and only one of them is the user's to fix. No
   * connection at all is a different problem from a connected instance that has not yet said which
   * folder it works in.
   *
   * ⚠️ The controls stay DISABLED rather than firing and failing. The write genuinely cannot be
   * routed, and a button that submits into an early `return` is the silent-failure half of ruling 2
   * — worse than a disabled one, not better. What was missing was never the button; it was the
   * sentence. Delete (`del`) is deliberately not gated on this and stays live.
   */
  const directoryProblem = createMemo(() => {
    if (routingDirectory()) return ""
    if (!conn()) return "Not connected to an instance, so scheduled tasks cannot be added or paused from here."
    return (
      "Waiting for this instance to say which folder it works in — Add task, Pause and Resume need it" +
      " and stay disabled until it answers."
    )
  })
  // 🔴 The server context's ONE shared roster (review D8), not a second `listAgents` resource.
  // Two reasons, and the first is the severe one: a rejected `createResource` read from an eager memo
  // reaches the root ErrorBoundary, so a single failed roster fetch replaced the WHOLE UI with the
  // error page. `ctx.agents` already carries the `.catch` that call site was missing. The second is
  // that a second fetch is a second answer — this page and Contacts could disagree about who exists,
  // which is precisely what "one roster, one loader" exists to prevent.
  const agentRows = () => rosterCtx()?.agents.list()
  /** How a schedule's owner reads in the list: the colleague's display name, Nova when unowned. */
  const responsibleName = (id: string | null): string => {
    const wanted = id && id.trim() !== "" ? id : "nova"
    return agentOptions().find((option) => option.id === wanted)?.name ?? wanted
  }
  const agentOptions = createMemo(() =>
    roster(agentRows() ?? []).map((view) => {
      const configured = (agentRows() ?? []).find((row: AgentLike) => row.id === view.id)?.config?.["directory"]
      const folder = typeof configured === "string" && configured.trim() !== "" ? configured : undefined
      return { id: view.id, name: view.name, folder }
    }),
  )

  // Live clock — bump every second; refresh the list every 10s so next/last-fire stays current.
  const [now, setNow] = createSignal(Date.now())

  /**
   * 🔴 **The sharpest instance of the whole class, and the reason it is not merely a wrong word.**
   * Both reads folded a failed fetch into `[]`, and the list below renders `[]` as *"No tasks yet —
   * add one below."* The schedules are **still firing** server-side while that sentence is on
   * screen, so it is not a false statement, it is an INVITATION to create them a second time and
   * have every unattended run happen twice.
   *
   * ⚠️ `initialValue: []` was doing the opposite of what it looked like. It sets Solid's `resolved`
   * flag before anything is asked, so the page was `"ready"` with an empty list on a cold client —
   * and it does not make `.latest` safe either, which is what made the pattern spread.
   */
  const [scheduleRows, { refetch }] = createSettledResource(
    () => httpBase(),
    (base) => listSchedules(base),
  )
  const schedules = (): Schedule[] => scheduleRows() ?? []
  const scheduleListing = createListState<Schedule>(scheduleRows)

  const [fireRows, { refetch: refetchFires }] = createSettledResource(
    () => httpBase(),
    (base) => listFires(base),
  )
  const fires = (): Fire[] => fireRows() ?? []
  const fireListing = createListState<Fire>(fireRows)

  onMount(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(() => {
      void refetch()
      void refetchFires()
    }, 10_000)
    onCleanup(() => {
      clearInterval(clock)
      clearInterval(poll)
    })
  })

  const titleFor = (scheduleId: string) => schedules().find((s) => s.id === scheduleId)?.title || "Untitled task"

  const upcoming = createMemo(() =>
    schedules()
      .filter((s) => s.enabled && s.nextFireAt !== null)
      .sort(
        (a, b) =>
          (Timestamp.toEpochMillis(a.nextFireAt) ?? Number.POSITIVE_INFINITY) -
          (Timestamp.toEpochMillis(b.nextFireAt) ?? Number.POSITIVE_INFINITY),
      ),
  )
  const nextUp = createMemo(() => upcoming()[0])

  // ---- Create/edit form state ----
  const [editingID, setEditingID] = createSignal<string | undefined>()
  const [title, setTitle] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [kind, setKind] = createSignal<Recurrence["kind"]>("daily")
  const [time, setTime] = createSignal("09:00")
  const [onceAt, setOnceAt] = createSignal("")
  const [weekdays, setWeekdays] = createSignal<number[]>([1])
  const [monthDay, setMonthDay] = createSignal("1")
  const [yearMonth, setYearMonth] = createSignal(1)
  const [yearDay, setYearDay] = createSignal("1")
  const [agent, setAgent] = createSignal("")
  const [model, setModel] = createSignal("")
  const [folder, setFolder] = createSignal("")
  const [permission, setPermission] = createSignal("bypass")
  const [tzOffsetMin, setTzOffsetMin] = createSignal(-new Date().getTimezoneOffset())
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()

  const toggleWeekday = (d: number) => setWeekdays((ws) => (ws.includes(d) ? ws.filter((x) => x !== d) : [...ws, d]))

  function resetEditor() {
    setEditingID(undefined)
    setTitle("")
    setPrompt("")
    setKind("daily")
    setTime("09:00")
    setOnceAt("")
    setWeekdays([1])
    setMonthDay("1")
    setYearMonth(1)
    setYearDay("1")
    setAgent("")
    setModel("")
    setFolder("")
    setPermission("bypass")
    setTzOffsetMin(-new Date().getTimezoneOffset())
  }

  function edit(schedule: Schedule) {
    setEditingID(schedule.id)
    setTitle(schedule.title)
    setPrompt(schedule.prompt)
    setKind(schedule.recurrence.kind)
    setAgent(schedule.agent ?? "")
    setModel(schedule.model ?? "")
    setFolder(schedule.location ?? "")
    setPermission(schedule.permissionMode ?? "")
    setTzOffsetMin(schedule.tzOffsetMin)
    switch (schedule.recurrence.kind) {
      case "once":
        setOnceAt(datetimeLocal(schedule.recurrence.at))
        break
      case "daily":
        setTime(hm(schedule.recurrence.time))
        break
      case "weekly":
        setTime(hm(schedule.recurrence.time))
        setWeekdays([...schedule.recurrence.weekdays])
        break
      case "monthly":
        setTime(hm(schedule.recurrence.time))
        setMonthDay(String(schedule.recurrence.day))
        break
      case "yearly":
        setTime(hm(schedule.recurrence.time))
        setYearMonth(schedule.recurrence.month)
        setYearDay(String(schedule.recurrence.day))
        break
    }
    queueMicrotask(() => editor?.scrollIntoView({ block: "nearest" }))
  }

  function buildRecurrence(): Recurrence {
    const [hh, mm] = time()
      .split(":")
      .map((n) => Number(n))
    const t = { hour: hh || 0, minute: mm || 0 }
    switch (kind()) {
      case "once":
        return { kind: "once", at: new Date(onceAt()).getTime() }
      case "weekly":
        return { kind: "weekly", time: t, weekdays: weekdays() }
      case "monthly":
        return { kind: "monthly", time: t, day: calendarDay(monthDay()) }
      case "yearly":
        return { kind: "yearly", time: t, month: yearMonth(), day: calendarDay(yearDay()) }
      case "daily":
      default:
        return { kind: "daily", time: t }
    }
  }

  async function submit(e: Event) {
    e.preventDefault()
    const base = httpBase()
    const directory = routingDirectory()
    if (!base || !directory) return
    setBusy(true)
    setError(undefined)
    try {
      const rec = buildRecurrence()
      if (rec.kind === "once" && Number.isNaN(rec.at)) throw new Error("Pick a date and time")
      if (rec.kind === "weekly" && rec.weekdays.length === 0) throw new Error("Pick at least one weekday")
      if (!prompt().trim()) throw new Error("Enter a prompt for the agent to run")
      const id = editingID()
      const common = {
        prompt: prompt().trim(),
        recurrence: rec,
        tzOffsetMin: tzOffsetMin(),
      }
      if (id) {
        await updateSchedule(base, directory, id, {
          ...common,
          title: title().trim(),
          agent: agent().trim() || null,
          model: model().trim() || null,
          location: folder().trim() || null,
          permissionMode: permission() || null,
        })
      } else {
        await createSchedule(base, directory, {
          ...common,
          title: title().trim() || undefined,
          agent: agent().trim() || undefined,
          model: model().trim() || undefined,
          location: folder().trim() || undefined,
          permissionMode: permission() || undefined,
        })
      }
      resetEditor()
      await refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** Pause/resume. Disabling clears next_fire_at server-side; enabling recomputes it from now. */
  async function toggle(s: Schedule) {
    const base = httpBase()
    const directory = routingDirectory()
    if (!base || !directory) return
    try {
      await updateSchedule(base, directory, s.id, { enabled: !s.enabled })
      await refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function del(id: string) {
    const base = httpBase()
    if (!base) return
    try {
      await removeSchedule(base, id)
      if (editingID() === id) resetEditor()
      await refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function pickFolder() {
    const c = conn()
    if (!c) return
    pickDirectory({
      server: c,
      title: "Choose the schedule's work folder",
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) setFolder(directory)
      },
    })
  }

  const clockDate = createMemo(() =>
    new Date(now()).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
  )
  const clockTime = createMemo(() =>
    new Date(now()).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  )

  return (
    <AppPage class="flex flex-col overflow-hidden">
      <AppPageHeader
        glyph="calendar"
        title="Calendar"
        hint="Schedule agents to run on a repeating date — daily, weekly, monthly, or yearly."
      />

      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        {/* Clock + next run */}
        <div class="flex flex-wrap items-center gap-4">
          <div class={`${CARD} flex-1 min-w-[220px]`}>
            <div class="text-xs uppercase tracking-wide text-v2-text-text-faint">{language.t("calendar.page.now")}</div>
            <div class="mt-1 text-2xl font-semibold tabular-nums">{clockTime()}</div>
            <div class="text-sm text-v2-text-text-muted">{clockDate()}</div>
          </div>
          <div class={`${CARD} flex-1 min-w-[220px]`}>
            <div class="text-xs uppercase tracking-wide text-v2-text-text-faint">
              {language.t("calendar.page.nextRun")}
            </div>
            <Show
              when={nextUp()}
              fallback={
                <div class="mt-1 text-sm text-v2-text-text-muted">
                  {language.t("calendar.page.noUpcomingRunsScheduled")}
                </div>
              }
            >
              {(n) => (
                <>
                  <div class="mt-1 truncate text-lg font-semibold">{n().title || "Untitled task"}</div>
                  <div class="text-sm text-v2-text-text-accent">
                    {relative(n().nextFireAt, now())} · {localeDateTime(n().nextFireAt)}
                  </div>
                </>
              )}
            </Show>
          </div>
        </div>

        {/* Schedule list */}
        <div>
          <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-v2-text-text-faint">
            {/* A count is a CLAIM about how many tasks exist. It is withheld until one has arrived,
                because "(0)" over a failed read is the same lie in numerals. */}
            {language.t("calendar.page.scheduledTasks")}
            <Show when={scheduleListing().kind === "loaded" || scheduleListing().kind === "empty"}>
              {" "}
              ({schedules().length})
            </Show>
          </div>
          {/* Beside the Pause/Resume buttons it explains, not only beside the form. */}
          <Show when={directoryProblem()}>
            <div class="mb-2 text-sm text-v2-text-text-muted" data-slot="calendar-directory-problem">
              {directoryProblem()}
            </div>
          </Show>
          <Switch
            fallback={
              <div class="text-sm text-v2-text-text-muted">{language.t("calendar.page.loadingYourScheduledTasks")}</div>
            }
          >
            <Match when={scheduleListing().kind === "failed"}>
              <div class="text-sm text-v2-state-fg-danger" data-slot="calendar-schedules-failed">
                {language.t("calendar.page.couldNotReadYourScheduledTasks")}
              </div>
            </Match>
            <Match when={scheduleListing().kind === "empty"}>
              <div class="text-sm text-v2-text-text-muted" data-slot="calendar-schedules-empty">
                {language.t("calendar.page.noTasksYetAddOneBelow")}
              </div>
            </Match>
            <Match when={scheduleListing().kind === "loaded"}>
              <div class="flex flex-col gap-2">
                <For each={schedules()}>
                  {(s) => (
                    <div class={`${CARD} flex items-start gap-3`}>
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                          <span class="truncate font-medium">{s.title || "Untitled task"}</span>
                          <Show when={!s.enabled}>
                            <span class="rounded bg-v2-background-bg-layer-03 px-1.5 py-0.5 text-[10px] text-v2-text-text-faint">
                              disabled
                            </span>
                          </Show>
                        </div>
                        <div class="mt-0.5 text-xs text-v2-text-text-muted">{describeRecurrence(s.recurrence)}</div>
                        <div class="mt-0.5 truncate text-xs text-v2-text-text-faint">“{s.prompt}”</div>
                        <div class="mt-0.5 truncate text-[11px] text-v2-text-text-faint">
                          {/* WHO first, because that is now the fact that decides the rest: an unnamed
                              task is Nova's, and the colleague supplies the model, the posture and —
                              unless this task overrides it — the folder. */}
                          {responsibleName(s.agent)}
                          {s.location ? ` · folder: ${s.location}` : ""}
                          {s.permissionMode ? ` · access: ${s.permissionMode}` : ""}
                          {s.model ? ` · model: ${s.model}` : ""}
                        </div>
                        <div class="mt-1 text-xs text-v2-text-text-accent">
                          <Show
                            when={s.nextFireAt !== null}
                            fallback={<span class="text-v2-text-text-faint">no next run</span>}
                          >
                            next {relative(s.nextFireAt, now())} · {localeDateTime(s.nextFireAt)}
                          </Show>
                          <Show when={s.lastFiredAt}>
                            <span class="text-v2-text-text-faint"> · last ran {localeDateTime(s.lastFiredAt)}</span>
                          </Show>
                        </div>
                      </div>
                      <button
                        class={BTN}
                        onClick={() => edit(s)}
                        title={language.t("calendar.page.editTask")}
                        aria-pressed={editingID() === s.id}
                      >
                        {language.t("calendar.page.edit")}
                      </button>
                      <button
                        class={BTN}
                        onClick={() => void toggle(s)}
                        title={s.enabled ? "Pause this task" : "Resume this task"}
                        disabled={!routingDirectory()}
                      >
                        {s.enabled ? "Pause" : "Resume"}
                      </button>
                      <button class={BTN} onClick={() => void del(s.id)} title={language.t("calendar.page.deleteTask")}>
                        <Icon name="trash" size="normal" />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Match>
          </Switch>
        </div>

        {/* Recent runs — an unread history is not an empty one, so a failed read says so rather than
            hiding the whole section and implying nothing has ever run. */}
        <Show when={fireListing().kind === "failed"}>
          <div class="text-sm text-v2-state-fg-danger" data-slot="calendar-fires-failed">
            {language.t("calendar.page.couldNotReadTheRecentRun")}
          </div>
        </Show>
        <Show when={fires().length}>
          <div>
            <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-v2-text-text-faint">
              {language.t("calendar.page.recentRuns")}
            </div>
            <div class="flex flex-col gap-1.5">
              <For each={fires()}>
                {(f) => (
                  <div class={`${CARD} flex items-center gap-3 py-2`}>
                    <span class="min-w-0 flex-1 truncate text-sm">{titleFor(f.scheduleId)}</span>
                    <span class="text-xs text-v2-text-text-faint">{localeDateTime(f.firedAt)}</span>
                    <span
                      class={`text-xs ${f.status === "error" || f.outcome === "failed" || f.outcome === "interrupted" ? "text-v2-state-fg-danger" : "text-v2-text-text-muted"}`}
                    >
                      {fireStatusLabel(f.status, f.outcome)}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Create/edit task form */}
        <form ref={editor} class={`${CARD} flex flex-col gap-3`} onSubmit={submit}>
          <div class="flex items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <div class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-faint">
                {editingID() ? "Edit task" : "New task"}
              </div>
              <ControlScope kind="draft" />
            </div>
            <Show when={editingID()}>
              <button class={BTN} type="button" onClick={resetEditor} disabled={busy()}>
                {language.t("calendar.page.cancel")}
              </button>
            </Show>
          </div>
          <input
            aria-label="Title"
            class={FIELD}
            placeholder={language.t("calendar.page.titleEGNewYearGreeting")}
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
          <textarea
            aria-label="Prompt"
            class={FIELD}
            rows={2}
            placeholder={language.t("calendar.page.promptTheAgentRunsEG")}
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
          />
          <div class="flex flex-wrap items-center gap-2">
            <label for="calendar-repeat" class="text-sm text-v2-text-text-muted">
              {language.t("calendar.page.repeat")}
            </label>
            <select
              id="calendar-repeat"
              class={FIELD}
              value={kind()}
              onChange={(e) => setKind(e.currentTarget.value as Recurrence["kind"])}
            >
              <For each={RECURRENCE_KINDS}>{(k) => <option value={k}>{k}</option>}</For>
            </select>

            <Show when={kind() === "once"}>
              <input
                aria-label={language.t("calendar.page.runOnceAt")}
                class={FIELD}
                type="datetime-local"
                value={onceAt()}
                onInput={(e) => setOnceAt(e.currentTarget.value)}
              />
            </Show>
            <Show when={kind() !== "once"}>
              <label class="text-sm text-v2-text-text-muted">at</label>
              <input
                aria-label={language.t("calendar.page.runAt")}
                class={FIELD}
                type="time"
                value={time()}
                onInput={(e) => setTime(e.currentTarget.value)}
              />
            </Show>

            <Show when={kind() === "weekly"}>
              <div class="flex gap-1">
                <For each={WEEKDAYS}>
                  {(name, i) => (
                    <button
                      type="button"
                      aria-pressed={weekdays().includes(i())}
                      class={`rounded px-2 py-1 text-xs ${weekdays().includes(i()) ? "bg-v2-background-bg-layer-03 text-v2-text-text-base" : "text-v2-text-text-faint"}`}
                      onClick={() => toggleWeekday(i())}
                    >
                      {name}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={kind() === "monthly"}>
              <label class="text-sm text-v2-text-text-muted">day</label>
              <input
                aria-label={language.t("calendar.page.dayOfMonth")}
                class={`${FIELD} w-20`}
                type="number"
                min={1}
                max={31}
                value={monthDay()}
                onInput={(e) => setMonthDay(e.currentTarget.value)}
              />
            </Show>
            <Show when={kind() === "yearly"}>
              <select
                aria-label="Month"
                class={FIELD}
                value={yearMonth()}
                onChange={(e) => setYearMonth(Number(e.currentTarget.value))}
              >
                <For each={MONTHS}>{(m, i) => <option value={i() + 1}>{m}</option>}</For>
              </select>
              <input
                aria-label={language.t("calendar.page.dayOfMonth")}
                class={`${FIELD} w-20`}
                type="number"
                min={1}
                max={31}
                value={yearDay()}
                onInput={(e) => setYearDay(e.currentTarget.value)}
              />
            </Show>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <label for="calendar-agent" class="text-sm text-v2-text-text-muted">
              {language.t("calendar.page.responsible")}
            </label>
            <select
              id="calendar-agent"
              class={`${FIELD} min-w-[220px] flex-1`}
              onChange={(e) => setAgent(e.currentTarget.value)}
            >
              {/* ⚠️ `selected` per option, not `value` on the select: the roster arrives AFTER this
                  element is created, and a browser keeps `selectedIndex` at 0 when children appear
                  later — measured on the Memory app's owner picker, which read "Nova" over somebody
                  else's memories. */}
              <For each={agentOptions()}>
                {(option) => (
                  <option value={option.id} selected={option.id === (agent() || "nova")}>
                    {option.name}
                    {option.folder ? ` · ${option.folder}` : ""}
                  </option>
                )}
              </For>
            </select>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <label for="calendar-model" class="text-sm text-v2-text-text-muted">
              {language.t("calendar.page.model")}
            </label>
            <input
              id="calendar-model"
              class={`${FIELD} min-w-[260px] flex-1`}
              placeholder={language.t("calendar.page.overrideTheModelForThisOne")}
              value={model()}
              onInput={(e) => setModel(e.currentTarget.value)}
            />
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <label for="calendar-folder" class="text-sm text-v2-text-text-muted">
              {language.t("calendar.page.folder")}
            </label>
            <input
              id="calendar-folder"
              class={`${FIELD} min-w-[220px] flex-1`}
              placeholder={language.t("calendar.page.overrideTheFolderForThisOne")}
              value={folder()}
              onInput={(e) => setFolder(e.currentTarget.value)}
            />
            <button type="button" class={BTN} onClick={pickFolder} disabled={!conn()}>
              {language.t("calendar.page.browse")}
            </button>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <label for="calendar-permissions" class="text-sm text-v2-text-text-muted">
              {language.t("calendar.page.permissions")}
            </label>
            <select
              id="calendar-permissions"
              class={FIELD}
              value={permission()}
              onChange={(e) => setPermission(e.currentTarget.value)}
            >
              <For each={PERMISSION_MODES}>{(m) => <option value={m.value}>{m.label}</option>}</For>
            </select>
            <span class="text-xs text-v2-text-text-faint">
              {language.t("calendar.page.runsUnattendedAskStallsWithNo")}
            </span>
          </div>

          <Show when={error()}>
            <div class="text-sm text-v2-state-fg-danger">{error()}</div>
          </Show>

          <Show when={directoryProblem()}>
            <div class="text-sm text-v2-text-text-muted" data-slot="calendar-directory-problem-form">
              {directoryProblem()}
            </div>
          </Show>

          <div class="flex items-center gap-3">
            <ButtonV2 variant="gold" type="submit" disabled={busy() || !httpBase() || !routingDirectory()}>
              {busy() ? (editingID() ? "Saving…" : "Adding…") : editingID() ? "Save changes" : "Add task"}
            </ButtonV2>
            <span class="text-xs text-v2-text-text-faint">
              {language.t("calendar.page.timesAreInYourLocalTimezone")}
            </span>
          </div>
        </form>
      </div>
    </AppPage>
  )
}
