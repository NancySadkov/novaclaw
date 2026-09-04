import { afterEach, describe, expect, mock, test } from "bun:test"
import type { SessionMessage } from "@novaclaw/sdk/v2"
import { MarkedContext } from "@novaclaw/ui/context/marked"
import { render } from "solid-js/web"

// Bun does not apply Vite's `?worker&url` transform. Resolve the same canonical module before the
// transcript import so this browser test reaches the shipped Solid component, not a copied shell.
mock.module("../../session-ui/src/components/markdown-shiki.worker.ts?worker&url", () => ({ default: "worker.js" }))
const { NativeTranscript } = await import("@novaclaw/session-ui/v2/native-transcript")

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

const messages = [
  { id: "msg_user", type: "user", text: "Keep the complete log", time: { created: 1 } },
  {
    id: "msg_assistant",
    type: "assistant",
    agent: "hecate",
    model: { providerID: "spark", id: "current" },
    // A step timestamp may settle before its command does. This is the precise persisted shape that
    // used to make a remounted transcript mistake the still-working turn for foldable history.
    time: { created: 2, completed: 3 },
    content: [
      { id: "text_1", type: "text", text: "Durable output before leaving Chat" },
      {
        id: "call_1",
        type: "tool",
        name: "bash",
        time: { created: 4, ran: 5 },
        state: {
          status: "running",
          input: { command: "bun run test --only=typecheck" },
          structured: {},
          content: [],
        },
      },
    ],
  },
] as unknown as SessionMessage[]

function mount(onStopCommand?: (reason: string) => void | Promise<void>) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      <MarkedContext.Provider
        value={{ parser: { parse: async (text: string) => text }, resolveFile: () => undefined } as never}
      >
        <NativeTranscript messages={messages} status={{ type: "busy" } as never} onStopCommand={onStopCommand} />
      </MarkedContext.Provider>
    ),
    host,
  )
  return host
}

describe("native transcript remount", () => {
  test("keeps the complete persisted turn visible after leaving and reopening Chat", async () => {
    const first = mount()
    expect(first.textContent).toContain("Keep the complete log")
    expect(first.textContent).toContain("Durable output before leaving Chat")
    expect(first.querySelector('[data-slot="native-turn-work"]')).toBeNull()

    // Navigation destroys the route component; reopening Chat builds it from the same native store.
    dispose?.()
    dispose = undefined
    first.remove()
    let stoppedFor: string | undefined
    const reopened = mount((reason) => {
      stoppedFor = reason
    })

    expect(reopened.textContent).toContain("Keep the complete log")
    expect(reopened.textContent).toContain("Durable output before leaving Chat")
    expect(reopened.querySelector('[data-slot="native-turn-work"]')).toBeNull()

    // The full command is intentionally folded, but remains expandable while it is running.
    ;(reopened.querySelector('[data-slot="basic-tool-v2-trigger"]') as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reopened.textContent).toContain("bun run test --only=typecheck")

    const input = reopened.querySelector('[data-slot="native-command-stop"] input') as HTMLInputElement
    const stop = reopened.querySelector('[data-slot="native-command-stop"] button') as HTMLButtonElement
    expect(stop.disabled).toBe(true)
    input.value = "it has made no progress"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(stop.disabled).toBe(false)
    stop.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stoppedFor).toBe("it has made no progress")
  })
})
