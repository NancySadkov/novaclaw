import { afterAll, describe, expect, mock, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

/**
 * A store name is a FILE PATH, and the renderer picks it.
 *
 * `electron-store` renames `name` to `configName` and hands it to `conf`, which computes the file as
 * `path.resolve(cwd, configName)`. `path.resolve` given an ABSOLUTE segment discards its base
 * entirely, and given `..` walks out of it — so the six `store-*` IPC channels were an arbitrary-path
 * read AND an arbitrary-path write anywhere the Electron main process can reach, driven from the
 * least trusted process in the product. That is design principle 11 (the filesystem outside the home
 * instance dirs, the OS temp dir and the session's working folder is read-only to us) broken by the
 * widest possible margin.
 *
 * Every path this file touches lives under the OS temp dir — including the one the traversal case
 * aims at, which is asserted ABSENT rather than merely unwritten.
 *
 * ⚠️ Mock scope: bun module mocks are process-global and the package unit runs `bun test src` in one
 * process, so the `electron` stub below is shared property, not this file's private fixture.
 *
 * MEASURED, not assumed: the FIRST registration for a specifier fixes that module's export NAME set
 * for the whole run. An earlier draft of this stub omitted `utilityProcess`, and `server.test.ts`
 * plus `supervise-faults.test.ts` — which register their own `electron` stub and import it later —
 * went from 11 pass to a link-time `SyntaxError: Export named 'utilityProcess' not found`. So this
 * stub exports the UNION of every name `src/` imports from `electron`, and `utilityProcess.fork`
 * defers to the same `globalThis` slot those two files use, so it behaves identically whichever
 * registration wins. Keep it a superset; a name deleted from here is a failure in another file.
 *
 * This file deliberately registers NO mock for `./store` (the module under test) or `./logging`.
 */
const FORK_SLOT = Symbol.for("novaclaw.desktop.test.sidecar-fork")
const forkSlot = globalThis as unknown as Record<symbol, (() => unknown) | undefined>

const userData = mkdtempSync(join(tmpdir(), "novaclaw-store-userdata-"))
// Where an absolute-name escape would land. Deliberately a SIBLING of userData, never inside it.
const outside = mkdtempSync(join(tmpdir(), "novaclaw-store-outside-"))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

/** Present so the export name exists; reaching it from a `store-*` handler is the bug, not the test. */
const unusable =
  (what: string) =>
  (): never => {
    throw new Error(`${what}() is unreachable from a store-* handler`)
  }

const app = {
  on: () => {},
  off: () => {},
  once: () => {},
  isPackaged: false,
  getVersion: () => "0.0.0-test",
  getPath: (name: string) => {
    if (name !== "userData") throw new Error(`unexpected app.getPath(${name})`)
    return userData
  },
}
const ipcMain = {
  handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  on: (channel: string, handler: Handler) => handlers.set(channel, handler),
}
const electronStub = {
  app,
  ipcMain,
  ipcRenderer: { invoke: unusable("ipcRenderer.invoke"), send: unusable("ipcRenderer.send") },
  contextBridge: { exposeInMainWorld: unusable("contextBridge.exposeInMainWorld") },
  webUtils: { getPathForFile: unusable("webUtils.getPathForFile") },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
  Notification: class {
    show() {}
  },
  clipboard: { readImage: () => ({ isEmpty: () => true }), readText: () => "", writeText: () => {} },
  crashReporter: { start: () => {} },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
  },
  nativeImage: { createEmpty: () => ({}) },
  nativeTheme: { on: () => {}, shouldUseDarkColors: false },
  net: { fetch: unusable("net.fetch") },
  netLog: { startLogging: async () => {}, stopLogging: async () => {} },
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  shell: { openExternal: () => {}, openPath: async () => "" },
  // Identical in intent to the stubs in server.test.ts and supervise-faults.test.ts: the hook is read
  // from a shared `globalThis` slot at CALL time, so whichever registration wins, the file that
  // installed a hook is the one that gets it — and a file that installed none gets a clear error
  // rather than a fake child.
  utilityProcess: {
    fork: () => {
      const hook = forkSlot[FORK_SLOT]
      if (!hook) throw new Error("no sidecar fork hook installed for this test")
      return hook()
    },
  },
}
// `store.ts` reaches `electron.app` through the DEFAULT import, `ipc.ts` through named ones, and
// `electron-store` destructures the default — so the same object has to answer all three.
void mock.module("electron", () => ({ default: electronStub, ...electronStub }))
// `windows.ts` drags in electron-window-state, the UI theme JSON and electron-log at module load,
// none of which any `store-*` handler touches.
void mock.module("./windows", () => ({
  getPinchZoomEnabled: () => false,
  setPinchZoomEnabled: () => {},
  setTitlebar: () => {},
  updateTitlebar: () => {},
}))

const { registerIpcHandlers } = await import("./ipc")

// Every dependency throws. Nothing a `store-*` handler does may reach one, and a stub that returned
// a plausible value instead would let a handler quietly consult the wrong thing.
const unreachable = unusable
registerIpcHandlers({
  killSidecar: unreachable("killSidecar"),
  supervisorState: unreachable("supervisorState"),
  subscribeSupervisorState: unreachable("subscribeSupervisorState"),
  relaunch: unreachable("relaunch"),
  awaitInitialization: unreachable("awaitInitialization"),
  consumeInitialDeepLinks: unreachable("consumeInitialDeepLinks"),
  getDefaultServerUrl: unreachable("getDefaultServerUrl"),
  setDefaultServerUrl: unreachable("setDefaultServerUrl"),
  getDisplayBackend: unreachable("getDisplayBackend"),
  setDisplayBackend: unreachable("setDisplayBackend"),
  checkAppExists: unreachable("checkAppExists"),
  resolveAppPath: unreachable("resolveAppPath"),
  setBackgroundColor: unreachable("setBackgroundColor"),
  exportDebugLogs: unreachable("exportDebugLogs"),
  recordFatalRendererError: unreachable("recordFatalRendererError"),
  markBootPhase: unreachable("markBootPhase"),
} as unknown as Parameters<typeof registerIpcHandlers>[0])

