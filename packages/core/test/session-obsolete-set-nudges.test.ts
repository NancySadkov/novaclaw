import { expect, test } from "bun:test"

const runner = await Bun.file(new URL("../src/session/runner/llm.ts", import.meta.url)).text()
const setRules = await Bun.file(new URL("../src/session/runner/unfinished-set.ts", import.meta.url)).text()

test("obsolete file-list enforcement can no longer steer an agent", () => {
  for (const text of [runner, setRules]) {
    expect(text).not.toContain("A filename is not a picture")
    expect(text).not.toContain("Do not describe a file you have not opened")
    expect(text).not.toContain("Not finished: you have opened")
    expect(text).not.toContain("UnfinishedSet.groundingMessage")
    expect(text).not.toContain("UnfinishedSet.continueMessage")
  }
})
