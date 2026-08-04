import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { SessionWorkerCommand } from "./command"

test("resolves the standalone worker beside the Node server bundle", () => {
  const command = SessionWorkerCommand.make({
    moduleURL: pathToFileURL("C:/nova/dist/node/node.js").href,
    execPath: "C:/node/node.exe",
    electron: false,
  })
  expect(path.basename(command.workerPath)).toBe("session-worker-node.js")
  expect(command.command).toEqual(["C:/node/node.exe", command.workerPath])
  expect(command.env).toBeUndefined()
})

test("runs the packaged desktop worker through Electron's Node mode", () => {
  const command = SessionWorkerCommand.make({
    moduleURL: pathToFileURL("C:/Nova/resources/app.asar/out/main/chunks/novaclaw-server.js").href,
    execPath: "C:/Nova/NovaClaw.exe",
    electron: true,
  })
  expect(path.basename(command.workerPath)).toBe("novaclaw-session-worker.js")
  expect(command.command).toEqual(["C:/Nova/NovaClaw.exe", command.workerPath])
  expect(command.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" })
})

test("runs the source-mode worker from its real parent-directory entrypoint", () => {
  const command = SessionWorkerCommand.make({
    moduleURL: pathToFileURL("C:/nova/packages/novaclaw/src/session-worker/command.ts").href,
    execPath: "C:/bun.exe",
    electron: false,
  })
  expect(command.workerPath.replaceAll("\\", "/")).toEndWith("/src/session-worker-node.ts")
  expect(command.command).toEqual(["C:/bun.exe", command.workerPath])
})
