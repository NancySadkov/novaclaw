import { expect, test } from "@playwright/test"
import { fixture } from "../smoke/session-timeline.fixture"
import { mockNovaClawServer } from "../utils/mock-server"

const server = `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4196"}`
const names = ["Nova", "Iris Vale", "Theron", "Violeta", "Cassian", "Sable"]
const agents = names.map((name, index) => ({
  id: index === 0 ? "nova" : `officer-${index}`,
  name,
  title: [
    "Instance steward",
    "Research & discovery",
    "Systems architect",
    "Creative director",
    "Quality engineer",
    "Knowledge curator",
  ][index],
  mode: "primary",
  kind: "agent",
  avatar: index < 2 ? `/api/agent/${index === 0 ? "nova" : "officer-1"}/avatar` : undefined,
  workspace: fixture.directory,
}))
const sessions = agents.map((agent, index) => ({
  ...fixture.sessions[0],
  id: `ses_compact_${index}`,
  agent: agent.id,
  title: agent.name,
}))
test.beforeEach(async ({ page }) => {
  await mockNovaClawServer(page, {
    ...fixture,
    sessions,
    pageMessages: () => ({
      items: [
        {
          id: "msg_compact_user",
          type: "user",
          text: "A compact workgroup, ready for the next task.",
          time: { created: 1700000000000 },
        },
        {
          id: "msg_compact_reply",
          type: "assistant",
          agent: "nova",
          model: { providerID: "novaclaw", id: "claude-opus-4-6" },
          content: [
            {
              id: "txt_compact_reply",
              type: "text",
              text: "Your officers are ready. Open an app, or choose an officer above to continue your conversation.",
            },
          ],
          time: { created: 1700000000001, completed: 1700000000002 },
          finish: "stop",
        },
      ],
    }),
  })
  const headers = { "access-control-allow-origin": "*" }
  await page.route("**/api/policy", (route) =>
    route.fulfill({ headers, json: { installed: [], requested: [], missing: [], disabledButRequested: [] } }),
  )
  await page.route("**/api/telemetry/status", (route) =>
    route.fulfill({
      headers,
      json: { gate: { airgap: false, consent: true }, endpointConfigured: false, ready: false },
    }),
  )
  await page.route("**/api/instance/pty?*", (route) => route.fulfill({ headers, json: [] }))
  await page.route("**/api/agent", (route) => route.fulfill({ headers, json: { data: agents } }))
  await page.route("**/api/agent/nova/avatar", (route) =>
    route.fulfill({ headers, path: "public/assets/skin/logo-nobg.png" }),
  )
  // An image response can still fail to decode. It must fall back to officer initials.
  await page.route("**/api/agent/officer-1/avatar", (route) =>
    route.fulfill({ headers, contentType: "image/png", body: "invalid image" }),
  )
  await page.addInitScript(
    ({ server, sessions, directory }) => {
      localStorage.setItem("novaclaw.help.seen", "1")
      localStorage.setItem(
        "novaclaw.global.dat:tabs",
        JSON.stringify(
          sessions.map((s) => ({
            type: "session",
            server,
            sessionId: s.id,
            agent: s.agent,
          })),
        ),
      )
      localStorage.setItem(
        "novaclaw.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
    },
    { server, sessions, directory: fixture.directory },
  )
})

test("officer tiles keep dimensions across widths and expose actions without clutter", async ({ page }, info) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/tasks")
  const cards = page.locator("[data-contact-id]")
  await expect(cards).toHaveCount(6)
  const rowCounts: number[] = []
  for (const width of [390, 768, 1280, 1600]) {
    await page.setViewportSize({ width, height: 900 })
    const boxes = await cards.evaluateAll((elements) =>
      elements.map((el) => {
        const box = el.getBoundingClientRect()
        return { width: box.width, height: box.height, y: box.y }
      }),
    )
    expect(boxes.every((box) => box.width === 224 && box.height === 276)).toBe(true)
    rowCounts.push(boxes.filter((box) => box.y === boxes[0]!.y).length)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`officers-${width}.png`) })
  }
  expect(rowCounts).toEqual([1, 3, 5, 6])
  await expect(cards.locator('[data-action="contacts-clone"], [data-action="contacts-reorder"]')).toHaveCount(0)
  await expect(page.getByText("CEO", { exact: true })).toHaveCount(0)
  const iris = page.locator('[data-contact-id="officer-1"]')
  await iris.click({ button: "right" })
  const menu = page.getByRole("menu")
  await expect(menu).toBeVisible()
  await expect(menu.getByRole("menuitem")).toHaveCount(4)
  await page.screenshot({ path: info.outputPath("officer-menu.png") })
  await menu.getByRole("menuitem", { name: "Settings", exact: true }).click()
  await expect(page).toHaveURL(/officers\/officer-1\/settings/)
  const settings = page.locator('[data-component="agent-settings"]')
  await expect(settings.locator('[data-slot="agent-settings-actions"]')).toBeVisible()
  await expect(settings.getByRole("button", { name: "Close", exact: true })).toHaveCount(0)
  await expect(settings.locator('[data-action="agent-clear-chat"]')).toHaveCount(0)
  await page.locator('[data-slot="titlebar-tabs"]').getByRole("link", { name: "Theron", exact: true }).click()
  await expect(page).toHaveURL(/officers\/officer-2\/settings/)
  await expect(settings.getByText("Theron", { exact: true }).first()).toBeVisible()
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await page.screenshot({ path: info.outputPath(`officer-settings-${width}.png`) })
    const actions = await settings.locator('[data-slot="agent-settings-actions"]').boundingBox()
    expect(actions!.x + actions!.width).toBeLessThanOrEqual(width)
  }
  expect(errors).toEqual([])
})

