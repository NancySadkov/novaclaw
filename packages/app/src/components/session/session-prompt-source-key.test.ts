import { expect, test } from "bun:test"
import { promptSourceKey } from "./session-prompt-source-key"

test("a replacement chat and a mode change each get a fresh prompt read even when the session ID is reused", () => {
  const oldChat = promptSourceKey("server", "/project", "ses_sopitis", 100, 101)
  const clearedChat = promptSourceKey("server", "/project", "ses_sopitis", 200, 200)
  const switchedMode = promptSourceKey("server", "/project", "ses_sopitis", 200, 201)
  expect(clearedChat).not.toEqual(oldChat)
  expect(switchedMode).not.toEqual(clearedChat)
})
