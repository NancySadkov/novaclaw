import { afterEach, expect, test } from "bun:test"
import { createSignal, onMount } from "solid-js"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { DialogProvider, useDialog } from "@novaclaw/ui/context/dialog"
import { ShellListDialog } from "@/components/shell-list-dialog"
import { WorkerListDialog } from "@/components/worker-list-dialog"
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
