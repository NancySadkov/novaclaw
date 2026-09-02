import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { LanguageContext } from "@/context/language"
import { PlatformProvider } from "@/context/platform"
import { ErrorPage } from "@/pages/error"
import { dict as en } from "@/i18n/en"
import { languageStub } from "./language-stub"

/**
 * **THE ONE PAGE WHERE A RAW STACK TRACE MUST NOT BE THE BODY TEXT.**
 *
 * 🔴 AGENTS.md: the UI *"never crashes to a dead-end … a calm 'connection lost — reconnecting…',
 * never a stack trace or a white screen"*. This page already honoured that for the fault that
 * brought the user here — a plain headline from `errorDescriptionKey`, the chain tucked behind
 * *"Show technical details"*. Then `exportDebugLogs` routed its own failure through the SAME
 * `formatError`, which deliberately emits `error.stack` and walks `error.cause` under `Caused by`
 * rules, and wrote the result into `store.actionError` — rendered uncollapsed, in the body, in
 * danger red, underneath the buttons.
 *
 * So a non-technical person who had already hit the crash screen pressed *"Export Logs"*, it failed,
 * and the recovery screen answered with a multi-frame stack trace. Every user of this branch is
 * frightened before they read it; that is what makes this page different from every other one.
 *
 * ⚠️ **The detail is MOVED, not deleted, and both halves are asserted.** A fix that swallowed the
 * chain would trade this failure for the one ruling 2's first half forbids — a failed action that
 * cannot be diagnosed. So the tests below check the stack is absent from the body AND that it is
 * reachable, verbatim, from the disclosure the sentence points at.
 *
 * ⚠️ **The negative control is the success path.** A page that never renders `actionError` at all
 * would pass a "no stack in the body" assertion trivially, so the failing case must also prove the
 * user is TOLD, and the succeeding case must prove nothing is said.
 */



/** The frame text that must never appear in the body. Built, not caught, so it is exact. */
const FRAME = "at ExportLogsInternals (novaclaw/desktop/logs.ts:412:9)"
const CAUSE_FRAME = "at writeArchive (novaclaw/desktop/archive.ts:88:3)"

let exportOutcome: "ok" | "fail" = "fail"

function exportFailure() {
  const cause = new Error("EBUSY: resource busy or locked, open 'novaclaw.log'")
  cause.stack = `Error: EBUSY: resource busy or locked, open 'novaclaw.log'\n    ${CAUSE_FRAME}`
  const error = new Error("Could not write the debug archive", { cause })
  error.stack = `Error: Could not write the debug archive\n    ${FRAME}`
  return error
}

const platformStub = {
  platform: "desktop",
  os: "windows",
  version: "0.2.0",
  restart: () => {},
  openLink: () => {},
  recordFatalRendererError: async () => undefined,
  exportDebugLogs: async () => {
    if (exportOutcome === "fail") throw exportFailure()
  },
}

let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ""
  exportOutcome = "fail"
})

/** The fault that put the user on this page in the first place. */
const primaryFault = () => {
  const error = new Error("Boom")
  error.stack = "Error: Boom\n    at bootInstance (novaclaw/app/boot.ts:17:5)"
  return error
}

function mount() {
  host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      <PlatformProvider value={platformStub as never}>
        <LanguageContext.Provider value={languageStub as never}>
          <ErrorPage error={primaryFault()} />
        </LanguageContext.Provider>
      </PlatformProvider>
    ),
    host,
  )
}

const settle = async (times = 12) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const bodyText = () => document.body.textContent ?? ""
const click = (label: string) => {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label))
  expect(button, `no button labelled ${label}`).toBeTruthy()
  ;(button as HTMLButtonElement).click()
}
/** What the disclosure holds — a `TextField`, so the text lives in a value, not in `textContent`. */
const detailsValue = () => {
  const field = document.querySelector("textarea, input[readonly]") as HTMLTextAreaElement | null
  return field?.value ?? ""
}

describe("a failed recovery action answers in a sentence, not in stack frames", () => {
  test("🔴 the body says what happened, and carries no stack frame anywhere in it", async () => {
    mount()
    await settle()
    click(en["error.page.action.exportLogs"]!)
    await settle()

    // It is REPORTED — ruling 2's first half. A failed action that says nothing is the other defect.
    expect(document.querySelector('[data-slot="error-page-action-error"]')).not.toBeNull()
    expect(bodyText()).toContain(en["error.page.action.exportLogs.failed"]!)

    // 🔴 And it is reported in WORDS. Every frame, every `Caused by` rule, the error's own name —
    // none of it may be in the text a frightened person reads first.
    expect(bodyText()).not.toContain(FRAME)
    expect(bodyText()).not.toContain(CAUSE_FRAME)
    expect(bodyText()).not.toContain("novaclaw/desktop/logs.ts")
    expect(bodyText()).not.toContain(en["error.chain.causedBy"]!)
    expect(bodyText()).not.toContain("EBUSY")
  })

  test("🔴 …and the detail is still reachable — the disclosure holds the whole chain", async () => {
    mount()
    await settle()
    click(en["error.page.action.exportLogs"]!)
    await settle()
    click(en["error.page.details.show"]!)
    await settle()

    const details = detailsValue()
    expect(details).toContain(en["error.page.details.actionFailure"]!)
    expect(details).toContain(FRAME)
    expect(details).toContain(CAUSE_FRAME)
    expect(details).toContain(en["error.chain.causedBy"]!)
    // The fault that brought the user here is still there too — the action's chain is appended to
    // it, not substituted for it.
    expect(details).toContain("at bootInstance (novaclaw/app/boot.ts:17:5)")
  })

  test("CONTROL — the primary fault's own stack is behind the disclosure and NOT in the body", async () => {
    // The half of this page that was already right, pinned so a future edit cannot undo it while
    // fixing the other half.
    mount()
    await settle()

    expect(bodyText()).toContain(en["error.page.title"]!)
    expect(bodyText()).not.toContain("at bootInstance (novaclaw/app/boot.ts:17:5)")

    click(en["error.page.details.show"]!)
    await settle()
    expect(detailsValue()).toContain("at bootInstance (novaclaw/app/boot.ts:17:5)")
  })

  test("CONTROL — an export that SUCCEEDS says nothing at all", async () => {
    exportOutcome = "ok"
    mount()
    await settle()
    click(en["error.page.action.exportLogs"]!)
    await settle()

    expect(document.querySelector('[data-slot="error-page-action-error"]')).toBeNull()
    expect(bodyText()).not.toContain(en["error.page.action.exportLogs.failed"]!)

    click(en["error.page.details.show"]!)
    await settle()
    // …and the disclosure is not carrying a phantom action failure either.
    expect(detailsValue()).not.toContain(en["error.page.details.actionFailure"]!)
  })
})
