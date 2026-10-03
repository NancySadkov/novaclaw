import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { A } from "@solidjs/router"
import type { SchedulerDevice } from "@/utils/scheduler-api"
import {
  MAINTENANCE_MODEL,
  UNRESOLVED_MODEL,
  type SchedulerEntryState,
  type SchedulerModelGroup,
} from "@/utils/scheduler-grouping"
import {
  devicePolicyChange,
  devicePolicyDraft,
  isDevicePolicyEditable,
  parseDevicePolicy,
  type DeviceConfigEntry,
  type DeviceLocality,
  type DevicePolicyChange,
} from "@/utils/scheduler-device-policy"
import { showToast } from "@/utils/toast"

/**
 * The Debug Scheduler tab's presentation pieces, split out so a rendering test can reach them.
 *
 * The panel itself lives in `pages/debug.tsx`, which is context-heavy; this module owns only what
 * can be mounted from props. That is deliberate: the source-reading ledgers in this tree cannot tell
 * whether a `value=` actually reaches its input, and this component is exactly where a seeded form
 * loses the stored policy if it is written the obvious way.
 */

/** A token count as a person reads it — the ledger's slice is always a round thousands figure. */
const formatTokenCount = (value: number): string => (value >= 1000 ? `${Math.round(value / 1000)}k` : String(value))

const SCHEDULER_STATE_LABEL: Record<SchedulerEntryState, string> = {
  interactive: "interactive",
  batch: "batch",
  maintenance: "maint",
  waiting: "waiting",
  "waiting-maintenance": "wait·maint",
  recent: "recent",
}

const LOCALITY_OPTIONS: readonly { readonly value: "" | DeviceLocality; readonly label: string }[] = [
  { value: "", label: "Auto" },
  { value: "local", label: "Local" },
  { value: "lan", label: "LAN" },
  { value: "remote", label: "Remote" },
]

/**
 * One device's live policy. The cap and the stickiness window are the scheduler's only operator
 * levers — everything else is the turn lifecycle — so they sit next to the queues they move. A blank
 * field means "no override", which is why Apply sends a DELETE for a cleared concurrency.
 */
export const SchedulerDeviceCard = (props: {
  device: SchedulerDevice
  entry: DeviceConfigEntry | undefined
  devices: Readonly<Record<string, DeviceConfigEntry>>
  saving: boolean
  onApply: (change: DevicePolicyChange) => void
}) => {
  const seed = devicePolicyDraft(props.entry)
  const [concurrency, setConcurrency] = createSignal(seed.concurrency)
  const [minRunSeconds, setMinRunSeconds] = createSignal(seed.minRunSeconds)
  const [locality, setLocality] = createSignal<"" | DeviceLocality>(seed.locality)
  createEffect(
    on(
      () => JSON.stringify(props.entry ?? null),
      () => {
        const next = devicePolicyDraft(props.entry)
        setConcurrency(next.concurrency)
        setMinRunSeconds(next.minRunSeconds)
        setLocality(next.locality)
      },
      { defer: true },
    ),
  )

  const editable = () => isDevicePolicyEditable(props.device.deviceKey, props.devices)
  const active = () =>
    props.device.inFlightInteractive.length +
    props.device.inFlightBatch.length +
    (props.device.inFlightMaintenance ?? []).length
  const queued = () => props.device.waiting.length + (props.device.waitingMaintenance ?? []).length

  const apply = () => {
    const parsed = parseDevicePolicy({
      concurrency: concurrency(),
      minRunSeconds: minRunSeconds(),
      locality: locality(),
    })
    if (!parsed.ok) {
      showToast({ variant: "error", title: parsed.message })
      return
    }
    const change = devicePolicyChange({
      deviceKey: props.device.deviceKey,
      devices: props.devices,
      values: parsed,
    })
    if (change === undefined) {
      showToast({ variant: "error", title: "This backend has no endpoint to declare as a device." })
      return
    }
    props.onApply(change)
  }

  return (
    <div class="debug-sched-device" data-slot="debug-scheduler-device" data-device={props.device.deviceKey}>
      <div class="flex min-w-0 flex-wrap items-center gap-1.5">
        <span class="debug-sched-device-name" title={props.device.deviceKey}>
          {props.device.deviceKey}
        </span>
        <Show when={props.device.locality}>
          {(value) => (
            <span class="debug-sched-chip" data-tone={value()}>
              {value()}
            </span>
          )}
        </Show>
        <span class="debug-sched-chip">
          {props.device.concurrency ?? "—"} slot{props.device.concurrency === 1 ? "" : "s"}
        </span>
        <span class="debug-sched-chip">{active()} active</span>
        <Show when={queued() > 0}>
          <span class="debug-sched-chip" data-tone="lan">
            {queued()} queued
          </span>
        </Show>
        <Show when={props.device.minRunMs > 0}>
          <span class="debug-sched-chip">stickiness {Math.round(props.device.minRunMs / 1000)}s</span>
        </Show>
      </div>
      <Show
        when={editable()}
        fallback={
          <div class="debug-panel-hint">
            A model with no endpoint keeps its own per-model key, so there is no shared backend to write a policy onto.
          </div>
        }
      >
        <label class="debug-sched-field">
          <span title="Maximum concurrent generations across foreground, background and maintenance work.">
            Concurrency cap
          </span>
          <input
            class="debug-sched-input"
            inputmode="numeric"
            value={concurrency()}
            placeholder="inherit"
            aria-label={`Concurrency cap for ${props.device.deviceKey}`}
            onInput={(event) => setConcurrency(event.currentTarget.value)}
          />
        </label>
        <label class="debug-sched-field">
          <span title="Seconds a session keeps this backend before another may take it — a cache-affinity window; 0 disables it.">
            Stickiness (s)
          </span>
          <input
            class="debug-sched-input"
            inputmode="numeric"
            value={minRunSeconds()}
            placeholder="inherit"
            aria-label={`Stickiness in seconds for ${props.device.deviceKey}`}
            onInput={(event) => setMinRunSeconds(event.currentTarget.value)}
          />
        </label>
        <div class="debug-sched-field">
          <span>Locality</span>
          <div class="debug-sched-seg" role="group" aria-label={`Locality for ${props.device.deviceKey}`}>
            <For each={LOCALITY_OPTIONS}>
              {(option) => (
                <button
                  type="button"
                  data-on={locality() === option.value}
                  aria-pressed={locality() === option.value}
                  onClick={() => setLocality(option.value)}
                >
                  {option.label}
                </button>
              )}
            </For>
          </div>
        </div>
        <div class="flex justify-end">
          <button
            type="button"
            class="debug-action disabled:pointer-events-none disabled:opacity-40"
            disabled={props.saving}
            onClick={apply}
          >
            {props.saving ? "Applying…" : "Apply"}
          </button>
        </div>
      </Show>
    </div>
  )
}

