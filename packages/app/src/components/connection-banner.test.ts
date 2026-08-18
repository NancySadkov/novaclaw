import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import { bannerMode } from "./connection-banner"

/**
 * The supervisor's restart ladder is BOUNDED — after five fast crashes it stops for good. Before
 * this, the only trace was a `[supervise] …` line in server.log while this banner kept saying
 * *"Still trying. Your work is safe; this clears by itself once the instance is back"*, a promise
 * nobody was keeping. These cases pin the two halves of the fix: the terminal state is reported, and
 * it is not reported at a user whose active instance is fine.
 */
const base = {
  stream: "reconnecting",
  visible: false,
  longOutage: false,
  restored: false,
  supervisorGaveUp: false,
} as const

describe("connection banner mode", () => {
  test("a troubled stream stays calm and passive until the supervisor gives up", () => {
    expect(bannerMode({ ...base, visible: true })).toBe("reconnecting")
    expect(bannerMode({ ...base, visible: true, longOutage: true })).toBe("still-trying")
    expect(bannerMode({ ...base, stream: "connected", restored: true })).toBe("restored")
    expect(bannerMode(base)).toBe("hidden")
  })

  test("give-up replaces 'still trying' — a bound with no visible end is an infinite retry", () => {
    expect(bannerMode({ ...base, visible: true, longOutage: true, supervisorGaveUp: true })).toBe("stopped")
    // …and it does not wait out the 2s anti-flicker gate: it is a settled fact, not a symptom.
    expect(bannerMode({ ...base, supervisorGaveUp: true })).toBe("stopped")
  })

  test("a local give-up never accuses a HEALTHY active instance", () => {
    // Desktop shell driving a remote instance: the local sidecar is permanently down AND the server
    // the user is talking to is fine. Reporting an outage here would be a false alarm with a
    // Restart button on it.
    expect(bannerMode({ ...base, stream: "connected", supervisorGaveUp: true })).toBe("hidden")
    expect(bannerMode({ ...base, stream: "connected", restored: true, supervisorGaveUp: true })).toBe("restored")
  })

  test("a restart still in flight keeps the calm copy — only the terminal state escalates", () => {
    // `restarting` and `running` are not `gave-up`, so they can never reach the interactive panel.
    expect(bannerMode({ ...base, visible: true, supervisorGaveUp: false })).toBe("reconnecting")
  })

  test("the terminal copy states the stop, the safety, and the repair", () => {
    expect(en["app.connection.stopped.title"]).toContain("stopped")
    // The old line promised self-recovery. The new one must not.
    expect(en["app.connection.stopped.description"]).not.toContain("clears by itself")
    expect(en["app.connection.stopped.description"]).toContain("stopped trying")
    expect(en["app.connection.stopped.restart"]).toBeTruthy()
  })
})
