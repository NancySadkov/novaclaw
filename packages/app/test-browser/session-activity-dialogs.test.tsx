import { afterEach, expect, test } from "bun:test"
import { onMount } from "solid-js"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { DialogProvider, useDialog } from "@novaclaw/ui/context/dialog"
import { ShellListDialog } from "@/components/shell-list-dialog"
import { WorkerListDialog } from "@/components/worker-list-dialog"
import { LanguageContext } from "@/context/language"

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

const language = {
  t: (key: string, vars?: Record<string, string>) => {
    if (key === "contacts.workers.untitled") return `Worker ${vars?.number}`
    if (key === "contacts.workers.open") return "Open worker chat"
    if (key === "session.activity.shells.started") return `Started ${vars?.time}`
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
  onMount(() =>
    void dialog.show(() => (
      <WorkerListDialog
        title="Running workers"
        workers={[
          { id: "ses_research", title: "Research docs" },
          { id: "ses_untitled" },
        ]}
        href={(id) => `/chat/${id}`}
      />
    )),
  )
  return null
}

function ShellOpener() {
  const dialog = useDialog()
  onMount(() =>
    void dialog.show(() => (
      <ShellListDialog
        title="Running shell commands"
        shells={[
          {
            id: "job_test",
            sessionID: "ses_worker",
            command: "bun run test --only=app:browser",
            startedAt: 1_780_000_000_000,
          },
        ] as never}
        href={(id) => `/chat/${id}`}
        owner={() => "Research worker"}
      />
    )),
  )
  return null
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test("worker shortcut dialog lists running workers and links to their chats", async () => {
  mount(WorkerOpener)
  await settle()

  expect(document.body.textContent).toContain("Running workers")
  expect(document.body.textContent).toContain("Research docs")
  expect(document.body.textContent).toContain("Worker 2")
  expect(document.querySelector('a[href="/chat/ses_research"]')).not.toBeNull()
})

test("shell shortcut dialog lists commands, owners, and links to their chats", async () => {
  mount(ShellOpener)
  await settle()

  expect(document.body.textContent).toContain("Running shell commands")
  expect(document.body.textContent).toContain("bun run test --only=app:browser")
  expect(document.body.textContent).toContain("Research worker")
  expect(document.querySelector('a[href="/chat/ses_worker"]')).not.toBeNull()
})
