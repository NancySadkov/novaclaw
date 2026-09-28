import { expect, test } from "@playwright/test"
import { fixture } from "../smoke/session-timeline.fixture"
import { mockNovaClawServer } from "../utils/mock-server"

test("preloaded officer tabs remain interactive across directory changes", async ({ page }) => {
  const server = `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4196"}`
  const agents = Array.from({ length: 6 }, (_, index) => ({
    id: `officer-${index}`,
    name: `Officer ${index}`,
    mode: "primary",
    kind: "agent",
  }))
  const diffs = Array.from({ length: 10411 }, (_, index) => ({
    file: `src/folder-${index % 100}/file-${index}.ts`,
    patch: `@@ -1 +1 @@\n-${"before".repeat(40)}\n+${"after".repeat(40)}\n`,
    additions: 1,
    deletions: 1,
    status: "modified",
  }))
  const sessions = agents.map((agent, index) => ({
    ...fixture.sessions[0],
    id: `ses_officer_${index}`,
    agent: agent.id,
    title: agent.name,
    location: { directory: `${fixture.directory}/${agent.id}` },
    summary: { additions: diffs.length, deletions: diffs.length, files: diffs.length, diffs },
  }))
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "warn" && message.text().includes("PromptInput instances")) errors.push(message.text())
  })
  await mockNovaClawServer(page, {
    ...fixture,
    sessions,
    pageMessages: (id) => ({
      items: [{ id: `msg_${id}`, type: "user", text: `Conversation ${id}`, time: { created: 1700000000000 } }],
    }),
  })
  const headers = { "access-control-allow-origin": "*" }
  await page.route("**/api/session/execution**", () => new Promise(() => {}))
  await page.route("**/api/instance/pressure", () => new Promise(() => {}))
  await page.route("**/api/agent", (route) => route.fulfill({ headers, json: { data: agents } }))
  await page.route(/\/api\/agent\/[^/]+\/chat$/, (route) => {
    const agent = new URL(route.request().url()).pathname.split("/").at(-2)
    const session = sessions.find((item) => item.agent === agent)!
    return route.fulfill({ headers, json: { data: { id: session.id, directory: session.location.directory } } })
  })
  await page.addInitScript(
    ({ server, agents }) => {
      localStorage.setItem("novaclaw.help.seen", "1")
      localStorage.setItem(
        "novaclaw.global.dat:tabs",
        JSON.stringify(agents.map((agent) => ({ type: "agent", server, agent: agent.id }))),
      )
    },
    { server, agents },
  )
  await page.goto("/")
  const tabs = page.locator('[data-slot="titlebar-tabs"] a')
  await expect(tabs).toHaveCount(6)
  await page.evaluate(() => {
    window.requestAnimationFrame = () => 1
  })
  for (let index = 0; index < 12; index++) {
    const selected = index % sessions.length
    await tabs.nth(selected).click()
    await expect(page.getByText(`Conversation ${sessions[selected].id}`, { exact: true })).toBeVisible({
      timeout: 3_000,
    })
    await expect(page.locator('[data-component="session-composer"] [contenteditable="true"]')).toBeVisible({
      timeout: 3_000,
    })
    expect(errors).toEqual([])
    await page.locator('[data-component="brand-home-button"]').click()
    await expect(page.locator('[data-home-app-id="contacts"] button')).toBeVisible({ timeout: 1_000 })
    await page.locator('[data-home-app-id="contacts"] button').click()
    await expect(page.locator(".officer-roster-toolbar")).toBeVisible({ timeout: 1_000 })
  }
})
