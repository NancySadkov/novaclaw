import { expect, test } from "@playwright/test"
import { mockNovaClawServer } from "../utils/mock-server"

const longFailure =
  "The configured model id is not advertised by a very long endpoint path, and discovery returned a detailed failure that must remain inside its own row."
const longModelID = "model-with-an-intentionally-long-id-that-must-remain-readable-at-the-narrow-supported-viewport"

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
  await page.evaluate(async () => {
    const fixture = await import(/* @vite-ignore */ "/e2e/fixtures/visual-regressions.tsx")
    fixture.mount()
  })
})

test("VR-002 · a long model row contains every control and its failure text", async ({ page }) => {
  const fixture = page.locator('[data-component="settings-v2-list"]').filter({ hasText: longModelID })
  const row = fixture.locator('[data-component="settings-v2-row"]').first()
  await row.getByRole("button", { name: "Test", exact: true }).click()
  await expect(row).toContainText(longFailure)

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
    }
  })
  expect(verdict).toEqual({ noHorizontalScroll: true, allInside: true, unclippedTitle: true })
})

test("VR-003 · Configure keeps usable columns and one scroller under long probe text", async ({ page }) => {
  const fixture = page.locator('[data-component="settings-v2-list"]').filter({ hasText: longModelID })
  await fixture.getByRole("button", { name: "Configure", exact: true }).click()
  const dialog = page.locator(".model-config-dialog")
  await expect(dialog).toBeVisible()
  await dialog.locator('[data-action="tool-channel-test"]').click()
  await expect(dialog).toContainText(longFailure)

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
      errorInside: (() => {
        const error = node.querySelector("[data-tool-channel-error]")!.getBoundingClientRect()
        const row = node
          .querySelector("[data-tool-channel-error]")!
          .closest('[data-component="settings-v2-row"]')!
          .getBoundingClientRect()
        return error.left >= row.left - 1 && error.right <= row.right + 1
      })(),
    }
  })
  expect(verdict.noHorizontalScroll, JSON.stringify(verdict.widths)).toBe(true)
  expect(verdict.smallestLabel).toBeGreaterThanOrEqual(120)
  expect(verdict.scrollOwners).toBe(1)
  expect(verdict.errorInside).toBe(true)
})
