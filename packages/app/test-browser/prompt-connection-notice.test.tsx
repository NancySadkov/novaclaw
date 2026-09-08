import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { PromptConnectionBoundary, PromptConnectionNotice } from "@/components/prompt-input/connection-notice"

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

describe("the reconnect state replaces the prompt with a calm numbered status", () => {
  test("the actual status surface renders the attempt and remains an announcement", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    dispose = render(() => <PromptConnectionNotice attempt={4} text="Connection Lost. Reconnecting Attempt 4" />, host)

    const notice = host.querySelector<HTMLElement>('[data-slot="prompt-reconnecting"]')
    expect(notice?.textContent).toBe("Connection Lost. Reconnecting Attempt 4")
    expect(notice?.getAttribute("role")).toBe("status")
    expect(notice?.getAttribute("aria-live")).toBe("polite")
    expect(notice?.dataset.attempt).toBe("4")
    expect(notice?.classList.contains("min-h-[96px]")).toBe(true)
  })

  test("a real reactive disconnect replaces the prompt and reconnect restores the same mounted draft", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const [attempt, setAttempt] = createSignal<number | undefined>(undefined)
    dispose = render(
      () => (
        <PromptConnectionBoundary
          attempt={attempt()}
          text={(value) => `Connection Lost. Reconnecting Attempt ${value}`}
        >
          <form data-slot="real-prompt">
            <input value="draft survives" />
          </form>
        </PromptConnectionBoundary>
      ),
      host,
    )

    const content = () => host.querySelector<HTMLElement>('[data-slot="prompt-connected-content"]')
    const prompt = host.querySelector<HTMLInputElement>('[data-slot="real-prompt"] input')
    expect(host.querySelector('[data-slot="prompt-reconnecting"]')).toBeNull()
    expect(content()?.classList.contains("contents")).toBe(true)

    setAttempt(3)
    expect(host.querySelector('[data-slot="prompt-reconnecting"]')?.textContent).toBe(
      "Connection Lost. Reconnecting Attempt 3",
    )
    expect(content()?.classList.contains("hidden")).toBe(true)
    expect(content()?.getAttribute("aria-hidden")).toBe("true")
    expect(host.contains(prompt)).toBe(true)

    setAttempt(undefined)
    expect(host.querySelector('[data-slot="prompt-reconnecting"]')).toBeNull()
    expect(content()?.classList.contains("contents")).toBe(true)
    expect(content()?.getAttribute("aria-hidden")).toBe("false")
    expect(prompt?.value).toBe("draft survives")
  })
})
