import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Icon } from "@novaclaw/ui/icon"
import { useServerSDK } from "@/context/server-sdk"
import { useServer } from "@/context/server"
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

// Calendar app (notes/calendar-cron-plan.md, P4): the home tile's page. Shows the live date/time, the next
// scheduled run, the list of schedules with their next-fire, and a form to add one. Data comes from the
// /api/calendar/schedule endpoints via the raw-fetch calendar-api client (schedules are instance-global).

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const RECURRENCE_KINDS: Recurrence["kind"][] = ["once", "daily", "weekly", "monthly", "yearly"]

// Plain-language permission postures for an UNATTENDED scheduled run. Default "bypass" = act on anything
// inside the work folder (external-directory writes still gate); "ask" stalls (no human to approve).
const PERMISSION_MODES: { value: string; label: string }[] = [
  { value: "bypass", label: "Act within its folder (recommended)" },
  { value: "surgical", label: "Edit files, no full rewrites" },
  { value: "plan", label: "Read-only (no file changes)" },
  { value: "ask", label: "Ask each time (needs you watching)" },
  { value: "yolo", label: "Unrestricted (incl. outside the folder)" },
]

const pad = (n: number) => String(n).padStart(2, "0")
const hm = (t: { hour: number; minute: number }) => `${pad(t.hour)}:${pad(t.minute)}`

function describeRecurrence(r: Recurrence): string {
  switch (r.kind) {
    case "once":
      return `Once — ${new Date(r.at).toLocaleString()}`
    case "daily":
      return `Every day at ${hm(r.time)}`
    case "weekly":
      return `Weekly on ${[...r.weekdays].sort().map((d) => WEEKDAYS[d] ?? d).join(", ")} at ${hm(r.time)}`
    case "monthly":
      return `Monthly on day ${r.day} at ${hm(r.time)}`
    case "yearly":
      return `Every year on ${MONTHS[r.month - 1] ?? r.month} ${r.day} at ${hm(r.time)}`
  }
}

