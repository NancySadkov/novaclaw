import { expect, test } from "bun:test"

test("a confirmed-missing project is retired from client navigation state", async () => {
  const source = await Bun.file(new URL("./server-sync.tsx", import.meta.url)).text()
  const start = source.indexOf("await bootstrapDirectory({")
  const bootstrap = source.slice(start, source.indexOf("signal: lifetime.signal", start))
  expect(bootstrap).toContain("onDirectoryMissing: (missing) => projects.close(missing)")
})
