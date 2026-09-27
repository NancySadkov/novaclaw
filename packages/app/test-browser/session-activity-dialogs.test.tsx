import { afterEach, expect, test } from "bun:test"
import { createSignal, onMount } from "solid-js"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { DialogProvider, useDialog } from "@novaclaw/ui/context/dialog"
import { ShellListDialog } from "@/components/shell-list-dialog"
import { WorkerListDialog } from "@/components/worker-list-dialog"
import type { LivingWorker } from "@/context/workers"
import { stableRows } from "@/utils/stable-rows"
import { LanguageContext } from "@/context/language"

let dispose: (() => void) | undefined
const stopped: Array<{ id: string; reason: string }> = []
const stoppedShells: Array<{ id: string; reason: string }> = []

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
  stopped.length = 0
  stoppedShells.length = 0
})

const language = {
  t: (key: string, vars?: Record<string, string>) => {
    if (key === "contacts.workers.untitled") return `Worker ${vars?.number}`
    if (key === "contacts.workers.open") return "Open worker chat"
    if (key === "session.activity.runningFor") return `Running for ${vars?.elapsed}`
    return key
  },
  plural: (key: string) => key,
  locale: () => "en",
  setLocale: () => {},
}

function mount(Opener: () => null) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      <LanguageContext.Provider value={language as never}>
        <MemoryRouter>
          <Route
            path="/"
            component={() => (
              <DialogProvider>
                <Opener />
              </DialogProvider>
            )}
          />
        </MemoryRouter>
      </LanguageContext.Provider>
    ),
    host,
  )
}

function WorkerOpener() {
  const dialog = useDialog()
  onMount(
    () =>
      void dialog.show(() => (
        <WorkerListDialog
          title="Running workers"
          workers={[{ id: "ses_research", title: "Research docs" }, { id: "ses_untitled" }]}
          href={(id) => `/chat/${id}`}
          onStop={async (worker, reason) => {
            stopped.push({ id: worker.id, reason })
          }}
        />
      )),
  )
  return null
}

function ShellOpener() {
  const dialog = useDialog()
  onMount(
    () =>
      void dialog.show(() => (
        <ShellListDialog
          title="Running shell commands"
          shells={
            [
              {
                id: "job_test",
                sessionID: "ses_worker",
                command: "bun run test --only=app:browser",
                startedAt: Date.now() - 192_000,
              },
            ] as never
          }
          href={(id) => `/chat/${id}`}
          owner={() => "Research worker"}
          onStop={async (job, reason) => {
            stoppedShells.push({ id: job.id, reason })
          }}
        />
      )),
  )
  return null
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

// A list whose rows are a signal, so the test proves a finished command drops out of an OPEN dialog
// rather than only being absent from the next snapshot.
const [liveShells, setLiveShells] = createSignal<
  readonly { id: string; sessionID: string; command: string; startedAt: number }[]
>([{ id: "job_live", sessionID: "ses_worker", command: "long build", startedAt: Date.now() }])

function LiveShellOpener() {
  const dialog = useDialog()
  onMount(
    () =>
      void dialog.show(() => (
        <ShellListDialog
          title="Running shell commands"
          shells={liveShells() as never}
          href={(id) => `/chat/${id}`}
          owner={() => "Research worker"}
        />
      )),
  )
  return null
}

test("worker shortcut dialog lists running workers and links to their chats", async () => {
  mount(WorkerOpener)
  await settle()

  expect(document.body.textContent).toContain("Running workers")
  expect(document.body.textContent).toContain("Research docs")
  expect(document.body.textContent).toContain("Worker 2")
  expect(document.querySelector('a[href="/chat/ses_research"]')).not.toBeNull()

  const stop = [...document.querySelectorAll("button")].find((button) => button.textContent === "contacts.workers.stop")
  stop?.click()
  await settle()
  const reason = document.querySelector("textarea") as HTMLTextAreaElement | null
  expect(reason).not.toBeNull()
  const confirm = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "contacts.workers.stop" && button.disabled,
  )
  expect(confirm?.disabled).toBe(true)
  reason!.value = "Duplicate of the character-assets worker"
  reason!.dispatchEvent(new InputEvent("input", { bubbles: true }))
  await settle()
  expect(confirm?.disabled).toBe(false)
  confirm?.click()
  await settle()
  expect(stopped).toEqual([{ id: "ses_research", reason: "Duplicate of the character-assets worker" }])
})

test("shell shortcut dialog lists commands, owners, elapsed time, and links to their chats", async () => {
  mount(ShellOpener)
  await settle()

  expect(document.body.textContent).toContain("Running shell commands")
  expect(document.body.textContent).toContain("bun run test --only=app:browser")
  expect(document.body.textContent).toContain("Research worker")
  expect(document.body.textContent).toContain("Running for 3m 12s")
  expect(document.querySelector('a[href="/chat/ses_worker"]')).not.toBeNull()
})

test("stopping a shell command requires a reason and sends it by job id", async () => {
  mount(ShellOpener)
  await settle()

  const stop = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "session.activity.shells.stop",
  )
  stop?.click()
  await settle()
  const reason = document.querySelector("textarea") as HTMLTextAreaElement | null
  expect(reason).not.toBeNull()
  const confirm = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "session.activity.shells.stop" && button.disabled,
  )
  expect(confirm?.disabled).toBe(true)
  reason!.value = "the provider is down"
  reason!.dispatchEvent(new InputEvent("input", { bubbles: true }))
  await settle()
  expect(confirm?.disabled).toBe(false)
  confirm?.click()
  await settle()
  expect(stoppedShells).toEqual([{ id: "job_test", reason: "the provider is down" }])
})

