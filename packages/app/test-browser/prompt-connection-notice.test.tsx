import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { PromptConnectionNotice } from "@/components/prompt-input/connection-notice"

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
})
