import { afterEach, describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { ContextTemplate } from "@novaclaw/core/session/context-template"
import { GlobalContext } from "@/context/global"
import { LanguageContext } from "@/context/language"
import { ServerContext } from "@/context/server"
import { ServerSyncContext } from "@/context/server-sync"
import { PlatformProvider } from "@/context/platform"
import { SettingsProvider } from "@/context/settings"
import { SettingsSystemPromptV2 } from "@/components/settings-v2/system-prompt"
import { dict as en } from "@/i18n/en"
import { languageStub } from "./language-stub"

// The layout screen is the owner's ask of 2026-09-16 — *"clearly exposing the layout in UI, while
// allowing user to both view and edit it"* — and a table that renders is not a table that is RIGHT.
// These render the real component and read the DOM, because the failure this page can have is not a
// crash: it is a row whose copy resolves to nothing (`languageStub` renders a miss as `""`, exactly
// like the app, so a missing key is a BLANK row rather than a raw key id) or a volatility claim on
// the wrong row.

/**
 * A touch-primary surface, so a click PINS the popover.
 *
 * Not decoration: `InfoPopoverV2` deliberately makes a mouse click inert where the primary pointer can
 * hover (see its header — the click would otherwise close the panel the pointer is still resting on),
 * and whether happydom's `matchMedia` reports hover is an implementation detail of the test DOM, not
 * something this test is about. Declaring it makes the open path deterministic.
 */
const asTouchSurface = () => {
  globalThis.window!.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as never
}

let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ""
})

const settle = async (times = 6) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const mount = () => {
  asTouchSurface()
  const [store] = createStore<{ config: Record<string, unknown> }>({ config: {} })
  const sync = () => ({ data: store, updateConfig: async () => ({}) })
  const global = {
    servers: { list: () => [{ type: "http", url: "http://localhost:4096" }], health: {} },
    ensureServerCtx: () => ({ agents: { list: () => [] } }),
  }
  host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as never}>
        <SettingsProvider>
          <LanguageContext.Provider value={languageStub as never}>
            <GlobalContext.Provider value={global as never}>
              <ServerContext.Provider value={{ current: { type: "http" }, key: "server" } as never}>
                <ServerSyncContext.Provider value={sync as never}>
                  <SettingsSystemPromptV2 />
                </ServerSyncContext.Provider>
              </ServerContext.Provider>
            </GlobalContext.Provider>
          </LanguageContext.Provider>
        </SettingsProvider>
      </PlatformProvider>
    ),
    host,
  )
}

/**
 * Every rendered layout row, in DOM order: its title, and the provenance it claims.
 *
 * ⚠️ The title is read from the row's FIRST text node, not from `textContent`. The title div also
 * holds the `?` trigger, so `textContent` reads `"Durable goal?"` — and a test that expected that
 * would be asserting the trigger's glyph rather than the field's name.
 */
const renderedRows = () => {
  const section = document.querySelector('[data-component="settings-context-layout"]')
  if (!section) throw new Error("the layout section did not render")
  return [...section.querySelectorAll('[data-component="settings-v2-row"]')].map((row) => {
    const title = row.querySelector('[data-slot="settings-v2-row-title"]')
    const first = title?.firstChild
    return {
      row,
      title: (first?.nodeType === Node.TEXT_NODE ? first.textContent : title?.textContent)?.trim() ?? "",
      origin: row.querySelector("[data-slot-origin]")?.getAttribute("data-slot-origin") ?? "",
    }
  })
}

const label = (key: string) => (en as Record<string, string>)[key] as string

const rowFor = (name: string) => {
  const wanted = label(`settings.contextLayout.slot.${name}`)
  const found = renderedRows().find((row) => row.title === wanted)
  if (!found) throw new Error(`no layout row titled "${wanted}"`)
  return found
}

/** Open a row's `?` explanation the way a tap does, and return the panel's text. */
const openInfo = async (row: Element) => {
  const trigger = row.querySelector<HTMLElement>('[data-component="info-popover-v2-trigger"]')
  if (!trigger) throw new Error("the row has no explanation trigger")
  trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "touch" }))
  trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "touch" }))
  trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }))
  await settle()
  return document.querySelector<HTMLElement>('[data-component="info-popover-v2"]')?.textContent ?? ""
}

describe("Settings → System prompt — the layout table on screen", () => {
  test("renders one row per kernel slot, in the kernel's order", async () => {
    mount()
    await settle()
    const rows = renderedRows()
    expect(rows).toHaveLength(ContextTemplate.SLOTS.length)
    expect(rows.map((row) => row.title)).toEqual(
      ContextTemplate.SLOTS.map((slot) => label(`settings.contextLayout.slot.${slot.name}`)),
    )
  })

  test("🔴 no row is blank, and every row states where its content comes from", async () => {
    // A blank title is what a missing translation key looks like to a user, and it is invisible in a
    // test that asserts nothing about the text. The provenance is the column that makes the page
    // useful rather than decorative, so every row must carry one of the six real kinds — never the
    // component's fallback, which it emits only if the table has lost a slot.
    mount()
    await settle()
    for (const row of renderedRows()) {
      expect(row.title, "a layout row rendered with no title").not.toBe("")
      expect(["settings", "agent", "model", "files", "project", "session", "auto"]).toContain(row.origin)
    }
  })

  test("the freeze is stated on `base`, the one epoch-frozen slot", async () => {
    // The volatility column is the one a reader cannot get anywhere else, and it is only visible when
    // the explanation is opened — so this opens it and reads what a user would see.
    mount()
    await settle()
    expect(await openInfo(rowFor("base").row)).toContain(label("settings.contextLayout.volatility.epoch"))
  })

  test("a per-turn slot says it is rebuilt, and never claims the freeze", async () => {
    mount()
    await settle()
    const turn = await openInfo(rowFor("goal").row)
    expect(turn).toContain(label("settings.contextLayout.volatility.turn"))
    expect(turn).not.toContain(label("settings.contextLayout.volatility.epoch"))
  })

  test("the three slots a plausible edit mislabels carry the right provenance on screen", async () => {
    // `base` feels like "the kernel" but is files on disk; `projectScope` travels in the folder's own
    // `novaclaw.json` and may only ever narrow (principle 13); `goal` is set by the user or a superior.
    mount()
    await settle()
    expect(rowFor("base").origin).toBe("files")
    expect(rowFor("projectScope").origin).toBe("project")
    expect(rowFor("goal").origin).toBe("agent")
  })

  test("the persona editor is still the editable control on the page, and the prompt says so", async () => {
    // "View AND edit": the layout table is the map, and the edit affordances stay where the values
    // live. The persona textarea is the one on this page, and it must survive as the live control.
    mount()
    await settle()
    expect(document.querySelector("textarea")).not.toBeNull()
    expect(document.body.textContent).toContain(label("settings.contextLayout.title"))
    expect(document.body.textContent).toContain(label("settings.systemPrompt.persona.prompt.description"))
    // The removed dead control (config `instructions`, which no reader ever consulted) is gone rather
    // than still promising paths on the page that explains the prompt.
    expect(document.body.textContent).not.toContain("Project instructions")
  })
})
