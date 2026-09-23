import { expect, test } from "@playwright/test"
import { fixture } from "../smoke/session-timeline.fixture"
import { mockNovaClawServer } from "../utils/mock-server"

const server = `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4196"}`
const agent = {
  id: "officer-1",
  name: "Postal",
  title: "Email steward",
  kind: "agent",
  mode: "primary",
  workspace: fixture.directory,
}
const sessions = [{ ...fixture.sessions[0], id: "ses_postal", agent: agent.id, title: agent.name }]
const schedules = [
  {
    id: "sch_mail",
    agent: agent.id,
    title: "Mail triage",
    prompt: "Sort and reply to email",
    recurrence: { kind: "daily", time: { hour: 1, minute: 0 }, zone: "Europe/Berlin" },
    tzOffsetMin: 60,
    durationMinutes: 60,
    heartbeatMinutes: 10,
    escalateOnFailure: true,
    enabled: true,
    nextFireAt: Date.now() + 86_400_000,
    lastFiredAt: null,
    timeCreated: Date.now(),
    timeUpdated: Date.now(),
  },
  {
    id: "sch_digest",
    agent: agent.id,
    title: "Digest",
    prompt: "Summarize important mail",
    recurrence: { kind: "daily", time: { hour: 1, minute: 30 }, zone: "Europe/Berlin" },
    tzOffsetMin: 60,
    durationMinutes: 60,
    heartbeatMinutes: 10,
    escalateOnFailure: false,
    enabled: true,
    nextFireAt: Date.now() + 86_400_000,
    lastFiredAt: null,
    timeCreated: Date.now(),
    timeUpdated: Date.now(),
  },
]

test("an officer sees overlapping work windows and can edit their cadence on desktop and phone", async ({
  page,
}, info) => {
  const errors: string[] = []
  const creations: unknown[] = []
  const updates: unknown[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await mockNovaClawServer(page, {
    ...fixture,
    sessions,
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/api/agent", (route) =>
    route.fulfill({ headers: { "access-control-allow-origin": "*" }, json: { data: [agent] } }),
  )
  await page.route("**/*", (route) => {
    const path = new URL(route.request().url()).pathname
    if (path !== "/config" && path !== "/global/config") return route.fallback()
    return route.fulfill({
      json: {
        agents: {
          [agent.id]: {
            nudges: [
              {
                id: "low-resource",
                name: "Protect work when resources run low",
                enabled: true,
                hook: { type: "resource-pressure", level: "either" },
                text: "Check resource status before starting heavy work.",
              },
            ],
          },
        },
      },
    })
  })
  await page.route(/\/api\/agent\/officer-1\/schedule(?:\/fires|\/sch_mail)?$/, (route) => {
    if (route.request().method() === "POST") {
      creations.push(route.request().postDataJSON())
      return route.fulfill({ json: { ...schedules[0], id: "sch_new" } })
    }
    if (route.request().method() === "PATCH") {
      updates.push(route.request().postDataJSON())
      return route.fulfill({ json: schedules[0] })
    }
    return route.fulfill({ json: route.request().url().endsWith("/fires") ? [] : schedules })
  })
  await page.addInitScript(
    ({ server, sessions, directory }) => {
      localStorage.setItem("novaclaw.help.seen", "1")
      localStorage.setItem(
        "novaclaw.global.dat:tabs",
        JSON.stringify(
          sessions.map((session) => ({ type: "session", server, sessionId: session.id, agent: session.agent })),
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
  await page.goto("/tasks")
  await page.locator(`[data-contact-id="${agent.id}"]`).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Settings" }).click()
  const scheduleTab = page.getByRole("tab", { name: "Schedule" })
  try {
    await expect(scheduleTab).toBeVisible({ timeout: 5_000 })
  } catch (cause) {
    if (await page.getByRole("heading", { name: "Something went wrong" }).isVisible()) {
      await page.getByRole("button", { name: "Show technical details" }).click()
      throw new Error(
        `${await page.locator("[data-component=error-page] textarea").inputValue()}\n${errors.join("\n")}`,
      )
    }
    throw cause
  }
  await scheduleTab.click()
  const surface = page.locator(".schedule-surface")
  await expect(surface.getByRole("heading", { name: "Mail triage" })).toBeVisible()
  await expect(surface.getByRole("heading", { name: "Digest" })).toBeVisible()
  await expect(surface.getByText("overlap", { exact: true })).toHaveCount(2)
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(surface).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`schedule-${width}.png`) })
  }
  await surface.getByRole("article").first().getByRole("button", { name: "Edit" }).click()
  await surface.getByLabel("Heartbeat · minutes").fill("15")
  await surface.getByRole("button", { name: "Save task" }).click()
  await expect.poll(() => updates.length).toBe(1)
  expect(updates[0]).toMatchObject({
    recurrence: { kind: "daily", zone: "Europe/Berlin" },
    heartbeatMinutes: 15,
  })
  await surface.getByRole("button", { name: "New task" }).click()
  await expect(surface.getByRole("textbox", { name: "Task name" })).toBeVisible()
  await expect(surface.getByText("Escalate missed tasks", { exact: true })).toBeVisible()
  await surface.getByRole("textbox", { name: "Task name" }).fill("Morning replies")
  await surface.getByRole("textbox", { name: "Instructions" }).fill("Answer incoming email")
  await surface.getByLabel("Starts at").fill("01:00")
  await surface.getByLabel("Window length · minutes").fill("60")
  await surface.getByLabel("Heartbeat · minutes").fill("10")
  await surface.getByRole("button", { name: "Save task" }).click()
  await expect.poll(() => creations.length).toBe(1)
  expect(creations[0]).toMatchObject({
    title: "Morning replies",
    prompt: "Answer incoming email",
    recurrence: { kind: "daily", time: { hour: 1, minute: 0 } },
    durationMinutes: 60,
    heartbeatMinutes: 10,
    escalateOnFailure: true,
  })
  await expect(surface.getByRole("heading", { name: "New task" })).toHaveCount(0)
  await page.getByRole("tab", { name: "Nudges" }).click()
  const nudges = page.locator(".nudge-surface")
  await expect(nudges.getByRole("heading", { name: "Protect work when resources run low" })).toBeVisible()
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`nudges-${width}.png`) })
  }
  expect(errors).toEqual([])
})
