export * as NovaHealth from "./nova-health"

/**
 * One calm answer to *"is anything wrong?"*, composed from signals that already exist.
 *
 * Model-free checks across storage, database, provider reachability,
 * model capability, sidecar state, scheduler and update/telemetry — *"with calm repairs rather than
 * raw internals"*. All seven now have a reading
 * (`notes/reports/nova-health-inputs-2026-08-11.md`); this is the part that turns readings into
 * something a person can act on.
 *
 * ## Pure on purpose
 *
 * No I/O, no clock, no services. The caller gathers the readings — which is also what keeps the
 * expensive one honest: provider reachability costs egress, so it is passed IN by a caller that
 * decided to spend it, and can never be triggered by rendering a screen.
 *
 * ## The two rules that make it worth having
 *
 * 1. **Unknown is never a tick.** Half these signals can legitimately answer "cannot tell" — the
 *    updater flag is unreadable outside the desktop shell, a pressure probe reports `unknown`
 *    rather than guessing, a reachability probe that was never run has no verdict. Rendering any of
 *    those as healthy is ruling 2 on the ONE screen a person opens when they already suspect
 *    something is broken.
 * 2. **Every non-ok row names what to DO.** "pressure: floor" is an internal; *"Close some
 *    applications, or stop a local model"* is the same fact a person can act on. Rows that have no
 *    honest action say nothing rather than inventing reassurance — `Pressure.details` is the worked
 *    example already in the tree.
 */

/** Worst-first, so `worst()` can compare and a UI can sort without a second table. */
export type Status = "problem" | "warning" | "unknown" | "ok"

const RANK: Record<Status, number> = { problem: 0, warning: 1, unknown: 2, ok: 3 }

export interface Signal {
  readonly id: string
  /** Plain language, not the subsystem's name. */
  readonly label: string
  readonly status: Status
  /** What is true, in words a non-expert reads. Absent when `ok` and there is nothing to add. */
  readonly detail?: string
  /** What the person can DO. Absent when there is no honest action — never filled with comfort. */
  readonly action?: string
}

/**
 * The overall verdict.
 *
 * ⚠️ `unknown` outranks `ok`: a board with one unreadable probe is not healthy, it is *incompletely
 * known*, and the difference is the whole reason someone opened it. It ranks BELOW `warning` because
 * a thing we measured and found wanting is more actionable than a thing we could not measure.
 */
export const worst = (signals: readonly Signal[]): Status => {
  if (signals.length === 0) return "unknown"
  return signals.reduce<Status>((acc, signal) => (RANK[signal.status] < RANK[acc] ? signal.status : acc), "ok")
}

/** One line for the top of the screen. Never "all good" unless every row really is `ok`. */
export const headline = (signals: readonly Signal[]): string => {
  const overall = worst(signals)
  if (overall === "ok") return "Everything looks healthy."
  const counted = (status: Status) => signals.filter((signal) => signal.status === status).length
  if (overall === "problem") {
    const n = counted("problem")
    return `${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention.`
  }
  if (overall === "warning") {
    const n = counted("warning")
    return `${n} thing${n === 1 ? "" : "s"} worth a look.`
  }
  const n = counted("unknown")
  return `${n} check${n === 1 ? "" : "s"} could not run, so this is incomplete.`
}

// ── the readings, each mapped by the subsystem that owns its vocabulary ──────────────────────────

/** `Pressure.Level` → a row. `floor` is a problem, `warning` a warning, `unknown` stays unknown. */
export const fromPressure = (input: {
  readonly level: "ok" | "warning" | "floor" | "unknown"
  readonly detail?: string
}): Signal => ({
  id: "storage",
  label: "Memory and disk",
  status: input.level === "floor" ? "problem" : input.level === "warning" ? "warning" : input.level,
  ...(input.detail === undefined ? {} : { detail: input.detail }),
  ...(input.level === "floor" || input.level === "warning"
    ? { action: "Close some applications, or stop a local model you are not using." }
    : {}),
})

/** `DatabaseHealth.Status` → a row. Healing exists, so a damaged store has a real action. */
export const fromDatabase = (input: {
  readonly status: "ok" | "damaged" | "unknown"
  readonly detail?: string
}): Signal => ({
  id: "database",
  label: "Conversation store",
  status: input.status === "damaged" ? "problem" : input.status,
  ...(input.detail === undefined ? {} : { detail: input.detail }),
  ...(input.status === "damaged" ? { action: "Run the repair — it rebuilds indexes without deleting anything." } : {}),
})

