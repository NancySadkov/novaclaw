import { expect, test } from "@playwright/test"

// Actual Chromium is required: nested focus scopes can loop in Happy DOM, and a DOM-only
// query cannot prove that visible options are exposed in the accessibility tree.
test("nested controls remain accessible and Escape dismisses only the top layer", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("novaclaw.help.seen", "1"))
  await page.goto("/")
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor()
  await page.evaluate(async () => {
    const fixtureURL = "/e2e/fixtures/control-layers.tsx"
    const fixture = await import(/* @vite-ignore */ fixtureURL)
    fixture.mount()
  })
  await page.getByRole("button", { name: "Open layer fixture", exact: true }).click()
  await page.getByRole("button", { name: "Open nested popover", exact: true }).click()
  const trigger = page.getByRole("button", { name: /^Nested choice/ })
  await trigger.click()
  await expect(page.getByRole("option", { name: "Two", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(page.getByRole("option", { name: "Two", exact: true })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Nested controls", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("heading", { name: "Nested controls", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Open nested popover", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Open nested popover", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Open layer fixture", exact: true })).toBeVisible()
})

test("a select in a stacked dialog receives pointer clicks above its dialog", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("novaclaw.help.seen", "1"))
  await page.goto("/")
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor()
  await page.evaluate(async () => {
    const fixtureURL = "/e2e/fixtures/control-layers.tsx"
    const fixture = await import(/* @vite-ignore */ fixtureURL)
    fixture.mount()
  })
  await page.getByRole("button", { name: "Open layer fixture", exact: true }).click()
  await page.getByRole("button", { name: "Open stacked dialog", exact: true }).click()
  const trigger = page.getByRole("button", { name: /^Stacked choice/ })
  await trigger.click()
  await page.getByRole("option", { name: "Two", exact: true }).click()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(page.getByRole("option", { name: "Two", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Open stacked dialog", exact: true })).toBeVisible()
})
