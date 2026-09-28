import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockNovaClawServer } from "../utils/mock-server"

test("launcher and titlebar navigation do not wait for officer activity", async ({ page }) => {
  await mockNovaClawServer(page, { ...fixture, pageMessages })
  await page.route("**/api/agent", (route) => route.fulfill({
    headers: { "access-control-allow-origin": "*" },
    json: { data: [{ id: "nova", name: "Nova", mode: "primary", kind: "agent", config: {} }] },
  }))
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/session/execution", async (route) => {
    await pending
    await route.fulfill({ headers: { "access-control-allow-origin": "*" }, json: { data: [] } })
  })
  await page.addInitScript(() => localStorage.setItem("novaclaw.help.seen", "1"))
  try {
    await page.goto("/")
    const home = page.locator('[data-component="brand-home-button"]')
    const hero = page.locator('[data-home-app-id="contacts"] button')
    await expect(hero).toBeVisible()
    for (let index = 0; index < 6; index++) {
      const action = index % 2 ? () => home.click({ button: "right" }) : () => hero.click()
      await action()
      await expect(page.locator(".officer-roster-toolbar")).toBeVisible({ timeout: 1_000 })
      await home.click()
      await expect(hero).toBeVisible({ timeout: 1_000 })
    }
    await page.route(/\/path(?:\?|$)/, async (route) => {
      await pending
      await route.fulfill({ headers: { "access-control-allow-origin": "*" }, json: {} })
    })
    await page.locator('[data-home-app-id="files"] button').click()
    await expect(page.getByRole("button", { name: "New folder", exact: true })).toBeVisible({ timeout: 1_000 })
    await home.click()
    await expect(hero).toBeVisible({ timeout: 1_000 })
  } finally {
    release()
  }
})
