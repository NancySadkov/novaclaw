import fs from "fs"
import path from "path"
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

/**
 * ─── the two SOURCE guards ──────────────────────────────────────────────────────────────────────
 *
 * `packages/app` has no Solid render harness (`jsx: preserve`, no `@solidjs/testing-library`), so
 * neither of these can be asserted against a DOM here. Both were MEASURED in the packaged app on
 * 2026-08-18 and are pinned at the source level so the fix cannot be quietly undone; the DOM proof
 * lives in `notes/reports/electron-render-gates-2026-08-18.md`.
 *
 * ⚠️ A source assertion is the weakest kind of test in this repo and is used here only because the
 * stronger kind does not exist yet. If a render harness ever lands, replace these.
 */
describe("the terminal panel's reachability is pinned in source", () => {
  const banner = fs.readFileSync(path.join(import.meta.dir, "connection-banner.tsx"), "utf8")
  const app = fs.readFileSync(path.join(import.meta.dir, "..", "app.tsx"), "utf8")

  test("the panel sets pointer-events EXPLICITLY, because the property inherits", () => {
    // The Welcome tour sets inline `pointer-events: none` on <body>. Removing `pointer-events-none`
    // yields "inherit" — still none — so the Restart button was dead on a first run.
    expect(banner).toContain('"pointer-events-auto": mode() === "stopped"')
  })

  test("ConnectionError reads the supervisor phase, so a mid-outage reload stops promising a rescue", () => {
    // The banner lives behind the health gate this screen IS the failure of, so it cannot help here.
    expect(app).toContain("useSupervisorPhase")
    expect(app).toContain("supervisorGaveUp()")
  })

  test("both surfaces read ONE source, so they cannot disagree about what is in force", () => {
    // A second subscription would be a second authority. The hook exists for exactly this.
    expect(banner).toContain('from "@/hooks/use-supervisor-phase"')
    expect(banner).not.toContain("platform.supervisor")
  })
})