/** Stored secrets that are malformed or could not be checked. */
export const fromCredentials = (input: { readonly unreadable: number; readonly notice?: string }): Signal => {
  if (input.unreadable === 0) return { id: "credentials", label: "Stored secrets", status: "ok" }
  return {
    id: "credentials",
    label: "Stored secrets",
    status: "problem",
    ...(input.notice === undefined ? {} : { detail: input.notice }),
    action:
      "Reconnect affected accounts or replace their credentials; restore an identity backup in Community settings.",
  }
}

/**
 * A config document in the instance config dir that cannot be read → a row.
 *
 * 🔴 **Why this row exists.** Decoding a config document is ALL-OR-NOTHING: one malformed
 * provider entry costs the user every provider, agent and command in that file. The loss used to
 * reach nobody — it was a log line, readable only in Developer mode by someone who knew the event's
 * name — and the user met it much later as *"every turn fails model resolution"*, a symptom that
 * names the wrong subsystem entirely.
 *
 * ⚠️ **RE-DERIVED, never remembered, and that is the design rather than a shortcut.** The
 * obvious build is to persist the drop when the seed happens, because a first boot precedes any open
 * UI. But a remembered drop goes STALE the moment the user fixes the file, and a health screen
 * confidently reporting a problem that has been repaired is worse than one that says nothing. The
 * file is still on disk, so "this document cannot be read" is a fact about the present, and reading
 * it at check time is correct by construction — for a first-boot drop and for a file that broke
 * afterwards alike.
 */
export const fromConfigDocument = (input: {
  readonly unreadable: readonly { readonly path: string; readonly notice: string }[]
}): Signal => {
  if (input.unreadable.length === 0) return { id: "config-document", label: "Config file", status: "ok" }
  const [first] = input.unreadable
  const rest = input.unreadable.length - 1
  return {
    id: "config-document",
    label: "Config file",
    status: "problem",
    // The FILE and the REASON, because "a config file is invalid" sends someone to the wrong file
    // when they keep more than one, and "invalid" alone does not say what to change.
    detail:
      `${first!.path} could not be read — ${first!.notice}. Nothing in it was applied` +
      `${rest > 0 ? `, and ${rest} other document${rest === 1 ? " is" : "s are"} in the same state` : ""}.`,
    action: "Fix the file and restart, or delete it and configure from Settings.",
  }
}

/**
 * `ProviderReach.Verdict` → a row.
 *
 * ⚠️ `blocked` is a WARNING with no repair, not a problem: the user turned the airgap on, and
 * offering to "fix" a setting they chose would be the product second-guessing them.
 */
export const fromProvider = (input: {
  readonly name: string
  readonly verdict: "ok" | "unreachable" | "blocked" | "unknown"
  readonly detail?: string
}): Signal => ({
  id: `provider:${input.name}`,
  label: `Model provider — ${input.name}`,
  status: input.verdict === "unreachable" ? "problem" : input.verdict === "blocked" ? "warning" : input.verdict,
  ...(input.detail === undefined ? {} : { detail: input.detail }),
  ...(input.verdict === "unreachable"
    ? { action: "Check the endpoint address, or that the machine serving it is running." }
    : input.verdict === "blocked"
      ? { detail: "Offline mode is on, so this provider is not contacted.", action: undefined }
      : {}),
})

/**
 * Scheduled runs — the CALENDAR scheduler.
 *
 * 🔴 **This used to read the wrong subsystem.** It took a boolean derived from
 * `SessionScheduler.snapshot()`, which is per-device ADMISSION control — how many generations may
 * run at once — and has nothing to do with running scheduled work. The thing that fires due
 * schedules is `CalendarScheduler` (`schedule/scheduler.ts`), and it is the one behind a capability
 * edge, so it is also the one that can be `unavailable` while everything else is fine. The row was
 * labelled "Scheduled runs" and detailed "Scheduled work is not being started" the whole time — the
 * copy described the calendar scheduler while the reading came from a different module with a
 * similar name.
 *
 * ⚠️ Takes the capability's recorded state, which the registry already holds, so reading it starts
 * nothing. The server demands this capability at boot (`forkScoped(scheduler.get)`), so `idle` here
 * means it has not come up YET rather than that nobody wanted it.
 */
