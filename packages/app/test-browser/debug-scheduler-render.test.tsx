import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { SchedulerDeviceCard, SchedulerModelGroupCard } from "@/pages/debug-scheduler"
import type { SchedulerDevice, SchedulerLedgerEntry } from "@/utils/scheduler-api"
import type { DeviceConfigEntry, DevicePolicyChange } from "@/utils/scheduler-device-policy"
import type { SchedulerModelEntry, SchedulerModelGroup } from "@/utils/scheduler-grouping"

/**
 * The Scheduler tab's device policy editor, mounted with the REAL Solid transform (`solid-preload`).
 *
 * 🔴 Why this exists: the editor seeds three inputs from the stored `config.devices` entry and writes
 * a change back. A source-reading test cannot tell whether a seeded `value=` actually reaches its
 * input, and the failure mode is silent — the stored cap shows as blank, so Apply overwrites a
 * policy the operator never saw. This is the same class the officer screen's render test pins.
 */

let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ""
})

const device = (over: Partial<SchedulerDevice> & Pick<SchedulerDevice, "deviceKey">): SchedulerDevice => ({
  deviceKey: over.deviceKey,
  concurrency: over.concurrency ?? 4,
  minRunMs: over.minRunMs ?? 0,
  inFlightInteractive: over.inFlightInteractive ?? [],
  inFlightBatch: over.inFlightBatch ?? [],
  inFlightMaintenance: over.inFlightMaintenance,
  waiting: over.waiting ?? [],
  waitingMaintenance: over.waitingMaintenance,
  ledger: over.ledger ?? [],
})

function mount(props: {
  device: SchedulerDevice
  entry?: DeviceConfigEntry
  devices?: Record<string, DeviceConfigEntry>
  saving?: boolean
}): { changes: DevicePolicyChange[] } {
  host = document.createElement("div")
  document.body.appendChild(host)
  const changes: DevicePolicyChange[] = []
  dispose = render(
    () => (
      <SchedulerDeviceCard
        device={props.device}
        entry={props.entry}
        devices={props.devices ?? {}}
        saving={props.saving ?? false}
        onApply={(change) => changes.push(change)}
      />
    ),
    host,
  )
  return { changes }
}

const input = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const applyButton = () =>
  [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Apply")!

describe("SchedulerDeviceCard", () => {
  test("seeds the inputs from the stored policy and shows the live cap", () => {
    const entry: DeviceConfigEntry = {
      endpoints: ["http://host:8010"],
      concurrency: 3,
      minRunMs: 12_000,
      locality: "lan",
    }
    mount({
      device: device({ deviceKey: "spark", concurrency: 3 }),
      entry,
      devices: { spark: entry },
    })
    expect(input("Concurrency cap for spark").value).toBe("3")
    expect(input("Stickiness in seconds for spark").value).toBe("12")
    expect(document.body.textContent).toContain("3 slots")
  })

  test("editing the cap applies a patch to the declared device and preserves its endpoints", () => {
    const { changes } = mount({
      device: device({ deviceKey: "spark" }),
      entry: { endpoints: ["http://host:8010"], concurrency: 4 },
      devices: { spark: { endpoints: ["http://host:8010"], concurrency: 4 } },
    })
    const field = input("Concurrency cap for spark")
    field.value = "2"
    field.dispatchEvent(new Event("input", { bubbles: true }))
    applyButton().click()
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ deviceID: "spark", created: false })
    expect(changes[0]!.entry).toEqual({ endpoints: ["http://host:8010"], concurrency: 2 })
  })

  test("an undeclared endpoint origin is named on apply, so the scheduler can key on it", () => {
    const { changes } = mount({ device: device({ deviceKey: "http://192.168.178.40:8010" }) })
    const field = input("Concurrency cap for http://192.168.178.40:8010")
    field.value = "1"
    field.dispatchEvent(new Event("input", { bubbles: true }))
    applyButton().click()
    expect(changes[0]).toMatchObject({ deviceID: "192-168-178-40-8010", created: true })
    expect(changes[0]!.entry).toEqual({ endpoints: ["http://192.168.178.40:8010"], concurrency: 1 })
  })

  test("blanking stickiness writes 0 — the live-effective spelling — rather than deleting it", () => {
    const { changes } = mount({
      device: device({ deviceKey: "spark", minRunMs: 5_000 }),
      entry: { endpoints: ["http://host:8010"], minRunMs: 5_000 },
      devices: { spark: { endpoints: ["http://host:8010"], minRunMs: 5_000 } },
    })
    const field = input("Stickiness in seconds for spark")
    expect(field.value).toBe("5")
    field.value = ""
    field.dispatchEvent(new Event("input", { bubbles: true }))
    applyButton().click()
    expect(changes[0]!.entry).toEqual({ endpoints: ["http://host:8010"], minRunMs: 0 })
    expect(changes[0]!.clear).not.toContain("minRunMs")
  })

  test("a model with no endpoint has no editable policy and says so", () => {
    mount({ device: device({ deviceKey: "openai/gpt-5" }) })
    expect(document.querySelector('input[aria-label^="Concurrency cap"]')).toBeNull()
    expect(document.body.textContent).toContain("no shared backend")
  })

  test("a locality choice is carried into the change", () => {
    const { changes } = mount({
      device: device({ deviceKey: "spark" }),
      entry: { endpoints: ["http://host:8010"] },
      devices: { spark: { endpoints: ["http://host:8010"] } },
    })
    ;[...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Remote")!.click()
    applyButton().click()
    expect(changes[0]!.entry).toEqual({ endpoints: ["http://host:8010"], locality: "remote" })
  })
})

