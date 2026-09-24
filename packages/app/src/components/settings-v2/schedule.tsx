import { createMemo, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { useConfirm } from "@/components/dialog-confirm"
import { SettingsNumberFieldV2 } from "@/components/settings-v2/parts/number-field"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { createSettledResource } from "@/utils/settled-resource"
import { createListState } from "@/utils/list-state"
import { scopedDirectory } from "@/utils/routing-directory"
import { nextFire } from "@novaclaw/core/schedule/recurrence"
import {
  createSchedule,
  listScheduleFires,
  listSchedules,
  removeSchedule,
  updateSchedule,
  type Recurrence,
  type Schedule,
  type ScheduleFire,
} from "@/utils/schedule-api"

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]
const REPEAT_OPTIONS = [
  { value: "once", label: "Once" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
]
const MONTH_OPTIONS = MONTHS.map((name, index) => ({ value: String(index + 1), label: name }))
const FIELD = "schedule-field"
const two = (value: number) => String(value).padStart(2, "0")
const timeValue = (value: { hour: number; minute: number }) => `${two(value.hour)}:${two(value.minute)}`
const localDateTime = (millis: number) => {
  const date = new Date(millis)
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`
}
const formatDate = (millis: number) =>
  new Date(millis).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
const dayKey = (millis: number) => {
  const date = new Date(millis)
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}
const recurrenceLabel = (recurrence: Recurrence) => {
  switch (recurrence.kind) {
    case "once":
      return `Once · ${formatDate(recurrence.at)}`
    case "daily":
      return `Every day · ${timeValue(recurrence.time)}`
    case "weekly":
      return `${recurrence.weekdays.map((day) => DAYS[day]).join(", ")} · ${timeValue(recurrence.time)}`
    case "monthly":
      return `Day ${recurrence.day} each month · ${timeValue(recurrence.time)}`
    case "yearly":
      return `${MONTHS[recurrence.month - 1]} ${recurrence.day} each year · ${timeValue(recurrence.time)}`
  }
}
const positiveMinutes = (raw: string, label: string) => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 1440)
    throw new Error(`${label} must be a whole number from 1 to 1440 minutes.`)
  return value
}
const calendarDay = (raw: string) => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 31) throw new Error("Choose a whole day from 1 to 31.")
  return value
}
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || ""
const offsetLabel = (minutes: number) =>
  `UTC${minutes < 0 ? "−" : "+"}${two(Math.floor(Math.abs(minutes) / 60))}:${two(Math.abs(minutes) % 60)}`
const selectedZone = (raw: string) => {
  const zone = raw.trim()
  if (!zone) return undefined
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
  } catch {
    throw new Error("Enter a valid time zone, such as Europe/Berlin.")
  }
  return zone
}

export const SettingsScheduleV2: Component<{ agentID: string }> = (props) => {
  const sdk = useServerSDK()
  const server = useServer()
  const global = useGlobal()
  const confirm = useConfirm()
  const httpBase = createMemo(() => sdk()?.server?.http)
  const connection = () => server.current ?? global.servers.list()[0]
  const directory = () => {
    const current = connection()
    return current ? scopedDirectory(global.ensureServerCtx(current).sync.data.path) : ""
  }
  const scheduleSource = createMemo(() => {
    const base = httpBase()
    return base ? { base, agentID: props.agentID } : undefined
  })
  const [scheduleRows, { refetch }] = createSettledResource(scheduleSource, ({ base, agentID }) =>
    listSchedules(base, agentID),
  )
  const [fireRows, { refetch: refetchFires }] = createSettledResource(scheduleSource, ({ base, agentID }) =>
    listScheduleFires(base, agentID),
  )
  const scheduleState = createListState<Schedule>(scheduleRows)
  const fireState = createListState<ScheduleFire>(fireRows)
  const schedules = () => scheduleRows() ?? []
  const fires = () => fireRows() ?? []
  const [now, setNow] = createSignal(Date.now())
  const [month, setMonth] = createSignal(new Date().getMonth())
  const [year, setYear] = createSignal(new Date().getFullYear())
  const [selectedDay, setSelectedDay] = createSignal(new Date().getDate())
  const [editingID, setEditingID] = createSignal<string | undefined>()
  const [editorOpen, setEditorOpen] = createSignal(false)
  const [title, setTitle] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [kind, setKind] = createSignal<Recurrence["kind"]>("daily")
  const [time, setTime] = createSignal("01:00")
  const [onceAt, setOnceAt] = createSignal("")
  const [weekdays, setWeekdays] = createSignal<number[]>([1, 2, 3, 4, 5])
  const [monthDay, setMonthDay] = createSignal("1")
  const [yearMonth, setYearMonth] = createSignal("1")
  const [yearDay, setYearDay] = createSignal("1")
  const [timeZone, setTimeZone] = createSignal(browserZone())
  const [tzOffsetMin, setTzOffsetMin] = createSignal(-new Date().getTimezoneOffset())
  const [hadNamedZone, setHadNamedZone] = createSignal(false)
  const [duration, setDuration] = createSignal("60")
  const [heartbeat, setHeartbeat] = createSignal("10")
  const [escalate, setEscalate] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  onMount(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
      void refetch()
      void refetchFires()
    }, 30_000)
    onCleanup(() => clearInterval(timer))
  })

  const moveMonth = (delta: number) => {
    const date = new Date(year(), month() + delta, 1)
    setYear(date.getFullYear())
    setMonth(date.getMonth())
    setSelectedDay(1)
  }

  const occurrences = createMemo(() => {
    const start = new Date(year(), month(), 1).getTime()
    const end = new Date(year(), month() + 1, 1).getTime()
    const result = new Map<string, { schedule: Schedule; startsAt: number; endsAt: number }[]>()
    for (const schedule of schedules()) {
      if (!schedule.enabled) continue
      let cursor = start - 86_400_001
      for (let count = 0; count < 35; count++) {
        const occurrence = nextFire(schedule.recurrence as Parameters<typeof nextFire>[0], cursor, schedule.tzOffsetMin)
        if (occurrence === null || occurrence >= end || occurrence <= cursor) break
        const endsAt = occurrence + (schedule.durationMinutes ?? 60) * 60_000
        for (const instant of [occurrence, endsAt - 1]) {
          const key = dayKey(instant)
          if (instant >= start || endsAt > start) {
            const windows = result.get(key) ?? []
            if (!windows.some((window) => window.schedule.id === schedule.id && window.startsAt === occurrence))
              result.set(key, [...windows, { schedule, startsAt: occurrence, endsAt }])
          }
        }
        cursor = occurrence
      }
    }
    return result
  })

  const selectedWindows = createMemo(() => {
    const key = dayKey(new Date(year(), month(), selectedDay()).getTime())
    const windows = [...(occurrences().get(key) ?? [])].sort((left, right) => left.startsAt - right.startsAt)
    const lanes: number[] = []
    return windows.map((window) => {
      const lane = lanes.findIndex((endsAt) => endsAt <= window.startsAt)
      const index = lane < 0 ? lanes.length : lane
      lanes[index] = window.endsAt
      const dayStart = new Date(year(), month(), selectedDay()).getTime()
      const dayEnd = new Date(year(), month(), selectedDay() + 1).getTime()
      return {
        ...window,
        lane: index,
        left: Math.max(0, ((Math.max(window.startsAt, dayStart) - dayStart) / (dayEnd - dayStart)) * 100),
        width: Math.max(
          1,
          ((Math.min(window.endsAt, dayEnd) - Math.max(window.startsAt, dayStart)) / (dayEnd - dayStart)) * 100,
        ),
        overlapping: windows.some(
          (other) => other !== window && other.startsAt < window.endsAt && other.endsAt > window.startsAt,
        ),
      }
    })
  })

  const calendarDays = createMemo(() => {
    const first = new Date(year(), month(), 1)
    const count = new Date(year(), month() + 1, 0).getDate()
    return [...Array(first.getDay()).fill(null), ...Array.from({ length: count }, (_, index) => index + 1)] as (
      | number
      | null
    )[]
  })

  const reset = () => {
    setEditingID(undefined)
    setTitle("")
    setPrompt("")
    setKind("daily")
    setTime("01:00")
    setOnceAt("")
    setWeekdays([1, 2, 3, 4, 5])
    setMonthDay("1")
    setYearMonth("1")
    setYearDay("1")
    setTimeZone(browserZone())
    setTzOffsetMin(-new Date().getTimezoneOffset())
    setHadNamedZone(false)
    setDuration("60")
    setHeartbeat("10")
    setEscalate(true)
    setError(undefined)
  }
  const edit = (schedule: Schedule) => {
    reset()
    setEditingID(schedule.id)
    setEditorOpen(true)
    setTitle(schedule.title)
    setPrompt(schedule.prompt)
    setKind(schedule.recurrence.kind)
    setTzOffsetMin(schedule.tzOffsetMin)
    if (schedule.recurrence.kind !== "once") {
      setTimeZone(schedule.recurrence.zone ?? "")
      setHadNamedZone(Boolean(schedule.recurrence.zone))
    }
    setDuration(String(schedule.durationMinutes ?? 60))
    setHeartbeat(String(schedule.heartbeatMinutes ?? 10))
    setEscalate(schedule.escalateOnFailure !== false)
    if (schedule.recurrence.kind === "once") setOnceAt(localDateTime(schedule.recurrence.at))
    else {
      setTime(timeValue(schedule.recurrence.time))
      if (schedule.recurrence.kind === "weekly") setWeekdays([...schedule.recurrence.weekdays])
      if (schedule.recurrence.kind === "monthly") setMonthDay(String(schedule.recurrence.day))
      if (schedule.recurrence.kind === "yearly") {
        setYearMonth(String(schedule.recurrence.month))
        setYearDay(String(schedule.recurrence.day))
      }
    }
  }
  const recurrence = (): Recurrence => {
    if (kind() === "once") {
      const at = new Date(onceAt()).getTime()
      if (!Number.isFinite(at)) throw new Error("Choose a date and time.")
      return { kind: "once", at }
    }
    const [hour, minute] = time().split(":").map(Number)
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour! < 0 || hour! > 23 || minute! < 0 || minute! > 59)
      throw new Error("Choose a valid start time.")
    const clock = { hour: hour!, minute: minute! }
    const zone = selectedZone(timeZone())
    if (!zone && hadNamedZone()) throw new Error("Choose a time zone or restore the original one.")
    if (kind() === "weekly") {
      if (weekdays().length === 0) throw new Error("Choose at least one weekday.")
      return { kind: "weekly", time: clock, weekdays: weekdays(), zone }
    }
    if (kind() === "monthly") return { kind: "monthly", time: clock, day: calendarDay(monthDay()), zone }
    if (kind() === "yearly") {
      const monthNumber = Number(yearMonth())
      const day = Number(yearDay())
      if (
        !Number.isInteger(monthNumber) ||
        monthNumber < 1 ||
        monthNumber > 12 ||
        !Number.isInteger(day) ||
        day < 1 ||
        day > 31
      )
        throw new Error("Choose a valid month and day.")
      return { kind: "yearly", time: clock, month: monthNumber, day, zone }
    }
    return { kind: "daily", time: clock, zone }
  }

  const save = async (event: Event) => {
    event.preventDefault()
    const base = httpBase()
    if (!base || !directory()) return setError("Waiting for the instance connection and its working folder.")
    setBusy(true)
    setError(undefined)
    try {
      if (!title().trim()) throw new Error("Give this task a name.")
      if (!prompt().trim()) throw new Error("Tell the agent what to do.")
      const durationMinutes = positiveMinutes(duration(), "Duration")
      const heartbeatMinutes = positiveMinutes(heartbeat(), "Heartbeat")
      if (heartbeatMinutes > durationMinutes) throw new Error("Heartbeat must be within the task window.")
      const input = {
        title: title().trim(),
        prompt: prompt().trim(),
        recurrence: recurrence(),
        tzOffsetMin: tzOffsetMin(),
        durationMinutes,
        heartbeatMinutes,
        escalateOnFailure: escalate(),
      }
      const id = editingID()
      if (id) await updateSchedule(base, directory(), props.agentID, id, input)
      else await createSchedule(base, directory(), props.agentID, input)
      reset()
      setEditorOpen(false)
      await refetch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const toggle = async (schedule: Schedule) => {
    const base = httpBase()
    if (!base || !directory()) return setError("Waiting for the instance connection and its working folder.")
    try {
      await updateSchedule(base, directory(), props.agentID, schedule.id, { enabled: !schedule.enabled })
      await refetch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const remove = async (schedule: Schedule) => {
    if (
      !(await confirm({
        title: "Delete this scheduled task?",
        description: `“${schedule.title}” will stop appearing in this officer’s schedule.`,
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return
    const base = httpBase()
    if (!base) return
    try {
      await removeSchedule(base, props.agentID, schedule.id)
      if (editingID() === schedule.id) {
        reset()
        setEditorOpen(false)
      }
      await refetch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const latestFire = (id: string) => fires().find((fire) => fire.scheduleId === id)
  const fireLabel = (fire: ScheduleFire | undefined) => {
    if (!fire) return "No run yet"
    if (fire.outcome === "confirmed") return "Confirmed"
    if (fire.outcome === "cancelled") return "Cancelled"
    if (fire.outcome === "failed") return fire.escalatedAt ? "Missed · escalated" : "Missed"
    if (fire.windowEndAt && fire.windowEndAt > now()) return `Active until ${formatDate(fire.windowEndAt)}`
    return "Awaiting confirmation"
  }

  return (
    <div class="schedule-surface">
      <div class="schedule-heading">
        <div>
          <span class="schedule-eyebrow">OFFICER ROUTINE</span>
          <h2>Schedule</h2>
          <p>
            Give this officer a recurring work window. It gets a reminder when the window opens, then a heartbeat until
            it confirms completion or time runs out.
          </p>
        </div>
        <ButtonV2
          variant="gold"
          onClick={() => {
            reset()
            setEditorOpen(true)
          }}
        >
          New task
        </ButtonV2>
      </div>
      <Show when={error()}>
        <p class="schedule-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="schedule-layout">
        <div class="schedule-main">
          <div class="schedule-section-heading">
            <h3>Tasks</h3>
            <span>{schedules().filter((row) => row.enabled).length} active</span>
          </div>
          <Show when={scheduleState().kind === "loading" || scheduleState().kind === "idle"}>
            <p class="schedule-empty">Loading this officer’s schedule…</p>
          </Show>
          <Show when={scheduleState().kind === "failed"}>
            <p class="schedule-error">Could not read this officer’s schedule. Existing tasks may still be running.</p>
          </Show>
          <Show when={scheduleState().kind === "empty"}>
            <p class="schedule-empty">No tasks yet. Add a work window for this officer.</p>
          </Show>
          <div class="schedule-cards">
            <For each={schedules()}>
              {(schedule) => {
                const fire = () => latestFire(schedule.id)
                return (
                  <article class="schedule-card" data-disabled={!schedule.enabled}>
                    <div class="schedule-card-top">
                      <span class="schedule-status-dot" data-state={fire()?.outcome ?? "idle"} />
                      <div class="schedule-card-title">
                        <h4>{schedule.title}</h4>
                        <p>{recurrenceLabel(schedule.recurrence)}</p>
                      </div>
                      <span class="schedule-pill">{schedule.enabled ? "On" : "Paused"}</span>
                    </div>
                    <p class="schedule-card-prompt">{schedule.prompt}</p>
                    <div class="schedule-card-meta">
                      <span>{schedule.durationMinutes ?? 60} min window</span>
                      <span>Heartbeat every {schedule.heartbeatMinutes ?? 10} min</span>
                      <span>
                        {schedule.recurrence.kind === "once"
                          ? "One-time instant"
                          : schedule.recurrence.zone || `Fixed ${offsetLabel(schedule.tzOffsetMin)}`}
                      </span>
                      <span>{schedule.escalateOnFailure === false ? "No escalation" : "Escalate missed task"}</span>
                    </div>
                    <div class="schedule-card-foot">
                      <span>
                        {fireLabel(fire())}
                        {schedule.nextFireAt && schedule.enabled ? ` · Next ${formatDate(schedule.nextFireAt)}` : ""}
                      </span>
                      <div class="schedule-actions">
                        <button type="button" onClick={() => edit(schedule)}>
                          Edit
                        </button>
                        <button type="button" onClick={() => void toggle(schedule)}>
                          {schedule.enabled ? "Pause" : "Resume"}
                        </button>
                        <button type="button" onClick={() => void remove(schedule)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  </article>
                )
              }}
            </For>
          </div>
          <div class="schedule-section-heading">
            <h3>Recent windows</h3>
          </div>
          <Show when={fireState().kind === "failed"}>
            <p class="schedule-error">Could not read recent task outcomes.</p>
          </Show>
          <Show when={fireState().kind === "empty"}>
            <p class="schedule-empty">No work windows have opened yet.</p>
          </Show>
          <div class="schedule-history">
            <For each={fires().slice(0, 8)}>
              {(fire) => (
                <div class="schedule-history-row">
                  <span class="schedule-status-dot" data-state={fire.outcome} />
                  <strong>{schedules().find((row) => row.id === fire.scheduleId)?.title ?? "Removed task"}</strong>
                  <span>{fireLabel(fire)}</span>
                  <time>{formatDate(fire.occurrenceMillis)}</time>
                </div>
              )}
            </For>
          </div>
        </div>
        <aside class="schedule-calendar" aria-label="Schedule calendar">
          <div class="schedule-calendar-head">
            <button type="button" onClick={() => moveMonth(-1)} aria-label="Previous month">
              ‹
            </button>
            <strong>
              {MONTHS[month()]} {year()}
            </strong>
            <button type="button" onClick={() => moveMonth(1)} aria-label="Next month">
              ›
            </button>
          </div>
          <div class="schedule-calendar-grid">
            <For each={DAYS}>{(day) => <span class="schedule-weekday">{day.slice(0, 1)}</span>}</For>
            <For each={calendarDays()}>
              {(day) => (
                <Show when={day !== null} fallback={<span class="schedule-day" />}>
                  <button
                    type="button"
                    class="schedule-day"
                    data-today={dayKey(new Date(year(), month(), day!).getTime()) === dayKey(now())}
                    data-selected={selectedDay() === day}
                    data-has-task={
                      (occurrences().get(dayKey(new Date(year(), month(), day!).getTime()))?.length ?? 0) > 0
                    }
                    aria-label={`${MONTHS[month()]} ${day}, ${year()}: ${occurrences().get(dayKey(new Date(year(), month(), day!).getTime()))?.length ?? 0} tasks`}
                    onClick={() => setSelectedDay(day!)}
                  >
                    {day}
                    <Show
                      when={(occurrences().get(dayKey(new Date(year(), month(), day!).getTime()))?.length ?? 0) > 1}
                    >
                      <small>{occurrences().get(dayKey(new Date(year(), month(), day!).getTime()))?.length}</small>
                    </Show>
                  </button>
                </Show>
              )}
            </For>
          </div>
          <div class="schedule-day-detail">
            <strong>
              {MONTHS[month()]} {selectedDay()}
            </strong>
            <Show
              when={selectedWindows().length === 0}
              fallback={
                <>
                  <div
                    class="schedule-timeline"
                    style={{ height: `${(Math.max(...selectedWindows().map((window) => window.lane)) + 1) * 26}px` }}
                  >
                    <For each={selectedWindows()}>
                      {(window) => (
                        <div
                          class="schedule-timeline-bar"
                          style={{ top: `${window.lane * 26}px`, left: `${window.left}%`, width: `${window.width}%` }}
                          title={`${window.schedule.title}: ${formatDate(window.startsAt)}–${formatDate(window.endsAt)}`}
                        />
                      )}
                    </For>
                  </div>
                  <For each={selectedWindows()}>
                    {(window) => (
                      <div class="schedule-day-entry">
                        <span class="schedule-status-dot" data-state="pending" />
                        <span>{window.schedule.title}</span>
                        <time>
                          {new Date(window.startsAt).toLocaleTimeString(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          –
                          {new Date(window.endsAt).toLocaleTimeString(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                        <Show when={window.overlapping}>
                          <small>overlap</small>
                        </Show>
                      </div>
                    )}
                  </For>
                </>
              }
            >
              <p>No work windows.</p>
            </Show>
          </div>
          <p>
            Times shown in your local time zone. Each range is tracked separately, even when tasks overlap or cross
            midnight.
          </p>
        </aside>
      </div>
      <Show when={editorOpen()}>
        <form class="schedule-editor" onSubmit={(event) => void save(event)}>
          <div class="schedule-section-heading">
            <h3>{editingID() ? "Edit task" : "New task"}</h3>
            <button
              type="button"
              onClick={() => {
                setEditorOpen(false)
                reset()
              }}
            >
              Close
            </button>
          </div>
          <label>
            Task name
            <input
              class={FIELD}
              value={title()}
              onInput={(event) => setTitle(event.currentTarget.value)}
              placeholder="Sort and reply to email"
              required
            />
          </label>
          <label>
            Instructions
            <textarea
              class={FIELD}
              value={prompt()}
              onInput={(event) => setPrompt(event.currentTarget.value)}
              rows={4}
              placeholder="What should this officer finish during the window?"
              required
            />
          </label>
          <div class="schedule-form-grid">
            <label>
              Repeat
              <SelectV2
                aria-label="Repeat"
                options={REPEAT_OPTIONS}
                current={REPEAT_OPTIONS.find((option) => option.value === kind())}
                value={(option) => option.value}
                label={(option) => option.label}
                onSelect={(option) => option && setKind(option.value as Recurrence["kind"])}
              />
            </label>
            <Show
              when={kind() === "once"}
              fallback={
                <label>
                  Starts at
                  <input
                    class={FIELD}
                    type="time"
                    value={time()}
                    onInput={(event) => setTime(event.currentTarget.value)}
                    required
                  />
                </label>
              }
            >
              <label>
                Starts at
                <input
                  class={FIELD}
                  type="datetime-local"
                  value={onceAt()}
                  onInput={(event) => setOnceAt(event.currentTarget.value)}
                  required
                />
              </label>
            </Show>
          </div>
          <Show
            when={kind() !== "once"}
            fallback={<p class="schedule-form-help">One-time tasks use the exact date and time selected above.</p>}
          >
            <label>
              Time zone
              <input
                class={FIELD}
                value={timeZone()}
                list="schedule-time-zone-options"
                onInput={(event) => setTimeZone(event.currentTarget.value)}
                placeholder="Europe/Berlin"
                spellcheck={false}
              />
            </label>
            <datalist id="schedule-time-zone-options">
              <For
                each={[
                  ...new Set([
                    browserZone(),
                    "UTC",
                    "Europe/Berlin",
                    "America/New_York",
                    "Asia/Tokyo",
                    "Australia/Sydney",
                  ]),
                ].filter(Boolean)}
              >
                {(zone) => <option value={zone} />}
              </For>
            </datalist>
            <p class="schedule-form-help">
              Use a city time zone so the start time stays local across daylight saving changes.
              {!timeZone().trim()
                ? hadNamedZone()
                  ? " Restore the original zone or choose another before saving."
                  : ` This task keeps its fixed ${offsetLabel(tzOffsetMin())} offset until you choose one.`
                : ""}
            </p>
          </Show>
          <Show when={kind() === "weekly"}>
            <fieldset class="schedule-weekdays">
              <legend>Days</legend>
              <For each={DAYS}>
                {(day, index) => (
                  <label>
                    <input
                      type="checkbox"
                      checked={weekdays().includes(index())}
                      onChange={() =>
                        setWeekdays((current) =>
                          current.includes(index())
                            ? current.filter((value) => value !== index())
                            : [...current, index()].sort(),
                        )
                      }
                    />
                    {day}
                  </label>
                )}
              </For>
            </fieldset>
          </Show>
          <Show when={kind() === "monthly"}>
            <label>
              Day of month
              <SettingsNumberFieldV2
                ariaLabel="Day of month"
                min={1}
                max={31}
                value={() => Number(monthDay()) || undefined}
                onCommit={(value) => setMonthDay(String(value))}
                onClear={() => setMonthDay("")}
              />
            </label>
          </Show>
          <Show when={kind() === "yearly"}>
            <div class="schedule-form-grid">
              <label>
                Month
                <SelectV2
                  aria-label="Month"
                  options={MONTH_OPTIONS}
                  current={MONTH_OPTIONS.find((option) => option.value === yearMonth())}
                  value={(option) => option.value}
                  label={(option) => option.label}
                  onSelect={(option) => option && setYearMonth(option.value)}
                />
              </label>
              <label>
                Day
                <SettingsNumberFieldV2
                  ariaLabel="Day"
                  min={1}
                  max={31}
                  value={() => Number(yearDay()) || undefined}
                  onCommit={(value) => setYearDay(String(value))}
                  onClear={() => setYearDay("")}
                />
              </label>
            </div>
          </Show>
          <div class="schedule-form-grid">
            <label>
              Window length · minutes
              <SettingsNumberFieldV2
                ariaLabel="Window length · minutes"
                min={1}
                max={1440}
                value={() => Number(duration()) || undefined}
                onCommit={(value) => setDuration(String(value))}
                onClear={() => setDuration("")}
              />
            </label>
            <label>
              Heartbeat · minutes
              <SettingsNumberFieldV2
                ariaLabel="Heartbeat · minutes"
                min={1}
                max={1440}
                value={() => Number(heartbeat()) || undefined}
                onCommit={(value) => setHeartbeat(String(value))}
                onClear={() => setHeartbeat("")}
              />
            </label>
          </div>
          <p class="schedule-form-help">
            The agent is reminded at the start and every heartbeat until it confirms completion. A missed window is
            marked failed.
          </p>
          <label class="schedule-escalate">
            <input
              type="checkbox"
              checked={escalate()}
              onChange={(event) => setEscalate(event.currentTarget.checked)}
            />
            <span>
              <strong>Escalate missed tasks</strong>
              <small>Tell this officer’s superior when a work window ends without confirmation.</small>
            </span>
          </label>
          <div class="schedule-form-actions">
            <ButtonV2 variant="gold" type="submit" disabled={busy()}>
              {busy() ? "Saving…" : "Save task"}
            </ButtonV2>
            <ButtonV2
              variant="neutral"
              type="button"
              onClick={() => {
                setEditorOpen(false)
                reset()
              }}
            >
              Cancel
            </ButtonV2>
          </div>
        </form>
      </Show>
    </div>
  )
}
