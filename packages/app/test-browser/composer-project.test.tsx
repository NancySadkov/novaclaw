import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { ComposerAgentControl } from "@/components/composer/agent-control"
import type { ComposerAgentControlState } from "@/components/composer/agent-option"
import { LanguageContext } from "@/context/language"
import { ServerContext } from "@/context/server"
import { dict } from "@/i18n/en"

test("a project officer links to its assigned terrain; an unavailable assignment never claims no project", () => {
  const [state, setState] = createSignal<ComposerAgentControlState>({
    options: [{ id: "iris", name: "Iris", folder: "/scratch/iris", ownScratch: true, shortChat: false }],
    selectedID: "iris",
    working: false,
    readOnly: true,
    onSelect: () => {},
    onPickProject: () => {
      throw new Error("A deployed officer cannot be moved through the folder picker")
    },
    project: { id: "prj_sky", name: "Night sky" },
    projectState: "ready",
  })
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () => (
      <LanguageContext.Provider value={{ t: (key: keyof typeof dict) => dict[key] } as never}>
        <ServerContext.Provider value={{ current: undefined } as never}>
          <MemoryRouter>
            <Route path="/" component={() => <ComposerAgentControl state={state()} />} />
          </MemoryRouter>
        </ServerContext.Provider>
      </LanguageContext.Provider>
    ),
    host,
  )
  try {
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/projects?project=prj_sky")
    expect(host.textContent).toContain("Night sky")
    expect(host.querySelector('[data-action="prompt-agent-project"]')).toBeNull()
    setState((value) => ({ ...value, project: undefined, projectState: "failed" }))
    expect(host.textContent).toContain("Project unavailable — reconnecting")
    expect(host.textContent).not.toContain("No project")
    setState((value) => ({ ...value, projectState: "ready" }))
    expect(host.querySelector('[data-action="prompt-agent-project"]')).not.toBeNull()
  } finally {
    dispose()
    host.remove()
  }
})
