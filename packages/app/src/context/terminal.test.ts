import { beforeAll, describe, expect, mock, test } from "bun:test"
import { ServerScope } from "@/utils/server-scope"

let getWorkspaceTerminalCacheKey: typeof import("./terminal").getWorkspaceTerminalCacheKey
let getLegacyTerminalStorageKeys: (dir: string, legacySessionID?: string) => string[]
let bindCreatedTerminal: typeof import("./terminal").bindCreatedTerminal
let disconnectLiveTerminals: typeof import("./terminal").disconnectLiveTerminals
let migrateTerminalState: (value: unknown) => unknown
let reconcileTerminalSnapshot: typeof import("./terminal").reconcileTerminalSnapshot
let stopAllInstanceTerminals: typeof import("./terminal").stopAllInstanceTerminals
let stopWorkspaceTerminal: typeof import("./terminal").stopWorkspaceTerminal
let inspectTerminalClose: typeof import("./terminal").inspectTerminalClose
let prepareTerminalReplacement: typeof import("./terminal").prepareTerminalReplacement

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    useLocation: () => ({}),
    useSearchParams: () => [{}, () => undefined],
  }))
  mock.module("@novaclaw/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
  }))
  const mod = await import("./terminal")
  bindCreatedTerminal = mod.bindCreatedTerminal
  disconnectLiveTerminals = mod.disconnectLiveTerminals
  getWorkspaceTerminalCacheKey = mod.getWorkspaceTerminalCacheKey
  getLegacyTerminalStorageKeys = mod.getLegacyTerminalStorageKeys
  migrateTerminalState = mod.migrateTerminalState
  reconcileTerminalSnapshot = mod.reconcileTerminalSnapshot
  stopAllInstanceTerminals = mod.stopAllInstanceTerminals
  stopWorkspaceTerminal = mod.stopWorkspaceTerminal
  inspectTerminalClose = mod.inspectTerminalClose
  prepareTerminalReplacement = mod.prepareTerminalReplacement
})

describe("disconnectLiveTerminals", () => {
  test("marks starting and running tabs disconnected while preserving diagnosis and identity", () => {
    const disconnected = {
      id: "already-offline",
      ptyID: "pty_offline",
      status: "disconnected" as const,
      title: "offline",
      titleNumber: 3,
    }
    const exited = {
      id: "failed",
      ptyID: "pty_failed",
      status: "exited" as const,
      exitCode: 137,
      title: "failed",
      titleNumber: 4,
      buffer: "diagnosis",
    }
    const result = disconnectLiveTerminals([
      { id: "starting", status: "starting", title: "starting", titleNumber: 1 },
      {
        id: "running",
        ptyID: "pty_running",
        status: "running",
        title: "running",
        titleNumber: 2,
        buffer: "kept output",
      },
      disconnected,
      exited,
    ])

    expect(result).toEqual([
      { id: "starting", status: "disconnected", title: "starting", titleNumber: 1 },
      {
        id: "running",
        ptyID: "pty_running",
        status: "disconnected",
        title: "running",
        titleNumber: 2,
        buffer: "kept output",
      },
      disconnected,
      exited,
    ])
    expect(result[2]).toBe(disconnected)
    expect(result[3]).toBe(exited)
  })

  test("preserves the collection when every tab is already terminal", () => {
    const all = [
      { id: "offline", status: "disconnected" as const, title: "offline", titleNumber: 1 },
      { id: "failed", status: "exited" as const, title: "failed", titleNumber: 2, exitCode: 1 },
    ]
    expect(disconnectLiveTerminals(all)).toBe(all)
  })
})

