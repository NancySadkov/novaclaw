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
  await expect(page).toHaveURL(/\/settings\?/)
  const frame = page.locator('[data-component="app-page"]')
  await expect(frame).toBeVisible()
  const bounds = await frame.evaluate((element) => {
    const page = element.getBoundingClientRect()
    const area = element.closest("main")!.getBoundingClientRect()
    return { page: [page.x, page.y, page.width, page.height], area: [area.x, area.y, area.width, area.height] }
  })
  expect(bounds.page).toEqual(bounds.area)
  const tabs = page.getByRole("tablist").first()
  await expect(tabs).toHaveAttribute("aria-orientation", "horizontal")
  await expect(page.locator('[data-action="settings-profile-enabled"]')).toBeVisible()
  const general = page.getByRole("tab", { name: "General", exact: true })
  await general.focus()
  await page.keyboard.press("ArrowRight")
  await expect(general).not.toBeFocused()
  await expect(page.getByRole("tab", { name: "Appearance", exact: true })).toBeFocused()
  await expect(page.getByRole("radiogroup", { name: "Color scheme" })).toBeVisible()
  await page.mouse.move(2, 2)
  await page.screenshot({ path: info.outputPath("settings-phone.png") })
  await page.setViewportSize({ width: 1024, height: 820 })
  await expect(tabs).toHaveAttribute("aria-orientation", "vertical")
  await page.getByRole("button", { name: "Close" }).click()
  await expect(tabs).toBeHidden()
  await expect(page).toHaveURL("/")
  expect(errors).toEqual([])
})

test("messenger settings deep link opens the chosen officer and returns home", async ({ page }) => {
  await page.goto("/officers/officer-2/settings?tab=messengers&returnTo=%2F")
  await expect(page.getByRole("tab", { name: "Messengers", exact: true })).toHaveAttribute("data-active", "true")
  await page.locator('[data-action="agent-config-back"]').click()
  await expect(page).toHaveURL("/")
})

test("Storage budget controls fit a phone width", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("tab", { name: "Storage", exact: true }).click()
  if (await page.getByRole("heading", { name: "Something went wrong" }).isVisible()) {
    await page.getByRole("button", { name: "Show technical details" }).click()
    throw new Error(await page.getByRole("textbox", { name: "Error Details" }).inputValue())
  }
  for (const action of ["settings-database-budget", "settings-database-interval"]) {
    const control = page.locator(`[data-action="${action}"]`)
    await expect(control).toBeVisible()
    const bounds = await control.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  }
  await page.screenshot({ path: info.outputPath("storage-phone.png") })
})

test("About plays its soundtrack and releases it when the tab closes", async ({ page }, info) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack || error.message))
  await page.goto("/")
  await Promise.race([
    page.getByRole("button", { name: "Settings", exact: true }).waitFor(),
    page.getByRole("heading", { name: "Something went wrong" }).waitFor(),
  ])
  if (await page.getByRole("heading", { name: "Something went wrong" }).isVisible()) {
    await page.getByRole("button", { name: "Show technical details" }).click()
    throw new Error(await page.getByRole("textbox", { name: "Error Details" }).inputValue())
  }
  if (errors.length) throw new Error(errors.join("\n"))
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("tab", { name: "About", exact: true }).click()
  const about = page.locator(".settings-v2-about")
  await expect(about).toBeVisible()
  const audio = page.locator(".settings-v2-screen > audio")
  await expect.poll(() => audio.evaluate((element) => !(element as HTMLAudioElement).paused)).toBe(true)
  expect(await about.locator("canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0)
  await audio.evaluate((element) => (element as HTMLAudioElement).pause())
  const crawl = about.locator(".settings-v2-about-crawl")
  const position = await crawl.evaluate((element) => (element as HTMLElement).style.transform)
  await expect.poll(() => crawl.evaluate((element) => (element as HTMLElement).style.transform)).not.toBe(position)
  await page.screenshot({ path: info.outputPath("about-desktop.png") })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.getByRole("tab", { name: "About", exact: true }).evaluate((selected) => {
    const list = selected.closest('[data-slot="tabs-v2-list"]')!
    const tab = selected.getBoundingClientRect()
    const rail = list.getBoundingClientRect()
    return tab.left >= rail.left && tab.right <= rail.right
  })).toBe(true)
  await page.screenshot({ path: info.outputPath("about-phone.png") })
  const rail = page.getByRole("tablist").first()
  await rail.evaluate((element) => { element.scrollLeft = 0 })
  await rail.hover()
  await page.mouse.wheel(0, 280)
  await expect.poll(() => rail.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await page.evaluate(() => {
    ;(window as typeof window & { aboutAudio?: HTMLAudioElement }).aboutAudio = document.querySelector(".settings-v2-screen > audio") as HTMLAudioElement
  })
  await page.getByRole("tab", { name: "General", exact: true }).click()
  await expect(about).toHaveCount(0)
  expect(await page.evaluate(() => {
    const element = (window as typeof window & { aboutAudio?: HTMLAudioElement }).aboutAudio
    return { paused: element?.paused, src: element?.getAttribute("src") }
  })).toEqual({ paused: true, src: null })
  await page.getByRole("tab", { name: "About", exact: true }).click()
  await page.evaluate(() => {
    ;(window as typeof window & { aboutAudio?: HTMLAudioElement }).aboutAudio = document.querySelector(".settings-v2-screen > audio") as HTMLAudioElement
  })
  await page.getByRole("button", { name: "Close" }).click()
  await expect(page).toHaveURL("/")
  expect(await page.evaluate(() => {
    const element = (window as typeof window & { aboutAudio?: HTMLAudioElement }).aboutAudio
    return { paused: element?.paused, src: element?.getAttribute("src") }
  })).toEqual({ paused: true, src: null })
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