export const fromScheduler = (state: "idle" | "starting" | "ready" | "unavailable" | undefined): Signal => {
  if (state === undefined)
    return { id: "scheduler", label: "Scheduled runs", status: "unknown", detail: "Could not read the scheduler." }
  if (state === "unavailable")
    return {
      id: "scheduler",
      label: "Scheduled runs",
      status: "problem",
      detail: "Scheduled work is not being started, so anything on the calendar will not run.",
      action: "Restart the app; if it persists, check the error log in Debug.",
    }
  if (state === "ready") return { id: "scheduler", label: "Scheduled runs", status: "ok" }
  return { id: "scheduler", label: "Scheduled runs", status: "unknown", detail: "Still starting." }
}

/**
 * The updater.
 *
 * ⚠️ `UPDATER_ENABLED` lives in the desktop main process, so a server-side board CANNOT read it. It
 * reports `unknown` rather than `off` — claiming updates are disabled when we simply cannot see the
 * flag would be a false description of the user's own configuration.
 */
export const fromUpdater = (enabled: boolean | undefined): Signal =>
  enabled === undefined
    ? {
        id: "updates",
        label: "Updates",
        status: "unknown",
        detail: "This build cannot see the updater — it is a desktop-only setting.",
      }
    : { id: "updates", label: "Updates", status: "ok", detail: enabled ? "On." : "Off, by your setting." }

/**
 * The model the session will actually use — the seventh signal.
 *
 * ⚠️ **DECLARED, not probed, and the row says so.** `Model.Capabilities` is what the catalogue
 * claims (`{ tools, input, output }`); it is free to read and costs no egress, which is why this is
 * a catalogue read rather than the test-call someone might reach for. What it CANNOT tell you is
 * whether the model uses tools *well* — measured the same day, Holo-3.1 called `tool_search` 12/12
 * on one prompt and 7/12 on another with identical declarations. A health board answers "is
 * something broken", and "declares no tool support" is broken; "sometimes chooses badly" is not a
 * health question.
 *
 * `tools: false` on an agent OS is the case worth surfacing BEFORE a turn fails: the product still
 * chats, and nothing else works, which is exactly the confusing half-broken state a person would
 * otherwise diagnose by watching an agent do nothing.
 */
export const fromModel = (input: {
  readonly name: string | undefined
  readonly tools: boolean | undefined
  readonly vision?: boolean
}): Signal => {
  if (input.name === undefined || input.tools === undefined)
    return {
      id: "model",
      label: "Model",
      status: "unknown",
      detail: input.name === undefined ? "No model is selected." : `Nothing is known about ${input.name}.`,
      ...(input.name === undefined ? { action: "Choose a model in Settings." } : {}),
    }
  if (!input.tools)
    return {
      id: "model",
      label: "Model",
      status: "problem",
      detail: `${input.name} does not support tools, so agents can only chat — they cannot read files or run commands.`,
      action: "Choose a tool-capable model in Settings.",
    }
  return { id: "model", label: "Model", status: "ok", detail: input.name }
}

/**
 * Durable memory — the eighth signal.
 *
 * 🔴 **Added 2026-08-12 because its absence was the defect.** Fault injection showed the product
 * survives an unopenable memory graph exactly as designed — boot completes, nothing white-screens —
 * and then tells the user *"Nothing remembered yet. NovaClaw learns as you chat — no setup needed."*
 * Both halves of that are false when the store cannot open, and the state is indistinguishable from
 * a healthy new install, so nobody would look. Someone would chat for weeks believing it was
 * learning about them.
 *
 * ⚠️ **Takes `Memory.runtimeStatus()`, NOT the capability's state — and that distinction is the
 * whole point.** The first version of this signal read the capability, and reported `ok` against a
 * provably broken store. The capability edge answers *"did the LAYER build"*, and it does: the
 * engine's open failure is caught inside the layer, which returns a degraded client rather than
 * failing. So the edge is `ready` while the store is unopenable. The engine's own runtime stage is
 * the only thing that knows.
 *
 * ⚠️ Reading the stage does not START anything — it is a plain read of the last transition, so a
 * board that has never been used still reports `not-loaded` rather than opening the graph to find
 * out. That preserves the property the capability exists for.
 *
 * ⚠️ `not-loaded` is `unknown`, not `ok`, under this file's rule that unknown is never a tick: we
 * have not opened the store, so we cannot claim it opens. Reporting `ok` there would be the same
 * false reassurance the Memory app was giving, moved into the health board.
 */
