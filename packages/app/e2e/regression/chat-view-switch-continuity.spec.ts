import { base64Encode } from "@novaclaw/core/util/encode"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { fixture } from "../smoke/session-timeline.fixture"
import { mockNovaClawServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

test.use({ viewport: { width: 1440, height: 900 } })

test("a session-tab switch preserves the long-chat viewport and prompt caret", async ({ page }) => {
  const messageLoads: string[] = []
  await mockNovaClawServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: nativePageMessages,
    // Make the session handoff genuinely asynchronous. The timeline stays absent until its own
    // message load is authoritative; once it appears, no tall frame may expose the first message.
    messageDelay: 150,
    onMessages: ({ sessionID, phase }) => messageLoads.push(`${sessionID}:${phase}`),
  })
  await configureTabs(page)

  await page.goto(sessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  const review = page.getByRole("dialog", { name: "Review and files" })
  await review.getByRole("button", { name: "Close" }).click()
  await expect(page.locator('[data-component="native-timeline"]')).toBeVisible()
  const prompt = page.getByRole("textbox", { name: "Ask anything, / for commands, @ for context..." })
  await prompt.fill("hello")
  await setPromptCursor(prompt, 3)

  await startTimelineSampling(page)
  await switchSession(page, fixture.targetID)
  await expect.poll(() => messageLoads.join(",")).toContain(`${fixture.targetID}:end`)
  await expect(page.locator('[data-message-id="msg_switch_user_0059"]')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => targetTallFrameCount(page, fixture.targetID)).toBeGreaterThanOrEqual(30)
  const frames = await readTimelineSamples(page)
  const tall = frames.filter(
    (sample) => sample.sessionID === fixture.targetID && sample.scrollHeight > sample.clientHeight,
  )

  expect(tall.length).toBeGreaterThan(0)
  expect(
    tall.filter((sample) => sample.gap > 2),
    "a rendered target-session frame exposed transcript content above the latest row",
  ).toEqual([])

  await switchSession(page, fixture.sourceID)
  await expect(prompt).toHaveText("hello")
  await expect.poll(() => promptCursor(prompt)).toBe(3)
})

async function configureTabs(page: Page) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4196"}`
  await page.addInitScript(
    ({ directory, dirBase64, server, sessionIDs }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "novaclaw.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "novaclaw.global.dat:tabs",
        JSON.stringify(sessionIDs.map((sessionId) => ({ type: "session", server, dirBase64, sessionId }))),
      )
    },
    {
      directory: fixture.directory,
      dirBase64: base64Encode(fixture.directory),
      server,
      sessionIDs: [fixture.sourceID, fixture.targetID],
    },
  )
}

const longMessages = Array.from({ length: 60 }, (_, index) => {
  const created = 1_700_000_000_000 + index * 2
  return [
    {
      id: `msg_switch_user_${String(index).padStart(4, "0")}`,
      type: "user" as const,
      text: `Message ${index}: ${"long session history ".repeat(18)}`,
      time: { created },
    },
    {
      id: `msg_switch_assistant_${String(index).padStart(4, "0")}`,
      type: "assistant" as const,
      agent: "build",
      model: { providerID: "novaclaw", id: "claude-opus-4-6" },
      content: [
        {
          id: `txt_switch_assistant_${String(index).padStart(4, "0")}`,
          type: "text" as const,
          text: `## Result ${index}\n\n${"Rendered assistant history with **markdown**. ".repeat(24)}`,
        },
      ],
      time: { created: created + 1, completed: created + 1 },
      finish: "stop",
    },
  ]
}).flat()

function nativePageMessages(sessionID: string, limit: number, before?: string) {
  const messages =
    sessionID === fixture.targetID
      ? longMessages
      : [{ id: "msg_switch_source", type: "user", text: "Source chat", time: { created: 1_700_000_000_000 } }]
  const end = before ? Math.max(0, messages.findIndex((message) => message.id === before)) : messages.length
  const start = Math.max(0, end - limit)
  return { items: messages.slice(start, end), cursor: start > 0 ? messages[start]!.id : undefined }
}

function sessionHref(sessionID: string) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4196"}`
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

async function switchSession(page: Page, sessionID: string) {
  const href = sessionHref(sessionID)
  const tab = page.locator(`[data-slot="titlebar-tabs"] a[href="${href}"]`).first()
  await expect(tab).toBeVisible()
  await tab.click()
  await expect(page).toHaveURL(new RegExp(`${sessionID}$`))
}

type TimelineSample = {
  sessionID?: string
  scrollHeight: number
  scrollTop: number
  clientHeight: number
  gap: number
}

function startTimelineSampling(page: Page) {
  return page.evaluate(() => {
    const state = window as typeof window & { __chatViewSamples?: TimelineSample[]; __chatViewSampling?: boolean }
    state.__chatViewSamples = []
    state.__chatViewSampling = true
    const sample = () => {
      if (!state.__chatViewSampling) return
      const timeline = document.querySelector<HTMLElement>('[data-component="native-timeline"]')
      const sessionID = location.pathname.match(/\/session\/([^/]+)$/)?.[1]
      if (timeline) {
        state.__chatViewSamples!.push({
          sessionID,
          scrollHeight: timeline.scrollHeight,
          scrollTop: timeline.scrollTop,
          clientHeight: timeline.clientHeight,
          gap: timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight,
        })
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
}

function readTimelineSamples(page: Page) {
  return page.evaluate(() => {
    const state = window as typeof window & {
      __chatViewSamples?: Array<{
        sessionID?: string
        scrollHeight: number
        scrollTop: number
        clientHeight: number
        gap: number
      }>
      __chatViewSampling?: boolean
    }
    state.__chatViewSampling = false
    return state.__chatViewSamples ?? []
  })
}

function targetTallFrameCount(page: Page, sessionID: string) {
  return page.evaluate((sessionID) => {
    const state = window as typeof window & { __chatViewSamples?: TimelineSample[] }
    return (state.__chatViewSamples ?? []).filter(
      (sample) => sample.sessionID === sessionID && sample.scrollHeight > sample.clientHeight,
    ).length
  }, sessionID)
}

function setPromptCursor(prompt: Locator, offset: number) {
  return prompt.evaluate((editor, offset) => {
    const node = editor.firstChild
    if (!node) throw new Error("prompt has no text node")
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
  }, offset)
}

function promptCursor(prompt: Locator) {
  return prompt.evaluate((editor) => {
    const selection = window.getSelection()
    if (!selection?.anchorNode || !editor.contains(selection.anchorNode)) return -1
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.setEnd(selection.anchorNode, selection.anchorOffset)
    return range.toString().replaceAll("\u200B", "").length
  })
}