describe("reconcileTerminalSnapshot", () => {
  test("refreshes known tabs, disconnects missing ones, and adopts server-only PTYs", () => {
    const newDuringRequest = { id: "new", status: "starting" as const, title: "new", titleNumber: 3 }
    const result = reconcileTerminalSnapshot(
      [
        { id: "known", ptyID: "pty_known", status: "disconnected", title: "old", titleNumber: 1 },
        { id: "missing", ptyID: "pty_missing", status: "running", title: "missing", titleNumber: 2 },
        newDuringRequest,
      ],
      [
        {
          location: { directory: "/repo", workspaceID: "wrk_one", root: "/repo", origin: "origin" },
          data: {
            id: "pty_known",
            title: "known",
            command: "/bin/sh",
            args: [],
            cwd: "/repo",
            status: "running",
            pid: 10,
          },
        },
        {
          location: { directory: "/repo", root: "/repo", origin: "origin" },
          data: {
            id: "pty_orphan",
            title: "Terminal 4",
            command: "/bin/bash",
            args: [],
            cwd: "/repo",
            status: "exited",
            pid: 11,
            exitCode: 7,
          },
        },
      ] as never,
      { ids: new Set(["known", "missing"]), makeID: () => "adopted" },
    )

    expect(result).toEqual([
      {
        id: "known",
        ptyID: "pty_known",
        workspaceID: "wrk_one",
        status: "running",
        title: "known",
        titleNumber: 1,
        shell: "/bin/sh",
        cwd: "/repo",
        exitCode: undefined,
      },
      { id: "missing", ptyID: "pty_missing", status: "disconnected", title: "missing", titleNumber: 2 },
      newDuringRequest,
      {
        id: "adopted",
        ptyID: "pty_orphan",
        workspaceID: undefined,
        status: "exited",
        title: "Terminal 4",
        titleNumber: 4,
        shell: "/bin/bash",
        cwd: "/repo",
        exitCode: 7,
      },
    ])
    expect(result[2]).toBe(newDuringRequest)
  })
})

describe("bindCreatedTerminal", () => {
  test("replaces the server process without replacing the tab entity", () => {
    expect(
      bindCreatedTerminal(
        {
          id: "tab-stable",
          ptyID: "pty_dead",
          status: "exited",
          exitCode: 137,
          title: "server",
          titleNumber: 3,
          shell: "old-shell",
          cwd: "/old",
          buffer: "failure details",
          cursor: 42,
          scrollY: 5,
          rows: 24,
          cols: 80,
        },
        { id: "pty_new", title: "server", command: "new-shell", cwd: "/new" },
      ),
    ).toEqual({
      id: "tab-stable",
      ptyID: "pty_new",
      status: "running",
      exitCode: undefined,
      title: "server",
      titleNumber: 3,
      shell: "new-shell",
      cwd: "/new",
      buffer: undefined,
      cursor: undefined,
      scrollY: undefined,
      rows: undefined,
      cols: undefined,
    })
  })
})

describe("stopAllInstanceTerminals", () => {
  test("clears local tabs after the server confirms termination", async () => {
    let cleared = false
    let input: unknown
    const removed = await stopAllInstanceTerminals(
      {
        v2: {
          pty: {
            instanceRemoveAll: async (value: unknown) => {
              input = value
              return { data: 3 }
            },
          },
        },
      } as never,
      "/repo",
      () => {
        cleared = true
      },
    )
    expect(removed).toBe(3)
    expect(cleared).toBe(true)
    expect(input).toEqual({ location: { directory: "/repo" } })
  })

  test("retains local tabs when server termination fails", async () => {
    let cleared = false
    await expect(
      stopAllInstanceTerminals(
        { v2: { pty: { instanceRemoveAll: async () => Promise.reject(new Error("offline")) } } } as never,
        "/repo",
        () => {
          cleared = true
        },
      ),
    ).rejects.toThrow("offline")
    expect(cleared).toBe(false)
  })
})