const ledger = (over: Partial<SchedulerLedgerEntry> & Pick<SchedulerLedgerEntry, "id">): SchedulerLedgerEntry => ({
  id: over.id,
  weight: over.weight ?? 50,
  sliceTokens: over.sliceTokens ?? 32_000,
  lag: over.lag ?? 0,
  vdeadline: over.vdeadline ?? 1,
})

const modelEntry = (
  over: Partial<SchedulerModelEntry> & Pick<SchedulerModelEntry, "id" | "state">,
): SchedulerModelEntry => ({
  id: over.id,
  state: over.state,
  deviceKey: over.deviceKey ?? "spark",
  ledger: over.ledger,
  session: over.session ?? { modelKey: "spark/holo3.1", label: "Holo 3.1", title: over.id, href: `/s/${over.id}` },
})

const group: SchedulerModelGroup = {
  key: "spark/holo3.1",
  label: "Holo 3.1",
  deviceKeys: ["spark"],
  waiting: ["ses_b"],
  inFlight: 1,
  counts: { interactive: 1, batch: 0, maintenance: 0, waiting: 1, "waiting-maintenance": 0, recent: 0 },
  entries: [
    modelEntry({ id: "ses_a", state: "interactive", ledger: ledger({ id: "ses_a", lag: 24 }) }),
    modelEntry({
      id: "ses_b",
      state: "waiting",
      ledger: ledger({ id: "ses_b", lag: -12, weight: 20, sliceTokens: 8_000 }),
      session: { modelKey: "spark/holo3.1", label: "Holo 3.1", title: "A queued turn", href: "/s/ses_b" },
    }),
  ],
}

function mountGroup(executionState: (sessionID: string) => string | undefined) {
  host = document.createElement("div")
  document.body.appendChild(host)
  const actions: Array<{ action: string; sessionID: string }> = []
  dispose = render(
    () => (
      <MemoryRouter>
        <Route
          path="/"
          component={() => (
            <SchedulerModelGroupCard
              group={group}
              executionState={executionState}
              onAction={(action, sessionID) => actions.push({ action, sessionID })}
            />
          )}
        />
      </MemoryRouter>
    ),
    host,
  )
  return { actions }
}

describe("SchedulerModelGroupCard", () => {
  test("names the model, badges its device and its counts, and prints the ledger", () => {
    mountGroup(() => undefined)
    const card = document.querySelector('[data-slot="debug-scheduler-model"]')!
    expect(card.getAttribute("data-model")).toBe("spark/holo3.1")
    expect(card.textContent).toContain("Holo 3.1")
    expect(card.textContent).toContain("1 in flight")
    expect(card.textContent).toContain("1 waiting")
    expect(card.textContent).toContain("w 50")
    expect(card.textContent).toContain("slice 32k")
    // Two debts of 24 and -12 are opposite signs; the bar reflects the sign, the row the number.
    const lags = [...card.querySelectorAll<HTMLElement>(".debug-sched-lag")]
    expect(lags.map((lag) => lag.dataset.debt)).toEqual(["false", "true"])
    expect(card.textContent).toContain("A queued turn")
  })

  test("a running session offers Stop, a paused one Retry, and each calls back", () => {
    const { actions } = mountGroup((id) => (id === "ses_a" ? "busy" : "paused"))
    const buttons = [...document.querySelectorAll("button")]
    const stop = buttons.find((button) => button.textContent?.trim() === "Stop")!
    const retry = buttons.find((button) => button.textContent?.trim() === "Retry")!
    expect(stop).toBeDefined()
    expect(retry).toBeDefined()
    stop.click()
    retry.click()
    expect(actions).toEqual([
      { action: "stop", sessionID: "ses_a" },
      { action: "retry", sessionID: "ses_b" },
    ])
  })
})