const invoke = (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for "${channel}"`)
  return handler({ sender: { id: 1 } }, ...args)
}

/** The name-minting formula from `app/src/utils/persist.ts` and `core/src/util/encode.ts`. */
const checksum = (content: string) => {
  if (!content) return undefined
  let hash = 0x811c9dc5
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
const minted = (kind: "workspace" | "draft", input: string) => {
  const head = (input.slice(0, 12) || kind).replace(/[^a-zA-Z0-9._-]/g, "-")
  return `novaclaw.${kind}.${head}.${checksum(input) ?? "0"}.dat`
}

/**
 * The whole legitimate vocabulary. The two derived families are minted by the formula above rather
 * than pasted as literals: a hand-copied `novaclaw.workspace.….dat` would keep passing after the
 * generator changed shape, which is the one way this control could go quietly stale.
 */
const LEGITIMATE = [
  "novaclaw.settings",
  "novaclaw.global.dat",
  "default.dat",
  minted("workspace", "C:/Users/nancy/code/llm"),
  minted("workspace", "/home/nancy/code/llm"),
  minted("workspace", ""),
  minted("draft", "01H9XYZABCDEFG"),
  minted("draft", ""),
]

const REFUSED = /Refused store name/
const TRAVERSAL_LEAF = "novaclaw-store-traversal.dat"

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  rmSync(resolve(userData, "..", TRAVERSAL_LEAF), { force: true })
})

describe("store-* IPC channels only accept known store names", () => {
  test("an invented name is refused by every channel and mints no file", () => {
    const invented = "novaclaw.attacker.dat"
    expect(() => invoke("store-set", invented, "k", "v")).toThrow(REFUSED)
    expect(() => invoke("store-get", invented, "k")).toThrow(REFUSED)
    expect(() => invoke("store-delete", invented, "k")).toThrow(REFUSED)
    expect(() => invoke("store-clear", invented)).toThrow(REFUSED)
    expect(() => invoke("store-keys", invented)).toThrow(REFUSED)
    expect(() => invoke("store-length", invented)).toThrow(REFUSED)
    expect(existsSync(join(userData, invented))).toBe(false)
  })

  test("an ABSOLUTE name is refused — and would otherwise have discarded userData entirely", () => {
    const target = join(outside, "escaped.dat")

    // The premise, asserted rather than asserted-about: this is exactly what `conf` computes, and an
    // absolute segment throws the base away. Without this line the test below proves only that a
    // string was rejected, not that rejecting it mattered.
    expect(resolve(userData, target)).toBe(target)
    expect(dirname(target)).not.toBe(userData)

    expect(() => invoke("store-set", target, "stolen", "value")).toThrow(REFUSED)
    expect(() => invoke("store-get", target, "stolen")).toThrow(REFUSED)
    expect(existsSync(target)).toBe(false)
  })

  test("a `..` traversal is refused and nothing appears where it pointed", () => {
    const traversal = `../${TRAVERSAL_LEAF}`
    const landing = resolve(userData, traversal)
    expect(dirname(landing)).not.toBe(userData)

    expect(() => invoke("store-set", traversal, "escaped", "value")).toThrow(REFUSED)
    expect(existsSync(landing)).toBe(false)
  })

  test("a non-string name cannot slip past — and no name at all is not the SETTINGS store", () => {
    for (const name of [undefined, null, 42, ["novaclaw.settings"], { toString: () => "default.dat" }]) {
      expect(() => invoke("store-set", name, "smuggled", "value")).toThrow(REFUSED)
    }

    // `getStore(name = SETTINGS_STORE)` cannot tell an omitted argument from an explicit `undefined`,
    // so a vocabulary check placed ONLY inside it hands a nameless renderer the main process's own
    // settings store — the one holding the default server URL and the WSL server list.
    expect(invoke("store-get", "novaclaw.settings", "smuggled")).toBe(null)
  })

  // The control. A guard that refuses everything is not a fix, it is an outage with good intentions.
  test("every legitimate store still reads, writes, enumerates and clears — inside userData", () => {
    for (const name of LEGITIMATE) {
      // Start from empty, so this control measures the FEATURE and nothing else. Without it the
      // control also fails when the guard is removed — for the unrelated reason that an unguarded
      // write from an earlier case landed in one of these stores — and a control that fails for two
      // reasons at once tells you which fix worked for neither.
      invoke("store-clear", name)
      invoke("store-set", name, "language", "nl")
      expect(invoke("store-get", name, "language")).toBe("nl")
      expect(invoke("store-keys", name)).toEqual(["language"])
      expect(invoke("store-length", name)).toBe(1)

      // Principle 11's positive half: the bytes land where they were supposed to.
      expect(existsSync(join(userData, name))).toBe(true)

      invoke("store-delete", name, "language")
      expect(invoke("store-get", name, "language")).toBe(null)
      invoke("store-clear", name)
      expect(invoke("store-length", name)).toBe(0)
    }
  })
})
