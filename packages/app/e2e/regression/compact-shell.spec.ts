import { expect, test } from "@playwright/test"
import { fixture } from "../smoke/session-timeline.fixture"
import { mockNovaClawServer } from "../utils/mock-server"

const server = `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4196"}`
const names = ["Nova", "Iris Vale", "Theron", "Violeta", "Cassian", "Sable"]
const agents = names.map((name, index) => ({
  id: index === 0 ? "nova" : `officer-${index}`,
  name,
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

for (const viewport of [
  { width: 320, height: 820 },
  { width: 390, height: 820 },
  { width: 768, height: 820 },
  { width: 1280, height: 820 },
  { width: 844, height: 390 },
]) {
  const { width, height } = viewport
  test(`launcher and six officer tabs fit at ${width}x${height}`, async ({ page }, info) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setViewportSize(viewport)
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Contacts", exact: true })).toBeVisible()
    const strip = page.locator('[data-slot="titlebar-tabs"]')
    await expect(strip.locator("a")).toHaveCount(6)
    for (const name of names) await expect(strip.getByRole("link", { name, exact: true })).toBeVisible()
    await expect(
      strip.getByRole("link", { name: "Iris Vale", exact: true }).locator('[data-slot="agent-tab-portrait"]'),
    ).toHaveText("IV")
    await expect(strip.getByRole("link", { name: "Nova", exact: true }).locator("img")).toBeVisible()
    expect(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    for (const name of names) {
      const box = await strip.getByRole("link", { name, exact: true }).boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    }
    if (width < 768) await expect(strip.locator("[data-titlebar-tab-title]").first()).toBeHidden()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath("home.png") })

    await strip.getByRole("link", { name: "Sable", exact: true }).click()
    await expect(page).toHaveURL(new RegExp(sessions[5]!.id + "$"))
    await expect(page.getByRole("button", { name: /toggle review/i })).toHaveCount(0)
    const dialog = page.getByRole("dialog", { name: "Review and files" })
    await expect(page.locator('[data-component="native-timeline"]')).toBeVisible()
    await expect(dialog).toBeHidden()
    await page.screenshot({ path: info.outputPath("session.png") })
    const context = page.getByRole("button", { name: "View context usage" })
    await context.click()
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveCSS("background-color", "rgb(18, 9, 30)")
    await expect(dialog.getByRole("tab", { name: "Context", exact: true })).toHaveAttribute("aria-selected", "true")
    const rect = await dialog.boundingBox()
    expect(rect!.x).toBeGreaterThanOrEqual(0)
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width)
    expect(rect!.y).toBeGreaterThanOrEqual(0)
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(height)
    await page.screenshot({ path: info.outputPath("context.png") })
    await page.keyboard.press("Tab")
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
    await expect(context).toBeFocused()
    if (width === 320) {
      await context.click()
      await expect(dialog).toBeVisible()
      await page.reload()
      await expect(page.locator('[data-component="native-timeline"]')).toBeVisible()
      await expect(dialog).toBeHidden()
    }
    expect(errors).toEqual([])
  })
}

test("settings switches its navigation orientation when a phone rotates", async ({ page }, info) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const tabs = page.getByRole("tablist").first()
  await expect(tabs).toHaveAttribute("aria-orientation", "horizontal")
  const general = page.getByRole("tab", { name: "General", exact: true })
  await general.focus()
  await page.keyboard.press("ArrowRight")
  await expect(general).not.toBeFocused()
  await expect(page.getByRole("tab", { name: "Appearance", exact: true })).toBeFocused()
  await page.mouse.move(2, 2)
  await page.screenshot({ path: info.outputPath("settings-phone.png") })
  await page.setViewportSize({ width: 1024, height: 820 })
  await expect(tabs).toHaveAttribute("aria-orientation", "vertical")
  await page.keyboard.press("Escape")
  await expect(tabs).toBeHidden()
  expect(errors).toEqual([])
})

test.describe("touch navigation", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test("portrait tabs accept taps and preserve their order", async ({ page }) => {
    await page.goto("/")
    const strip = page.locator('[data-slot="titlebar-tabs"]')
    await expect(strip.locator("a")).toHaveCount(6)
    await strip.getByRole("link", { name: "Sable", exact: true }).tap()
    await expect(page).toHaveURL(new RegExp(sessions[5]!.id + "$"))
    const dialog = page.getByRole("dialog", { name: "Review and files" })
    await expect(page.locator('[data-component="native-timeline"]')).toBeVisible()
    await expect(dialog).toBeHidden()
    await strip.getByRole("link", { name: "Iris Vale", exact: true }).tap()
    await expect(page).toHaveURL(new RegExp(sessions[1]!.id + "$"))
    await expect(strip.getByRole("link", { name: "Iris Vale", exact: true })).toHaveAttribute("aria-current", "page")
    expect(
      await strip.locator("a").evaluateAll((links) => links.map((link) => link.getAttribute("aria-label"))),
    ).toEqual(names)
  })
})