export const fromMemory = (input: {
  readonly stage: "disabled" | "not-loaded" | "loading" | "ready" | "error" | undefined
  readonly detail?: string
}): Signal => {
  const detail = input.detail?.trim()
  if (input.stage === undefined)
    return { id: "memory", label: "Memory", status: "unknown", detail: "Could not read the memory subsystem." }
  if (input.stage === "error")
    return {
      id: "memory",
      label: "Memory",
      status: "problem",
      // Names the CONSEQUENCE first: "the graph failed to open" tells a non-expert nothing about
      // what they have lost.
      detail: `Nothing is being remembered, and saved memories cannot be read.${detail ? ` ${detail}` : ""}`,
      action: "Open Memory and choose Retry. If it keeps failing, check the error log in Debug.",
    }
  // Switched off deliberately is not a fault — the same reading the updater row takes.
  if (input.stage === "disabled")
    return { id: "memory", label: "Memory", status: "ok", detail: "Off, by your setting." }
  if (input.stage === "ready") return { id: "memory", label: "Memory", status: "ok" }
  return {
    id: "memory",
    label: "Memory",
    status: "unknown",
    detail: input.stage === "loading" ? "Still opening." : "Not opened yet — it opens the first time it is used.",
  }
}

/** The automatic session/agent world model has a separate engine and failure domain. */
export const fromWorldMemory = (input: {
  readonly stage: "disabled" | "not-loaded" | "loading" | "ready" | "error" | undefined
  readonly detail?: string
}): Signal => {
  const detail = input.detail?.trim()
  if (input.stage === undefined)
    return { id: "world-memory", label: "Agent memory", status: "unknown", detail: "Could not read agent memory." }
  if (input.stage === "error")
    return {
      id: "world-memory",
      label: "Agent memory",
      status: "problem",
      detail: `Automatic recall and learning are unavailable.${detail ? ` ${detail}` : ""}`,
      action: "Open a chat and choose Retry for Agent memory, or check the error log in Debug.",
    }
  if (input.stage === "disabled")
    return { id: "world-memory", label: "Agent memory", status: "ok", detail: "Off, by the runtime setting." }
  if (input.stage === "ready") return { id: "world-memory", label: "Agent memory", status: "ok" }
  return {
    id: "world-memory",
    label: "Agent memory",
    status: "unknown",
    detail: input.stage === "loading" ? "Still opening." : "Not opened yet — it opens when automatic memory is used.",
  }
}

/**
 * Any OTHER optional capability that is down — the generic row.
 *
 * 🔴 Five capability edges are registered (`calendar-scheduler`, `local-model`, `memory`,
 * `messenger`, `messenger-login`) and until 2026-08-12 only two could ever reach this board. The
 * rest were observable solely through `/api/capability`, a Developer-mode surface, so a first user
 * whose messenger gateway or local model refused to start had nothing to look at — the same silence
 * that made a broken memory store report "nothing remembered yet".
 *
 * ⚠️ Reports ONLY `unavailable`. A capability that is `idle` has not been asked for, which is the
 * normal state of an optional subsystem nobody uses, and a board that listed every unused capability
 * as "unknown" would bury the one real fault in noise it generated itself.
 *
 * ⚠️ Deliberately skips edges that already have a purpose-built row: those read the SUBSYSTEM's own
 * state, which is strictly better than the edge's (memory's engine can be broken while its
 * capability reads `ready`), and two rows for one thing would read as two faults.
 */
export const NAMED_CAPABILITY_ROWS: ReadonlySet<string> = new Set(["memory", "calendar-scheduler"])

export const fromCapability = (name: string): Signal => ({
  id: `capability:${name}`,
  // The registry's name is a slug; a person reads the words, not the identifier.
  label: `Optional feature — ${name.replace(/-/g, " ")}`,
  status: "problem",
  detail: "This feature failed to start. The rest of NovaClaw is unaffected.",
  action: "Open Developer mode → Debug → Optional capabilities to see why, and to retry it.",
})
