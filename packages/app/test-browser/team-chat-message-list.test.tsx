import { afterEach, expect, test } from "bun:test"
import { render } from "solid-js/web"
import {
  anchoredScrollTop,
  captureTeamChatScrollAnchor,
  isTeamChatPinned,
  mergeTeamChatMessages,
  restoreTeamChatScrollAnchor,
  TeamChatMessageList,
} from "@/components/team-chat-dialog"
import { LanguageContext } from "@/context/language"
import { ServerContext } from "@/context/server"

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

test("renders a subordinate-to-subordinate message with the sender portrait and both names", () => {
  const host = document.createElement("div")
  document.body.append(host)
  const language = { intl: () => "en" }

  dispose = render(
    () => (
      <ServerContext.Provider value={{ current: undefined } as never}>
        <LanguageContext.Provider value={language as never}>
          <TeamChatMessageList
            roster={[
              { id: "iris", name: "Iris", avatar: "I", mode: "primary", hidden: false },
              { id: "lyra", name: "Lyra", avatar: "L", mode: "primary", hidden: false },
            ]}
            messages={[
              {
                id: "msg_team",
                sender: "iris",
                recipient: "lyra",
                turn: "ask",
                text: "Please verify the release hash.",
                created: 1_790_268_000_000,
              },
            ]}
          />
        </LanguageContext.Provider>
      </ServerContext.Provider>
    ),
    host,
  )

  expect(host.textContent).toContain("Iris")
  expect(host.textContent).toContain("→ Lyra")
  expect(host.textContent).toContain("Please verify the release hash.")
  expect(host.textContent).toContain("I")
  expect(host.querySelector("article [aria-hidden=true]")).not.toBeNull()
})

test("live pages merge without duplicates and keep chronological order", () => {
  const message = (id: string, created: number) => ({
    id,
    sender: "iris",
    recipient: "lyra",
    turn: "ask" as const,
    text: id,
    created,
  })
  expect(
    mergeTeamChatMessages([message("two", 2)], [message("three", 3), message("two", 2), message("one", 1)]),
  ).toEqual([message("one", 1), message("two", 2), message("three", 3)])
})

test("new messages follow only a viewport pinned to the bottom and older pages preserve its anchor", () => {
  expect(isTeamChatPinned(776, 200, 1_000)).toBe(true)
  expect(isTeamChatPinned(500, 200, 1_000)).toBe(false)
  expect(anchoredScrollTop(500, 1_000, 1_360)).toBe(860)
})

test("older-page insertion restores the same visible message even if other messages append", () => {
  const scroller = document.createElement("div")
  const above = document.createElement("article")
  const anchor = document.createElement("article")
  above.dataset.teamChatMessage = "above"
  anchor.dataset.teamChatMessage = "anchor"
  scroller.append(above, anchor)
  scroller.scrollTop = 50
  scroller.getBoundingClientRect = () => ({ top: 100 } as DOMRect)
  above.getBoundingClientRect = () => ({ top: 50, bottom: 90 } as DOMRect)
  anchor.getBoundingClientRect = () => ({ top: 120, bottom: 150 } as DOMRect)

  const captured = captureTeamChatScrollAnchor(scroller)
  expect(captured).toEqual({ id: "anchor", top: 120 })

  const appendedTail = document.createElement("article")
  appendedTail.dataset.teamChatMessage = "tail"
  scroller.append(appendedTail)
  anchor.getBoundingClientRect = () => ({ top: 200, bottom: 230 } as DOMRect)
  expect(restoreTeamChatScrollAnchor(scroller, captured!)).toBe(true)
  expect(scroller.scrollTop).toBe(130)
})
