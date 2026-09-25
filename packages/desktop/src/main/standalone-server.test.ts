import { afterEach, describe, expect, mock, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { killTreeSync } from "@novaclaw/core/util/kill-tree"
import type { DesktopLaunchOptions } from "./desktop-cli"
import type { ServiceInstancePaths } from "./instance-home-path"

/**
 * The standalone headless server is the default local server in a packaged build, so its owner is
 * exercised for real here — a fake `novaclaw serve` child that answers health and refuses to die on
 * a dispose — rather than asserted on by source regex.
 *
 * ⚠️ The `electron` and `./logging` stubs must stay EQUIVALENT to `server.test.ts`'s. Bun module
 * mocks are process-global and `bun test src` evaluates every file in one process, so the two files
 * share one `./logging` namespace: if either stub lacked `write`, the other file's module would call
 * an undefined function depending on test-file order.
 */
void mock.module("electron", () => ({
  default: {},
  app: {
    on: () => {},
    off: () => {},
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => tmpdir(),
  },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  utilityProcess: {
    fork: () => {
      throw new Error("the standalone owner must not fork an Electron utility process")
    },
  },
}))
void mock.module("./logging", () => ({
  getLogger: () => ({ log: () => {} }),
  write: () => {},
}))
void mock.module("./store", () => ({
  getStore: () => {
    throw new Error("getStore() is unreachable from the standalone owner")
  },
}))

const { createStandaloneServer } = await import("./standalone-server")

const roots: string[] = []
const spawned: number[] = []

afterEach(() => {
  for (const pid of spawned.splice(0)) if (isAlive(pid)) killTreeSync(pid)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fakeServerScript(root: string) {
  const script = join(root, "fake-novaclaw.mjs")
  writeFileSync(
    script,
    [
      'import http from "node:http"',
      'const port = Number(process.argv.find((arg) => arg.startsWith("--port=")).slice("--port=".length))',
      "const server = http.createServer((_request, response) => {",
      '  response.statusCode = 200',
      '  response.end(JSON.stringify({ healthy: true }))',
      "})",
      'server.listen(port, "127.0.0.1")',
    ].join("\n"),
  )
  return script
}

function instance(root: string): ServiceInstancePaths {
  return { instanceRoot: root, dataPath: join(root, "data"), homeOverride: undefined }
}

const OPTIONS = {
  hostname: "127.0.0.1",
  username: "novaclaw",
  password: "test-token",
  cors: [],
  mdns: false,
  mdnsDomain: "novaclaw.local",
  supervise: false,
} as DesktopLaunchOptions["server"]

function launchFor(script: string) {
  return {
    command: process.execPath,
    args: (port: number, password: string) => [script, "serve", `--port=${port}`, `--password=${password}`],
  }
}

function descriptor(root: string) {
  return JSON.parse(readFileSync(join(root, "standalone-server.json"), "utf8")) as { pid: number; port: number }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitGone(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!isAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe("standalone server owner", () => {
  test("starts the binary, publishes credentials from the live endpoint, and stops the tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "novaclaw-standalone-"))
    roots.push(root)
    const owner = createStandaloneServer(instance(root), OPTIONS, launchFor(fakeServerScript(root)))

    const started = await owner.start(new AbortController().signal)
    expect(started.credentials.username).toBe("novaclaw")
    expect(started.credentials.password).toBe("test-token")
    expect(started.credentials.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const spawnedPid = descriptor(root).pid
    spawned.push(spawnedPid)
    expect(isAlive(spawnedPid)).toBe(true)

    await owner.stop()
    await waitGone(spawnedPid)
    expect(isAlive(spawnedPid)).toBe(false)
    expect(existsSync(join(root, "standalone-server.json"))).toBe(false)
  })

  test("a retained server survives the client and is reused on the next start", async () => {
    const root = mkdtempSync(join(tmpdir(), "novaclaw-standalone-"))
    roots.push(root)
    const script = fakeServerScript(root)
    const first = createStandaloneServer(instance(root), OPTIONS, launchFor(script))
    const started = await first.start(new AbortController().signal)
    const spawnedPid = descriptor(root).pid
    spawned.push(spawnedPid)

    first.retain()
    await first.stop()
    expect(isAlive(spawnedPid)).toBe(true)
    expect(existsSync(join(root, "standalone-server.json"))).toBe(true)

    const second = createStandaloneServer(instance(root), OPTIONS, launchFor(script))
    const reused = await second.start(new AbortController().signal)
    expect(reused.credentials.url).toBe(started.credentials.url)

    await second.stop()
    await waitGone(spawnedPid)
    expect(isAlive(spawnedPid)).toBe(false)
  })
})