function relative(ms: number, now: number): string {
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
  "rounded-md border border-v2-border-border-strong bg-v2-background-bg-layer-02 px-3 py-1.5 text-sm font-medium hover:bg-v2-background-bg-layer-03 disabled:opacity-50"
const CARD = "rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-4"

export function CalendarPage() {
  const sdk = useServerSDK()
  const httpBase = createMemo(() => sdk()?.server?.http)

  // The folder browser reuses the app's directory picker (browses the SERVER host's filesystem — where the
  // scheduled agent actually runs, not the client). Same hook the "new agent" folder chip uses.
  const server = useServer()
  const conn = createMemo(() => server.current)
  const pickDirectory = useDirectoryPicker()

  // Live clock — bump every second; refresh the list every 10s so next/last-fire stays current.
  const [now, setNow] = createSignal(Date.now())

  const [schedules, { refetch }] = createResource(
    () => httpBase(),
    async (base) => {
      try {
        return await listSchedules(base)
      } catch {
        return [] as Schedule[]
      }
    },
    { initialValue: [] as Schedule[] },
  )

  const [fires, { refetch: refetchFires }] = createResource(
    () => httpBase(),
    async (base) => {
      try {
        return await listFires(base)
      } catch {
        return [] as Fire[]
      }
    },
    { initialValue: [] as Fire[] },
  )

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

  const titleFor = (scheduleId: string) =>
    schedules().find((s) => s.id === scheduleId)?.title || "Untitled task"

  const upcoming = createMemo(() =>
    schedules()
      .filter((s) => s.enabled && s.nextFireAt !== null)
      .sort((a, b) => (a.nextFireAt ?? 0) - (b.nextFireAt ?? 0)),
  )
  const nextUp = createMemo(() => upcoming()[0])

  // ---- New-task form state ----
  const [title, setTitle] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [kind, setKind] = createSignal<Recurrence["kind"]>("daily")
  const [time, setTime] = createSignal("09:00")
  const [onceAt, setOnceAt] = createSignal("")
  const [weekdays, setWeekdays] = createSignal<number[]>([1])
  const [monthDay, setMonthDay] = createSignal(1)
  const [yearMonth, setYearMonth] = createSignal(1)
  const [yearDay, setYearDay] = createSignal(1)
  const [model, setModel] = createSignal("")
  const [folder, setFolder] = createSignal("")
  const [permission, setPermission] = createSignal("bypass")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()

  const toggleWeekday = (d: number) =>
    setWeekdays((ws) => (ws.includes(d) ? ws.filter((x) => x !== d) : [...ws, d]))

  function buildRecurrence(): Recurrence {
    const [hh, mm] = time().split(":").map((n) => Number(n))
    const t = { hour: hh || 0, minute: mm || 0 }
    switch (kind()) {
      case "once":
        return { kind: "once", at: new Date(onceAt()).getTime() }
      case "weekly":
        return { kind: "weekly", time: t, weekdays: weekdays() }
      case "monthly":
        return { kind: "monthly", time: t, day: monthDay() }
      case "yearly":
        return { kind: "yearly", time: t, month: yearMonth(), day: yearDay() }
      case "daily":
      default:
        return { kind: "daily", time: t }
    }
  }

  async function submit(e: Event) {
    e.preventDefault()
    const base = httpBase()
    if (!base) return
    setBusy(true)
    setError(undefined)
    try {
      const rec = buildRecurrence()
      if (rec.kind === "once" && Number.isNaN(rec.at)) throw new Error("Pick a date and time")
      if (rec.kind === "weekly" && rec.weekdays.length === 0) throw new Error("Pick at least one weekday")
      if (!prompt().trim()) throw new Error("Enter a prompt for the agent to run")
      await createSchedule(base, {
        title: title().trim() || undefined,
        prompt: prompt().trim(),
        recurrence: rec,
        tzOffsetMin: -new Date().getTimezoneOffset(),
        model: model().trim() || undefined,
        location: folder().trim() || undefined,
        permissionMode: permission() || undefined,
      })
      setTitle("")
      setPrompt("")
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
    if (!base) return
    try {
      await updateSchedule(base, s.id, { enabled: !s.enabled })
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
    <div class="flex min-h-0 flex-1 flex-col self-stretch m-2 rounded-[10px] overflow-hidden bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] text-v2-text-text-base">
      <div class="flex items-center gap-3 border-b border-v2-border-border-base px-4 py-2.5">
        <Icon name="calendar" size="normal" class="shrink-0 text-v2-text-text-muted" />
        <span class="text-[15px] font-semibold">Calendar</span>
        <span class="min-w-0 flex-1 truncate text-xs text-v2-text-text-faint">
          Schedule agents to run on a repeating date — daily, weekly, monthly, or yearly.
        </span>
      </div>

      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        {/* Clock + next run */}
        <div class="flex flex-wrap items-center gap-4">
          <div class={`${CARD} flex-1 min-w-[220px]`}>
            <div class="text-xs uppercase tracking-wide text-v2-text-text-faint">Now</div>
            <div class="mt-1 text-2xl font-semibold tabular-nums">{clockTime()}</div>
            <div class="text-sm text-v2-text-text-muted">{clockDate()}</div>
          </div>
          <div class={`${CARD} flex-1 min-w-[220px]`}>
            <div class="text-xs uppercase tracking-wide text-v2-text-text-faint">Next run</div>
            <Show
              when={nextUp()}
              fallback={<div class="mt-1 text-sm text-v2-text-text-muted">No upcoming runs scheduled.</div>}
            >
              {(n) => (
                <>
                  <div class="mt-1 truncate text-lg font-semibold">{n().title || "Untitled task"}</div>
                  <div class="text-sm text-v2-text-text-accent">
                    {relative(n().nextFireAt ?? 0, now())} · {new Date(n().nextFireAt ?? 0).toLocaleString()}
                  </div>
                </>
              )}
            </Show>
          </div>
        </div>

        {/* Schedule list */}
        <div>
          <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-v2-text-text-faint">
            Scheduled tasks ({schedules().length})
          </div>
          <Show
            when={schedules().length}
            fallback={<div class="text-sm text-v2-text-text-muted">No tasks yet — add one below.</div>}
          >
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
                        folder: {s.location || "home"} · access: {s.permissionMode || "default"}
                        {s.model ? ` · model: ${s.model}` : ""}
                      </div>
                      <div class="mt-1 text-xs text-v2-text-text-accent">
                        <Show when={s.nextFireAt !== null} fallback={<span class="text-v2-text-text-faint">no next run</span>}>
                          next {relative(s.nextFireAt ?? 0, now())} · {new Date(s.nextFireAt ?? 0).toLocaleString()}
                        </Show>
                        <Show when={s.lastFiredAt}>
                          <span class="text-v2-text-text-faint"> · last ran {new Date(s.lastFiredAt ?? 0).toLocaleString()}</span>
                        </Show>
                      </div>
                    </div>
                    <button
                      class={BTN}
                      onClick={() => void toggle(s)}
                      title={s.enabled ? "Pause this task" : "Resume this task"}
                    >
                      {s.enabled ? "Pause" : "Resume"}
                    </button>
                    <button class={BTN} onClick={() => void del(s.id)} title="Delete task">
                      <Icon name="trash" size="small" />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        {/* Recent runs */}
        <Show when={fires().length}>
          <div>
            <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-v2-text-text-faint">Recent runs</div>
            <div class="flex flex-col gap-1.5">
              <For each={fires()}>
                {(f) => (
                  <div class={`${CARD} flex items-center gap-3 py-2`}>
                    <span class="min-w-0 flex-1 truncate text-sm">{titleFor(f.scheduleId)}</span>
                    <span class="text-xs text-v2-text-text-faint">{new Date(f.firedAt).toLocaleString()}</span>
                    <span class={`text-xs ${f.status === "error" ? "text-v2-state-fg-danger" : "text-v2-text-text-muted"}`}>
                      {f.status === "spawned" ? "ran" : f.status}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* New task form */}
        <form class={`${CARD} flex flex-col gap-3`} onSubmit={submit}>
          <div class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-faint">New task</div>
          <input class={FIELD} placeholder="Title (e.g. New Year greeting)" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
          <textarea
            class={FIELD}
            rows={2}
            placeholder="Prompt the agent runs — e.g. Congratulate our clients with the New Year and unobtrusively promote our product."
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
          />
          <div class="flex flex-wrap items-center gap-2">
            <label class="text-sm text-v2-text-text-muted">Repeat</label>
            <select class={FIELD} value={kind()} onChange={(e) => setKind(e.currentTarget.value as Recurrence["kind"])}>
              <For each={RECURRENCE_KINDS}>{(k) => <option value={k}>{k}</option>}</For>
            </select>

            <Show when={kind() === "once"}>
              <input class={FIELD} type="datetime-local" value={onceAt()} onInput={(e) => setOnceAt(e.currentTarget.value)} />
            </Show>
            <Show when={kind() !== "once"}>
              <label class="text-sm text-v2-text-text-muted">at</label>
              <input class={FIELD} type="time" value={time()} onInput={(e) => setTime(e.currentTarget.value)} />
            </Show>

            <Show when={kind() === "weekly"}>
              <div class="flex gap-1">
                <For each={WEEKDAYS}>
                  {(name, i) => (
                    <button
                      type="button"
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
              <input class={`${FIELD} w-20`} type="number" min={1} max={31} value={monthDay()} onInput={(e) => setMonthDay(Number(e.currentTarget.value))} />
            </Show>
            <Show when={kind() === "yearly"}>
              <select class={FIELD} value={yearMonth()} onChange={(e) => setYearMonth(Number(e.currentTarget.value))}>
                <For each={MONTHS}>{(m, i) => <option value={i() + 1}>{m}</option>}</For>
              </select>
              <input class={`${FIELD} w-20`} type="number" min={1} max={31} value={yearDay()} onInput={(e) => setYearDay(Number(e.currentTarget.value))} />
            </Show>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <label class="text-sm text-v2-text-text-muted">Model</label>
            <input
              class={`${FIELD} min-w-[260px] flex-1`}
              placeholder="providerID/modelID — blank = instance default (e.g. dgx-spark/qwen3.6-35b)"
              value={model()}
              onInput={(e) => setModel(e.currentTarget.value)}
            />
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <label class="text-sm text-v2-text-text-muted">Folder</label>
            <input
              class={`${FIELD} min-w-[220px] flex-1`}
              placeholder="Work folder — where it reads inputs + writes the report (blank = instance home)"
              value={folder()}
              onInput={(e) => setFolder(e.currentTarget.value)}
            />
            <button type="button" class={BTN} onClick={pickFolder} disabled={!conn()}>
              Browse…
            </button>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <label class="text-sm text-v2-text-text-muted">Permissions</label>
            <select class={FIELD} value={permission()} onChange={(e) => setPermission(e.currentTarget.value)}>
              <For each={PERMISSION_MODES}>{(m) => <option value={m.value}>{m.label}</option>}</For>
            </select>
            <span class="text-xs text-v2-text-text-faint">Runs unattended — “Ask” stalls with no one to approve.</span>
          </div>

          <Show when={error()}>
            <div class="text-sm text-v2-state-fg-danger">{error()}</div>
          </Show>

          <div class="flex items-center gap-3">
            <button class={BTN} type="submit" disabled={busy() || !httpBase()}>
              {busy() ? "Adding…" : "Add task"}
            </button>
            <span class="text-xs text-v2-text-text-faint">Times are in your local timezone.</span>
          </div>
        </form>
      </div>
    </div>
  )
}