describe("stopWorkspaceTerminal", () => {
  test("uses the canonical location-scoped removal operation", async () => {
    let input: unknown
    await stopWorkspaceTerminal(
      {
        v2: {
          pty: {
            remove: async (value: unknown) => {
              input = value
            },
          },
        },
      } as never,
      "/repo",
      "pty_one",
    )
    expect(input).toEqual({ ptyID: "pty_one", location: { directory: "/repo" } })
  })

  test("reports removal failures to the caller", async () => {
    await expect(
      stopWorkspaceTerminal(
        { v2: { pty: { remove: async () => Promise.reject(new Error("offline")) } } } as never,
        "/repo",
        "pty_one",
      ),
    ).rejects.toThrow("offline")
  })

  test("preserves the owning workspace location", async () => {
    let input: unknown
    await stopWorkspaceTerminal(
      {
        v2: {
          pty: {
            remove: async (value: unknown) => {
              input = value
            },
          },
        },
      } as never,
      "/repo",
      "pty_one",
      "wrk_one",
    )
    expect(input).toEqual({ ptyID: "pty_one", location: { directory: "/repo", workspace: "wrk_one" } })
  })
})

describe("inspectTerminalClose", () => {
  test("reports foreground activity and preserves the workspace location", async () => {
    let input: unknown
    const state = await inspectTerminalClose(
      {
        v2: {
          pty: {
            activity: async (value: unknown) => {
              input = value
              return { data: { data: { state: "foreground", descendants: 2 } } }
            },
          },
        },
      } as never,
      "/repo",
      "pty_one",
      "workspace_one",
    )
    expect(state).toBe("foreground")
    expect(input).toEqual({
      ptyID: "pty_one",
      location: { directory: "/repo", workspace: "workspace_one" },
    })
  })

  test("fails closed when activity cannot be inspected", async () => {
    const state = await inspectTerminalClose(
      { v2: { pty: { activity: async () => Promise.reject(new Error("offline")) } } } as never,
      "/repo",
      "pty_one",
    )
    expect(state).toBe("unknown")
  })
})

describe("prepareTerminalReplacement", () => {
  test("removes an idle known PTY before allowing a replacement", async () => {
    const calls: string[] = []
    const client = {
      v2: {
        pty: {
          activity: async () => {
            calls.push("activity")
            return { data: { data: { state: "idle" } } }
          },
          remove: async () => {
            calls.push("remove")
          },
        },
      },
    }
    await expect(
      prepareTerminalReplacement(
        client as never,
        "/repo",
        { ptyID: "pty_old", workspaceID: "workspace_one" },
        {},
        async () => false,
        () => undefined,
      ),
    ).resolves.toBe("ready")
    expect(calls).toEqual(["activity", "remove"])
  })

  test("requires confirmation for foreground or unknown activity", async () => {
    let removed = false
    let confirmed: string | undefined
    const client = {
      v2: {
        pty: {
          activity: async () => ({ data: { data: { state: "foreground" } } }),
          remove: async () => {
            removed = true
          },
        },
      },
    }
    await expect(
      prepareTerminalReplacement(
        client as never,
        "/repo",
        { ptyID: "pty_old" },
        {},
        async (state) => {
          confirmed = state
          return false
        },
        () => undefined,
      ),
    ).resolves.toBe("cancelled")
    expect(confirmed).toBe("foreground")
    expect(removed).toBe(false)
  })

  test("reports a failed removal and blocks creation", async () => {
    let reported: unknown
    await expect(
      prepareTerminalReplacement(
        {
          v2: {
            pty: {
              activity: async () => ({ data: { data: { state: "idle" } } }),
              remove: async () => Promise.reject(new Error("offline")),
            },
          },
        } as never,
        "/repo",
        { ptyID: "pty_old" },
        {},
        async () => true,
        (error) => {
          reported = error
        },
      ),
    ).resolves.toBe("failed")
    expect(reported).toEqual(new Error("offline"))
  })

  test("skips removal after the server already proved the PTY gone", async () => {
    let inspected = false
    let removed = false
    await expect(
      prepareTerminalReplacement(
        {
          v2: {
            pty: {
              activity: async () => {
                inspected = true
                return { data: { data: { state: "foreground" } } }
              },
              remove: async () => {
                removed = true
              },
            },
          },
        } as never,
        "/repo",
        { ptyID: "pty_gone" },
        { confirmedGone: true },
        async () => false,
        () => undefined,
      ),
    ).resolves.toBe("ready")
    expect(inspected).toBe(false)
    expect(removed).toBe(false)
  })
})