test("a finished command leaves the open list and shows the empty state", async () => {
  setLiveShells([{ id: "job_live", sessionID: "ses_worker", command: "long build", startedAt: Date.now() }])
  mount(LiveShellOpener)
  await settle()
  expect(document.body.textContent).toContain("long build")

  setLiveShells([])
  await settle()
  expect(document.body.textContent).not.toContain("long build")
  expect(document.body.textContent).toContain("session.activity.shells.empty")
})

/**
 * 🔴 **THE reported defect, as a rendering test: the stop-reason field must survive a poll.**
 *
 * Owner, 2026-09-27: *"when user clicks the workers icon in the chat screen, and tries to enter reason
 * for stopping a worker, something keeps stealing the input focus, apparently as the agent generates
 * in the background."*
 *
 * The chain, read out of the libraries rather than guessed. `context/workers.ts` polls every 2 s;
 * `@tanstack/solid-query` sets `structuralSharing = false` (`useBaseQuery.ts`), so each poll is a new
 * array of new objects; Solid's `<For>` is `mapArray`, which reuses a row only on
 * `items[i] === newItems[i]`. Every row was therefore destroyed and recreated on every tick — and the
 * row holds the `<textarea autofocus>`. Recreating it drops focus and caret, and the fresh
 * `autofocus` takes the focus straight back, so the keystrokes after that went somewhere the user was
 * not looking.
 *
 * This test drives the list the way the product does — a fresh, equal array, as JSON always produces —
 * and asserts on the DOM NODE, not on the text. The text surviving was never the bug; the node being
 * replaced was.
 */
/** What the wire carries: the rendered row PLUS a state the row never shows. */
type WireWorker = LivingWorker & { readonly state?: string }

const [liveWorkers, setLiveWorkers] = createSignal<readonly WireWorker[]>([])
/**
 * ⚠️ `startedAt` is a CONSTANT, not `Date.now()`. The row renders "running for N", so `startedAt` is
 * one of its identity fields — and a fixture that recomputed it per call would change a rendered field
 * on every poll and make this test fail for a reason that has nothing to do with the defect.
 */
const WORKER_STARTED_AT = 1_757_000_000_000
const livingWorker = (id: string, over: Partial<WireWorker> = {}): WireWorker => ({
  id,
  title: `Worker ${id}`,
  startedAt: WORKER_STARTED_AT,
  ...over,
})

function LiveWorkerOpener() {
  const dialog = useDialog()
  const rows = stableRows<WireWorker>(liveWorkers, {
    key: (worker) => worker.id,
    // `state` is what the wire carries and the row never renders — and it is exactly what used to
    // rebuild the row out from under the caret.
    fields: (worker) => ({ title: worker.title, startedAt: worker.startedAt }),
    project: (worker) => ({ id: worker.id, title: worker.title, startedAt: worker.startedAt }),
  })
  onMount(
    () =>
      void dialog.show(() => (
        <WorkerListDialog
          title="Running workers"
          workers={rows()}
          href={(id) => `/chat/${id}`}
          onStop={async (worker, reason) => {
            stopped.push({ id: worker.id, reason })
          }}
        />
      )),
  )
  return null
}

test("🔴 the stop-reason field keeps its DOM node, its focus and its text across a poll", async () => {
  setLiveWorkers([livingWorker("ses_research", { state: "queued" })])
  mount(LiveWorkerOpener)
  await settle()

  const stop = [...document.querySelectorAll("button")].find((button) => button.textContent === "contacts.workers.stop")
  stop?.click()
  await settle()
  const reason = document.querySelector("textarea") as HTMLTextAreaElement | null
  expect(reason).not.toBeNull()
  reason!.focus()
  reason!.value = "the audit is already covered by the ledger worker"
  reason!.dispatchEvent(new InputEvent("input", { bubbles: true }))
  await settle()
  expect(document.activeElement).toBe(reason)

  // An unchanged poll: new array, new objects, one `state` flip — exactly what the wire delivers.
  setLiveWorkers([livingWorker("ses_research", { state: "busy" })])
  await settle()

  const after = document.querySelector("textarea") as HTMLTextAreaElement | null
  expect(after, "the field was torn down and rebuilt by a poll that changed nothing").toBe(reason)
  expect(document.activeElement, "focus was stolen by the rebuilt field").toBe(reason)
  expect(after!.value).toBe("the audit is already covered by the ledger worker")

  // The row's toggle and the prompt's confirm share a label, and only the LAST one is the confirm —
  // picking the first would toggle the prompt shut and assert nothing about the stop.
  const confirm = [...document.querySelectorAll("button")]
    .filter((button) => button.textContent === "contacts.workers.stop")
    .at(-1)
  expect(confirm?.disabled, "the typed reason was lost, so Stop is disabled again").toBe(false)
  confirm?.click()
  await settle()
  expect(stopped).toEqual([
    { id: "ses_research", reason: "the audit is already covered by the ledger worker" },
  ])
})

test("🔴 NEGATIVE CONTROL: a worker whose rendered title changes DOES rebuild its row", async () => {
  // A helper that ignored every change would pass the test above and freeze the list, which is its own
  // silent lie: the row would show a stale purpose for a worker that has been re-tasked.
  setLiveWorkers([livingWorker("ses_research", { title: "Research docs" })])
  mount(LiveWorkerOpener)
  await settle()
  const stop = [...document.querySelectorAll("button")].find((button) => button.textContent === "contacts.workers.stop")
  stop?.click()
  await settle()
  const before = document.querySelector("textarea")

  setLiveWorkers([livingWorker("ses_research", { title: "Audit the ledger" })])
  await settle()

  expect(document.body.textContent).toContain("Audit the ledger")
  expect(document.querySelector("textarea")).not.toBe(before)
})
