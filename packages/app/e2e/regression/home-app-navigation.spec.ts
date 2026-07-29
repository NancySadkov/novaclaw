import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockNovaClawServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

// Ported from https://github.com/NancySadkov/novaclaw/pull/11 by @DassaultFalconKing.
//
// ⚠️ This directory is NOT run by `bun run test` — `test:e2e` is a separate `playwright test`
// script, so these are manual/pre-release checks. They are kept because they encode the three
// scenarios the fix exists for, and because the second and third cannot be expressed as unit tests:
// the launcher-inert bug needs a real pointer gesture that never completes, and the escape-route
// bug needs a route that genuinely suspends. The pure decision the first two rest on IS unit-tested
// (`src/pages/home-screen/home-tile-click-guard.test.ts`), which is where the ratchet lives.

const routes = [
  ["Chats", "/chats"],
  ["Notes", "/notes"],
  ["Calendar", "/calendar"],
  ["Recipes", "/recipes"],
  ["Files", "/files"],
  ["Trash", "/trash"],
] as const

test.beforeEach(async ({ page }) => {
  await mockNovaClawServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await page.addInitScript(() => {
    localStorage.setItem("novaclaw.help.seen", "1")
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
})

test("keeps launcher routes responsive across repeated app transitions", async ({ page }) => {
  await page.goto("/")
  await expectAppVisible(page.getByRole("button", { name: "Chats" }))

  for (const [name, path] of routes) {
    await page.getByRole("button", { name }).click()
    await expect(page).toHaveURL(new RegExp(`${path}$`))
    await page.locator('[data-component="brand-home-button"]').click()
    await expect(page).toHaveURL(/\/$/)
    await expectAppVisible(page.getByRole("button", { name }))
  }
})

test("does not let a lost shell pointer gesture disable launcher buttons", async ({ page }) => {
  // The regression: the guard armed on ANY window pointerdown and only disarmed on pointerup, so a
  // gesture that never completed left every tile inert.
  await page.goto("/")
  const home = page.locator('[data-component="brand-home-button"]')
  await expectAppVisible(home)

  await home.dispatchEvent("pointerdown", { pointerId: 17, clientX: 10, clientY: 10 })
  await page.locator("body").dispatchEvent("pointermove", { pointerId: 17, clientX: 40, clientY: 10 })
  // `evaluate` hands back `HTMLElement | SVGElement`, and only the former has `.click()`.
  await page.getByRole("button", { name: "Files" }).evaluate((button) => (button as HTMLElement).click())

  await expect(page).toHaveURL(/\/files$/)
})

test("keeps an escape route visible while Files is pending", async ({ page }) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname !== "/file") return route.fallback()
    await pending
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: "[]",
    })
  })

  await page.goto("/")
  await page.getByRole("button", { name: "Files" }).click()
  try {
    await expect(page).toHaveURL(/\/files$/)
    const main = page.locator("main")
    await expectAppVisible(main.getByRole("status"))
    await expectAppVisible(main.getByRole("button", { name: "Home" }))
    await main.getByRole("button", { name: "Home" }).click()
    await expect(page).toHaveURL(/\/$/)
    await expectAppVisible(page.getByRole("button", { name: "Files" }))
  } finally {
    release()
  }
})