test.describe("touch cards", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  test("holding opens actions without selecting the chat", async ({ page }) => {
    await page.goto("/tasks")
    const card = page.locator('[data-contact-id="officer-1"]')
    await card.scrollIntoViewIfNeeded()
    const box = await card.boundingBox()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box!.x + 100, y: box!.y + 80 }],
    })
    await expect(page.getByRole("menu")).toBeVisible()
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await expect(page).toHaveURL(/tasks$/)
    await expect(page.getByRole("menuitem")).toHaveCount(4)
  })
})

test("whole-card dragging persists arrangement and releasing does not open chat", async ({ page }) => {
  let config: Record<string, unknown> = {}
  const writes: Record<string, unknown>[] = []
  await page.route("**/global/config", async (route) => {
    if (route.request().method() === "PATCH") {
      config = { ...config, ...route.request().postDataJSON() }
      if (Array.isArray(config.officer_order)) writes.push(config)
    }
    await route.fulfill({ headers: { "access-control-allow-origin": "*" }, json: config })
  })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto("/tasks")
  const source = page.locator('[data-contact-id="officer-1"]')
  const destination = page.locator('[data-contact-id="officer-2"]')
  const from = await source.boundingBox()
  const to = await destination.boundingBox()
  await page.mouse.move(from!.x + 110, from!.y + 80)
  await page.mouse.down()
  await page.mouse.move(to!.x + 110, to!.y + 80, { steps: 12 })
  await page.mouse.up()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]!.officer_order).toEqual(["officer-4", "officer-5", "officer-2", "officer-1", "officer-3"])
  await expect(page).toHaveURL(/tasks$/)
  await page.reload()
  await expect(page.locator("[data-contact-id]")).toHaveCount(6)
  expect(
    await page.locator("[data-contact-id]").evaluateAll((els) => els.map((el) => el.getAttribute("data-contact-id"))),
  ).toEqual(["nova", "officer-4", "officer-5", "officer-2", "officer-1", "officer-3"])
})

test("Clear Chat lives in the Context Inspector and requires confirmation", async ({ page }) => {
  await page.goto("/")
  await page.locator('[data-slot="titlebar-tabs"]').getByRole("link", { name: "Theron", exact: true }).click()
  await expect(page.locator('[data-component="native-timeline"]')).toBeVisible()
  await page.getByRole("button", { name: "View context usage" }).click()
  const inspector = page.getByRole("dialog", { name: "Review and files" })
  const clear = inspector.locator('[data-action="agent-clear-chat"]')
  await expect(clear).toBeVisible()
  await clear.click()
  await expect(page.getByText("Clear your chat with Theron?", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(inspector).toBeVisible()
  await expect(page).toHaveURL(/ses_compact_2$/)
})
