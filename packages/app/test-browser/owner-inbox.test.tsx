import { afterEach, expect, mock, test } from "bun:test"
import type { SessionMessage } from "@novaclaw/sdk/v2"
import { MarkedContext } from "@novaclaw/ui/context/marked"
import { render } from "solid-js/web"

mock.module("../../session-ui/src/components/markdown-shiki.worker.ts?worker&url", () => ({ default: "worker.js" }))
const { NativeTranscript } = await import("@novaclaw/session-ui/v2/native-transcript")

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

test("owner questions are expanded and a failed reply keeps its text and retry identity", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const calls: { message: string; text: string; id: string }[] = []
  const messages = [
    {
      id: "msg_question",
      type: "colleague",
      sender: "nova",
      senderSessionID: "ses_nova",
      text: "Which destination should I use?",
      time: { created: 1 },
    },
  ] as unknown as SessionMessage[]
  dispose = render(
    () => (
      <MarkedContext.Provider
        value={{ parser: { parse: async (text: string) => text }, resolveFile: () => undefined } as never}
      >
        <NativeTranscript
          messages={messages}
          status={{ type: "idle" } as never}
          onReplyColleague={async (message, text, id) => {
            calls.push({ message, text, id })
            if (calls.length === 1) throw new Error("Connection lost")
          }}
        />
      </MarkedContext.Provider>
    ),
    host,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.querySelector('[data-slot="basic-tool-v2-content"]')?.textContent).toContain("Which destination")
  const textarea = host.querySelector('textarea[aria-label="Reply to nova"]') as HTMLTextAreaElement
  expect(textarea).not.toBeNull()
  textarea.value = "Use Berlin."
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
  const form = host.querySelector("form")!
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(textarea.value).toBe("Use Berlin.")
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Connection lost")
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls).toHaveLength(2)
  expect(calls[0]).toEqual(calls[1])
  expect(calls[0]).toMatchObject({ message: "msg_question", text: "Use Berlin." })
  expect(textarea.value).toBe("")
  expect(host.querySelector('[role="alert"]')).toBeNull()
})
