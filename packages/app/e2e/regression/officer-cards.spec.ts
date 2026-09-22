import { expect, test, type Page } from "@playwright/test"
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
/**
 * A card's selector, built from the SAME id the fixture hands the server.
 *
 * ⚠️ Written as a template, never with a hardcoded id, and the reason is a gate rather than taste:
 * the card binds `data-contact-id={props.view.id}` (`pages/contacts.tsx`), so the id is DATA and
 * appears in no source file. `packages/core/test/e2e-selector-rot.test.ts` is the static guard that
 * catches a spec steering by markup nothing renders; a hardcoded id it cannot resolve is reported as
 * rot, while the template form is recognised as dynamic and checked at the attribute level — which is
 * the honest description of a server-supplied id.
 */
const officerCard = (page: Page, id: string) => page.locator(`[data-contact-id="${id}"]`)
const cardId = (index: number) => agents[index]!.id
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
  page.on("pageerror", (error) => errors.push(error.stack || error.message))
  await page.goto("/")
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    const tiles = page.locator('.home-app:not([data-hero="true"])')
    await expect(tiles.first()).toBeVisible()
    const box = await tiles.first().boundingBox()
    expect(box!.width).toBe(width === 390 ? 77 : 84)
    expect(box!.height).toBe(108)
    await expect(tiles.first().locator(".home-app-icon")).toHaveCSS("width", "64px")
    await page.screenshot({ path: info.outputPath(`home-${width}.png`) })
  }
  await page.goto("/tasks")
  const cards = page.locator("[data-contact-id]")
  await expect(cards).toHaveCount(6)
  await expect(cards.first().locator(".officer-card-portrait")).toHaveCSS("width", "90px")
  await expect(cards.first().locator(".officer-card-portrait")).toHaveCSS("height", "90px")
  const rowCounts: number[] = []
  for (const width of [320, 360, 390, 768, 1280, 1600]) {
    await page.setViewportSize({ width, height: 900 })
    const boxes = await cards.evaluateAll((elements) =>
      elements.map((el) => {
        const box = el.getBoundingClientRect()
        return { width: box.width, height: box.height, y: box.y }
      }),
    )
    expect(boxes.every((box) => box.width === 150 && box.height === 185)).toBe(true)
    rowCounts.push(boxes.filter((box) => box.y === boxes[0]!.y).length)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`officers-${width}.png`) })
  }
  expect(rowCounts).toEqual([2, 2, 2, 4, 6, 6])
  // The card must expose NO inline clone control: cloning lives in the right-click menu below.
  // `contacts-reorder` is not asserted alongside it any more — the RPG-card pass (2026-09-21,
  // `ba3fce31f`) removed that attribute entirely and moved reordering onto drag + alt-arrow
  // (`aria-description` = `contacts.order.hint`), which the drag test below covers. Asserting a
  // removed attribute is a claim nothing can falsify, and the static selector guard rightly reads
  // it as rot.
  await expect(cards.locator('[data-action="contacts-clone"]')).toHaveCount(0)
  await expect(page.getByText("CEO", { exact: true })).toHaveCount(0)
  const iris = officerCard(page, cardId(1))
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
    await page.setViewportSize({ width: 390, height: 420 })
    const touch = await page.context().newCDPSession(page)
    const first = await officerCard(page, cardId(4)).boundingBox()
    const x = first!.x + 75
    const y = first!.y + 120
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
    for (const dy of [20, 40, 60, 80, 100]) {
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - dy }] })
    }
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await expect
      .poll(() => page.locator('[data-slot="officer-roster-scroll"]').evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0)
    await expect(page.getByRole("menu")).toHaveCount(0)
    await expect(page).toHaveURL(/tasks$/)
    const card = officerCard(page, cardId(1))
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
  const source = officerCard(page, cardId(1))
  const destination = officerCard(page, cardId(2))
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
  await page.route(/\/api\/session\/[^/]+\/worker(?:\?.*)?$/, (route) =>
    route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: { data: [{ id: "ses_worker", title: "Research", startedAt: 1700000000000 }] },
    }),
  )
  await page.route(/\/api\/session\/[^/]+\/command(?:\?.*)?$/, (route) =>
    route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: {
        data: [{ id: "shell_one", sessionID: "ses_compact_2", command: "echo ready", startedAt: 1700000000000 }],
      },
    }),
  )
  await page.goto("/")
  await page.locator('[data-slot="titlebar-tabs"]').getByRole("link", { name: "Theron", exact: true }).click()
  await expect(page.locator('[data-component="native-timeline"]')).toBeVisible()
  const context = page.getByRole("button", { name: "View context usage" })
  const workers = page.locator('[data-action="prompt-workers"]')
  const commands = page.locator('[data-action="prompt-shells"]')
  await expect(workers).toBeVisible()
  await expect(commands).toBeVisible()
  const contextBox = await context.boundingBox()
  const workerBox = await workers.boundingBox()
  const commandBox = await commands.boundingBox()
  expect(workerBox!.x).toBeGreaterThan(contextBox!.x)
  expect(commandBox!.x).toBeGreaterThan(workerBox!.x)
  await context.click()
  const inspector = page.getByRole("dialog", { name: "Review and files" })
  const clear = inspector.locator('[data-action="agent-clear-chat"]')
  await expect(clear).toBeVisible()
  await clear.click()
  await expect(page.getByText("Clear your chat with Theron?", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(inspector).toBeVisible()
  await expect(page).toHaveURL(/ses_compact_2$/)
})