describe("getWorkspaceTerminalCacheKey", () => {
  test("uses workspace-only directory cache key", () => {
    expect(String(getWorkspaceTerminalCacheKey("/repo"))).toBe("local\u0000/repo\u0000__workspace__")
  })

  test("can include a server scope", () => {
    expect(String(getWorkspaceTerminalCacheKey("/repo", "ssh:debian" as ServerScope))).toBe(
      "ssh:debian\u0000/repo\u0000__workspace__",
    )
  })
})

describe("getLegacyTerminalStorageKeys", () => {
  test("keeps workspace storage path when no legacy session id", () => {
    expect(getLegacyTerminalStorageKeys("/repo")).toEqual(["/repo/terminal.v1"])
  })

  test("includes legacy session path before workspace path", () => {
    expect(getLegacyTerminalStorageKeys("/repo", "session-123")).toEqual([
      "/repo/terminal/session-123.v1",
      "/repo/terminal.v1",
    ])
  })
})

describe("migrateTerminalState", () => {
  test("drops invalid terminals and restores a valid active terminal", () => {
    expect(
      migrateTerminalState({
        active: "missing",
        all: [
          null,
          { id: "one", title: "Terminal 2" },
          { id: "one", title: "duplicate", titleNumber: 9 },
          { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
          { title: "no-id" },
        ],
      }),
    ).toEqual({
      active: "legacy-tab:one",
      all: [
        { id: "legacy-tab:one", ptyID: "one", status: "running", title: "Terminal 2", titleNumber: 2 },
        {
          id: "legacy-tab:two",
          ptyID: "two",
          status: "running",
          title: "logs",
          titleNumber: 4,
          rows: 24,
          cols: 80,
        },
      ],
    })
  })

  test("keeps a valid active id", () => {
    expect(
      migrateTerminalState({
        active: "two",
        all: [
          { id: "one", title: "Terminal 1" },
          { id: "two", title: "shell", titleNumber: 7 },
        ],
      }),
    ).toEqual({
      active: "legacy-tab:two",
      all: [
        { id: "legacy-tab:one", ptyID: "one", status: "running", title: "Terminal 1", titleNumber: 1 },
        { id: "legacy-tab:two", ptyID: "two", status: "running", title: "shell", titleNumber: 7 },
      ],
    })
  })

  test("preserves a durable client id separately from a replaced server PTY id", () => {
    expect(
      migrateTerminalState({
        active: "tab-stable",
        all: [{ id: "tab-stable", ptyID: "pty_replaced", status: "running", title: "build" }],
      }),
    ).toEqual({
      active: "tab-stable",
      all: [
        {
          id: "tab-stable",
          ptyID: "pty_replaced",
          status: "running",
          title: "build",
          titleNumber: 0,
        },
      ],
    })
  })

  test("turns an interrupted start into a recoverable disconnect and does not resurrect exited tabs", () => {
    expect(
      migrateTerminalState({
        active: "terminal-starting",
        all: [
          { id: "terminal-starting", status: "starting", title: "starting" },
          { id: "dead-tab", ptyID: "pty_dead", status: "exited", exitCode: 1, title: "dead" },
        ],
      }),
    ).toEqual({
      active: "terminal-starting",
      all: [
        {
          id: "terminal-starting",
          status: "disconnected",
          title: "starting",
          titleNumber: 0,
        },
      ],
    })
  })
})
