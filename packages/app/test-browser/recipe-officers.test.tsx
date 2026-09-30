import { afterEach, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { RecipeOfficer } from "@novaclaw/schema/recipe-officer"
import { RecipeOfficersEditor } from "@/components/recipe-officers"

let dispose: (() => void) | undefined
let host: HTMLDivElement
afterEach(() => {
  dispose?.()
  host?.remove()
})
test("authors officer jobs and timed nudges without losing other team members", async () => {
  host = document.createElement("div")
  document.body.append(host)
  const [officers, setOfficers] = createSignal<readonly RecipeOfficer[]>([
    { title: "Builder", description: "Build a page", nudges: [] },
  ])
  dispose = render(() => <RecipeOfficersEditor officers={officers()} onChange={setOfficers} />, host)
  const click = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text)!.click()
  click("+ Add officer")
  const titles = host.querySelectorAll<HTMLInputElement>('input[placeholder="e.g. Researcher"]')
  titles[1]!.value = "Reviewer"
  titles[1]!.dispatchEvent(new Event("input", { bubbles: true }))
  expect(officers().map((officer) => officer.title)).toEqual(["Builder", "Reviewer"])
  click("+ Add nudge")
  const choose = async (element: HTMLElement) => {
    element.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
    )
    await Promise.resolve()
    element.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
    )
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await choose(host.querySelector<HTMLElement>('[aria-label="When officer 1 nudge 1 fires"]')!)
  await choose(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.includes("Every few minutes"),
    )!,
  )
  const minutes = host.querySelector<HTMLInputElement>('input[type="number"]')!
  minutes.value = "15"
  minutes.dispatchEvent(new Event("input", { bubbles: true }))
  expect(officers()[0]!.nudges[0]!.hook).toEqual({ type: "interval", minutes: 15 })
  click("Remove nudge")
  expect(officers()[0]!.nudges).toEqual([])
  expect(officers()[1]!.title).toBe("Reviewer")
  expect(host.textContent).toContain("A Manager reports to Nova")
})