/**
 * One model's group: its human name, the devices it spans, and one row per session with the EEVDF
 * numbers that decide who runs next. The ledger bars are scaled to the group's own largest debt, so
 * the comparison the reader is making is the one on screen.
 */
export const SchedulerModelGroupCard = (props: {
  group: SchedulerModelGroup
  /** The join to the execution store, so a stopped session offers Retry and a running one Stop. */
  executionState: (sessionID: string) => string | undefined
  onAction: (action: "retry" | "stop", sessionID: string) => void
}) => {
  const maxLag = createMemo(() => Math.max(1, ...props.group.entries.map((entry) => Math.abs(entry.ledger?.lag ?? 0))))
  const actionFor = (sessionID: string): "retry" | "stop" | undefined => {
    const state = props.executionState(sessionID)
    if (state === undefined) return undefined
    if (["paused", "failed", "interrupted"].includes(state)) return "retry"
    if (["starting", "busy", "recovering"].includes(state)) return "stop"
    return undefined
  }
  return (
    <article class="debug-sched-group" data-slot="debug-scheduler-model" data-model={props.group.key}>
      <header class="debug-sched-group-head">
        <span class="debug-sched-group-name">{props.group.label}</span>
        <Show when={props.group.key !== MAINTENANCE_MODEL && props.group.key !== UNRESOLVED_MODEL}>
          <span class="debug-sched-group-key">{props.group.key}</span>
        </Show>
        <span class="debug-sched-group-meta">
          <Show when={props.group.inFlight > 0}>
            <span class="debug-sched-chip">{props.group.inFlight} in flight</span>
          </Show>
          <Show when={props.group.waiting.length > 0}>
            <span class="debug-sched-chip" data-tone="lan">
              {props.group.waiting.length} waiting
            </span>
          </Show>
          <For each={props.group.deviceKeys}>{(key) => <span class="debug-sched-chip">{key}</span>}</For>
        </span>
      </header>
      <For each={props.group.entries}>
        {(entry) => {
          const action = () => actionFor(entry.id)
          return (
            <div class="debug-sched-entry">
              <div class="debug-sched-entry-main">
                <span class="debug-sched-state" data-state={entry.state}>
                  {SCHEDULER_STATE_LABEL[entry.state]}
                </span>
                <Show
                  when={entry.session?.href}
                  fallback={<span class="debug-sched-entry-title">{entry.session?.title || entry.id}</span>}
                >
                  {(href) => (
                    <A href={href()} class="debug-sched-entry-title hover:underline">
                      {entry.session?.title || entry.id}
                    </A>
                  )}
                </Show>
                <Show when={entry.session?.agent}>
                  <span class="debug-sched-chip">{entry.session?.agent}</span>
                </Show>
              </div>
              <div class="debug-sched-entry-side">
                <Show
                  when={entry.ledger}
                  fallback={
                    <span class="debug-sched-entry-stats">{entry.state === "recent" ? "—" : "no ledger entry"}</span>
                  }
                >
                  {(ledger) => {
                    const debt = () => ledger().lag < 0
                    const width = () => Math.min(100, Math.round((Math.abs(ledger().lag) / maxLag()) * 100))
                    return (
                      <span class="debug-sched-entry-stats">
                        <span>w {ledger().weight}</span>
                        <span>slice {formatTokenCount(ledger().sliceTokens)}</span>
                        <span
                          class="debug-sched-lag"
                          data-debt={debt()}
                          title="Fairness debt: lag ≥ 0 is eligible; below zero is over-consumed and waits."
                        >
                          lag {ledger().lag >= 0 ? "+" : ""}
                          {ledger().lag.toFixed(1)}
                          <span class="debug-sched-lag-bar">
                            <i style={{ width: `${width()}%` }} />
                          </span>
                        </span>
                        <span>vd {ledger().vdeadline.toFixed(1)}</span>
                      </span>
                    )
                  }}
                </Show>
                <Show when={action()}>
                  {(kind) => (
                    <button class="hover:underline" onClick={() => props.onAction(kind(), entry.id)}>
                      {kind() === "retry" ? "Retry" : "Stop"}
                    </button>
                  )}
                </Show>
              </div>
            </div>
          )
        }}
      </For>
    </article>
  )
}
