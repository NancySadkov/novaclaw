import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { mockNovaClawServer } from "../utils/mock-server"

const longFailure =
  "The configured model id is not advertised by a very long endpoint path, and discovery returned a detailed failure that must remain inside its own row."
const longModelID = "model-with-an-intentionally-long-id-that-must-remain-readable-at-the-narrow-supported-viewport"

async function mountFixture(page: Page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.evaluate(async () => {
        const fixture = await import(/* @vite-ignore */ "/e2e/fixtures/visual-regressions.tsx")
        fixture.mount()
      })
      return
    } catch (error) {
      if (attempt || !String(error).includes("Execution context was destroyed")) throw error
      await page.waitForLoadState("domcontentloaded")
    }
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 720 })
  await page.addInitScript(() => localStorage.setItem("novaclaw.help.seen", "1"))
  await mockNovaClawServer(page, {
    directory: "/tmp/visual",
    provider: { all: [], connected: [], default: {} },
    project: { id: "visual", worktree: "/tmp/visual" },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/provider/*/probe?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "error", detail: longFailure }),
    }),
  )
  await page.goto("/")
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor()
  await mountFixture(page)
})

test("VR-002 · a long model row contains every control and its failure text", async ({ page }) => {
  const fixture = page.locator('[data-component="settings-v2-list"]').filter({ hasText: longModelID }).last()
  const row = fixture.locator('[data-component="settings-v2-model-sortable"]').filter({ hasText: longModelID })
  await row.getByRole("button", { name: "Test", exact: true }).click()
  await expect(row).toContainText(longFailure)
  await expect(row.getByText("Default", { exact: true })).toBeVisible()

  const verdict = await row.evaluate((node) => {
    const bounds = node.getBoundingClientRect()
    const descendants = [...node.querySelectorAll("button, [role=switch], .settings-v2-models-probe-result")]
      .filter((item) => (item as HTMLElement).offsetParent !== null)
      .map((item) => ({ text: item.textContent, box: item.getBoundingClientRect() }))
    return {
      noHorizontalScroll: node.scrollWidth <= node.clientWidth,
      allInside: descendants.every(({ box }) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1),
      unclippedTitle:
        getComputedStyle(node.querySelector('[data-slot="settings-v2-row-title"]')!).textOverflow !== "ellipsis",
      defaultHighlighted:
        getComputedStyle(node.closest('[data-component="settings-v2-model-sortable"]')!).boxShadow !== "none",
    }
  })
  expect(verdict).toEqual({ noHorizontalScroll: true, allInside: true, unclippedTitle: true, defaultHighlighted: true })
})

test("VR-003 · Configure keeps usable columns and one scroller", async ({ page }) => {
  const fixture = page.locator('[data-component="settings-v2-list"]').filter({ hasText: longModelID }).last()
  const row = fixture.locator('[data-component="settings-v2-model-sortable"]').filter({ hasText: longModelID })
  await row.getByRole("button", { name: "Configure", exact: true }).click()
  const dialog = page.locator(".model-config-dialog")
  await expect(dialog).toBeVisible()

  const verdict = await dialog.evaluate((node) => {
    const rows = [...node.querySelectorAll('[data-component="settings-v2-row"]')]
    const titleWidths = rows.map(
      (row) => row.querySelector('[data-slot="settings-v2-row-title"]')!.getBoundingClientRect().width,
    )
    const scrollOwners = [node, ...node.querySelectorAll("*")].filter((item) => {
      const el = item as HTMLElement
      const overflow = getComputedStyle(el).overflowY
      return (overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight
    })
    return {
      noHorizontalScroll:
        node.scrollWidth <= node.clientWidth && rows.every((row) => row.scrollWidth <= row.clientWidth),
      widths: {
        dialog: [node.clientWidth, node.scrollWidth],
        rows: rows.map((row) => [row.clientWidth, row.scrollWidth]),
      },
      smallestLabel: Math.min(...titleWidths),
      scrollOwners: scrollOwners.length,
    }
  })
  expect(verdict.noHorizontalScroll, JSON.stringify(verdict.widths)).toBe(true)
  expect(verdict.smallestLabel).toBeGreaterThanOrEqual(120)
  expect(verdict.scrollOwners).toBe(1)
})

test("model rows drag into a new order and persist the complete arrangement", async ({ page }) => {
  const fixture = page.locator('[data-component="settings-v2-list"]').filter({ hasText: longModelID }).last()
  const first = fixture.getByRole("button", { name: "Move Compact Model" })
  const second = fixture.getByRole("button", { name: `Move ${longModelID}` })
  const target = await second.boundingBox()
  expect(target).not.toBeNull()
  await first.hover()
  await page.mouse.down()
  await page.waitForTimeout(300)
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 10 })
  await page.mouse.up()

  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { __modelOrderWrite?: string[] }).__modelOrderWrite))
    .toEqual([`long-endpoint/${longModelID}`, "long-endpoint/compact-model"])

  const names = await fixture
    .locator('[data-component="settings-v2-model-sortable"] .settings-v2-models-identity > span:first-of-type')
    .allTextContents()
  expect(names).toEqual([longModelID, "Compact Model"])
})
