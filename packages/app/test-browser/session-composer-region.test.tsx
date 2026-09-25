import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { render } from "solid-js/web"
import { LanguageContext } from "@/context/language"
import { SessionComposerRegion } from "@/pages/session/composer/session-composer-region"

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

test("a worker's read-only dock keeps a clickable context gauge", () => {
  let clicks = 0
  const host = document.createElement("div")
  document.body.append(host)
  const controller = {
    setDockRef: () => {},
    sessionID: () => undefined,
    centered: () => true,
    revert: () => undefined,
    providerRecovery: () => undefined,
    promptReady: () => true,
    dock: () => false,
    dockProgress: () => 0,
    dockHeight: () => 78,
    lift: () => 0,
    setDockBodyRef: () => {},
    setPromptRef: () => {},
    child: () => true,
    parentID: () => "ses_parent",
    openParent: () => {},
    handoffPrompt: () => undefined,
    todo: { collapsed: () => false, onToggle: () => {} },
    state: { todos: () => [] },
  }
  const language = {
    t: (key: string) => key,
  }

  dispose = render(
    () => (
      <LanguageContext.Provider value={language as never}>
        <SessionComposerRegion
          controller={controller as never}
          promptInput={<div data-slot="ordinary-composer" />}
          childContextUsage={
            <button data-slot="worker-context-gauge" type="button" onClick={() => clicks++}>
              context
            </button>
          }
        />
      </LanguageContext.Provider>
    ),
    host,
  )

  expect(document.querySelector('[data-slot="ordinary-composer"]')).toBeNull()
  const gauge = document.querySelector<HTMLButtonElement>('[data-slot="worker-context-gauge"]')!
  expect(gauge).not.toBeNull()
  gauge.click()
  expect(clicks).toBe(1)
})

test("the real worker chat supplies the session context control", () => {
  const sessionPage = readFileSync(new URL("../src/pages/session.tsx", import.meta.url), "utf8")
  expect(sessionPage).toContain('<SessionContextUsage buttonAppearance="v2" placement="top" />')
  expect(sessionPage).toContain("<TeamChatButton sessionID={sessionID()} />")
})
