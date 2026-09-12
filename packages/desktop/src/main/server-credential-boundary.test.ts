import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("the Electron wrapper applies credentials inside the separately bundled server runtime", () => {
  const sidecar = readFileSync(new URL("./sidecar.ts", import.meta.url), "utf8")
  const nodeEntry = readFileSync(new URL("../../../novaclaw/src/node.ts", import.meta.url), "utf8")
  expect(nodeEntry).toContain("export function configureServerLaunchCredential")
  expect(sidecar).toContain("configureServerLaunchCredential({ password: command.password, username: command.username })")
  expect(sidecar.indexOf("configureServerLaunchCredential({")).toBeLessThan(sidecar.indexOf("Server.listen({"))
})
