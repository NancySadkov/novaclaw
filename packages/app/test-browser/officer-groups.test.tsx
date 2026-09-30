import { afterEach, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { OfficerGroups } from "@/components/officer-groups"
import { groupRoster, roster } from "@/apps/contacts"
import { LanguageContext } from "@/context/language"
import { ServerContext } from "@/context/server"

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.innerHTML = ""
})

test("team stacks disclose nested officers, retain unread attention and restore focus on Escape", () => {
  const groups = groupRoster(
    roster([
      { id: "nova", name: "Nova", mode: "primary", hidden: false },
      { id: "manager", name: "Manager", mode: "primary", hidden: false },
      { id: "builder", name: "Builder", mode: "primary", hidden: false, superior: "manager" },
      { id: "tester", name: "Tester", mode: "primary", hidden: false, superior: "builder" },
    ]),
  )
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () => (
      <LanguageContext.Provider
        value={{ t: (key: string, args: Record<string, unknown>) => `${key} ${args.name ?? args.count}` } as never}
      >
        <ServerContext.Provider value={{ current: undefined } as never}>
          <OfficerGroups
            groups={groups}
            expanded={expanded()}
            onToggle={(id) =>
              setExpanded((current) => {
                const next = new Set(current)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                return next
              })
            }
            attention={(ids) => (ids.includes("tester") ? 1 : 0)}
            renderCard={(view) => (
              <a data-card={view.id} href={`/${view.id}`}>
                {view.name}
              </a>
            )}
          />
        </ServerContext.Provider>
      </LanguageContext.Provider>
    ),
    host,
  )
  const cards = () => [...host.querySelectorAll("[data-card]")].map((node) => node.getAttribute("data-card"))
  expect(cards()).toEqual(["nova", "manager"])
  const toggle = host.querySelector<HTMLButtonElement>('[aria-controls="officer-team-manager"]')!
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  expect(toggle.textContent).toContain("contacts.team.count 2")
  expect(toggle.querySelector(".officer-team-attention")?.textContent).toBe("1")
  toggle.click()
  expect(cards()).toEqual(["nova", "manager", "builder"])
  expect(toggle.getAttribute("aria-expanded")).toBe("true")
  host.querySelector<HTMLButtonElement>('[aria-controls="officer-team-builder"]')!.click()
  expect(cards()).toEqual(["nova", "manager", "builder", "tester"])
  host
    .querySelector("#officer-team-builder")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  expect(cards()).toEqual(["nova", "manager", "builder"])
  expect(document.activeElement?.getAttribute("aria-controls")).toBe("officer-team-builder")
  host
    .querySelector("#officer-team-manager")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  expect(cards()).toEqual(["nova", "manager"])
  expect(document.activeElement).toBe(toggle)
})
