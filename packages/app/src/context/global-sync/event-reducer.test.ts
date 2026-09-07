import { describe, expect, test } from "bun:test"
import type { SessionV2Info as Session } from "@novaclaw/sdk/v2/client"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import { applyDirectoryEvent, applyGlobalEvent } from "./event-reducer"

const rootSession = (input: { id: string; parentID?: string; archived?: number; result?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
    result: input.result,
    time: {
      created: 1,
      updated: 1,
      archived: input.archived,
    },
  }) as unknown as Session

const baseState = (input: Partial<State> = {}) =>
  ({
    status: "complete",
    agent: [],
    command: [],
    projectMeta: undefined,
    icon: undefined,
    provider: {} as State["provider"],
    config: {} as State["config"],
    path: { directory: "/tmp" } as State["path"],
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_diff: {},
    todo: {},
    mcp: {},
    vcs: undefined,
    limit: 10,
    ...input,
  }) as State

describe("applyGlobalEvent", () => {
  test("handles global.disposed by triggering refresh", () => {
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "global.disposed" },
      refresh: () => {
        refreshCount += 1
      },
    })

    expect(refreshCount).toBe(1)
  })

  test("handles server.connected by triggering refresh", () => {
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "server.connected" },
      refresh: () => {
        refreshCount += 1
      },
    })

    expect(refreshCount).toBe(1)
  })
})

describe("applyDirectoryEvent", () => {
  const sessionWithDir = (id: string, directory: string) =>
    ({ id, time: { created: 1, updated: 1 }, location: { directory } }) as unknown as Session

  test("a folded completion repairs the directory store's stale busy status", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "ses_1" })],
        session_status: { ses_1: { type: "busy" } },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.updated", properties: { info: rootSession({ id: "ses_1", result: "done" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
    })

    expect(store.session_status.ses_1?.type).toBe("exited")
  })

  test("folds a folder move onto the stale copy so the Chats list stops double-rendering", () => {
    const [store, setStore] = createStore(
      baseState({
        path: { directory: "C:\\scratch" } as State["path"],
        session: [sessionWithDir("ses_1", "C:\\scratch")],
        sessionTotal: 1,
      }),
    )
    applyDirectoryEvent({
      event: {
        type: "session.next.moved",
        properties: { sessionID: "ses_1", location: { directory: "C:\\picalc" }, subdirectory: "sub" },
      },
      store,
      setStore,
      push: () => {},
      directory: "C:\\scratch",
    })
    // The old folder's copy now carries the NEW directory → the home dedup (directory+id) collapses
    // it against the new folder's copy instead of rendering a second "New session" row.
    expect((store.session[0] as unknown as { location: { directory: string } }).location.directory).toBe("C:\\picalc")
    expect((store.session[0] as unknown as { subpath?: string }).subpath).toBe("sub")
    expect(store.session).toHaveLength(1)
    expect(store.sessionTotal).toBe(1) // a move is neither a create nor a delete — totals unchanged
  })

  test("ignores a move for a session this directory store does not hold", () => {
    const [store, setStore] = createStore(baseState({ session: [], sessionTotal: 0 }))
    applyDirectoryEvent({
      event: { type: "session.next.moved", properties: { sessionID: "ghost", location: { directory: "C:\\x" } } },
      store,
      setStore,
      push: () => {},
      directory: "C:\\other",
    })
    expect(store.session).toHaveLength(0)
  })

  test("preserves a Home-specific retained session limit", () => {
    const [store, setStore] = createStore(
      baseState({
        limit: 1,
        session: [rootSession({ id: "a" }), rootSession({ id: "b" }), rootSession({ id: "c" })],
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "d" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      retainedLimit: 3,
    })

    expect(store.session).toHaveLength(3)
  })

  test("inserts root sessions in sorted order and updates sessionTotal", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "b" })],
        sessionTotal: 1,
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "a" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
    })

    expect(store.session.map((x) => x.id)).toEqual(["a", "b"])
    expect(store.sessionTotal).toBe(2)

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "c", parentID: "a" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
    })

    expect(store.sessionTotal).toBe(2)
  })

  test("cleans session caches when archived", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "ses_1" }), rootSession({ id: "ses_2" })],
        sessionTotal: 2,
        session_diff: { ses_1: [] },
        todo: { ses_1: [] },
        session_status: { ses_1: { type: "busy" } },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.updated", properties: { info: rootSession({ id: "ses_1", archived: 10 }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
    })

    expect(store.session.map((x) => x.id)).toEqual(["ses_2"])
    expect(store.sessionTotal).toBe(1)
    expect(store.session_diff.ses_1).toBeUndefined()
    expect(store.todo.ses_1).toBeUndefined()
    expect(store.session_status.ses_1).toBeUndefined()
  })

  test("cleans session caches when deleted and decrements only root totals", () => {
    const cases = [
      { info: rootSession({ id: "ses_1" }), expectedTotal: 1 },
      { info: rootSession({ id: "ses_2", parentID: "ses_1" }), expectedTotal: 2 },
    ]

    for (const item of cases) {
      const [store, setStore] = createStore(
        baseState({
          session: [
            rootSession({ id: "ses_1" }),
            rootSession({ id: "ses_2", parentID: "ses_1" }),
            rootSession({ id: "ses_3" }),
          ],
          sessionTotal: 2,
          session_diff: { [item.info.id]: [] },
          todo: { [item.info.id]: [] },
          session_status: { [item.info.id]: { type: "busy" } },
        }),
      )

      applyDirectoryEvent({
        event: { type: "session.deleted", properties: { info: item.info } },
        store,
        setStore,
        push() {},
        directory: "/tmp",
      })

      expect(store.session.find((x) => x.id === item.info.id)).toBeUndefined()
      expect(store.sessionTotal).toBe(item.expectedTotal)
      expect(store.session_diff[item.info.id]).toBeUndefined()
      expect(store.todo[item.info.id]).toBeUndefined()
      expect(store.session_status[item.info.id]).toBeUndefined()
    }
  })

  test("cleans caches for trimmed sessions on session.created", () => {
    const dropped = rootSession({ id: "ses_b" })
    const kept = rootSession({ id: "ses_a" })
    const todos: string[] = []
    const [store, setStore] = createStore(
      baseState({
        limit: 1,
        session: [dropped],
        session_diff: { [dropped.id]: [] },
        todo: { [dropped.id]: [] },
        session_status: { [dropped.id]: { type: "busy" } },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: kept } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      setSessionTodo(sessionID, value) {
        if (value !== undefined) return
        todos.push(sessionID)
      },
    })

    expect(store.session.map((x) => x.id)).toEqual([kept.id])
    expect(store.session_diff[dropped.id]).toBeUndefined()
    expect(store.todo[dropped.id]).toBeUndefined()
    expect(store.session_status[dropped.id]).toBeUndefined()
    expect(todos).toEqual([dropped.id])
  })

  test("updates vcs branch in store and cache", () => {
    const [store, setStore] = createStore(baseState({ vcs: { branch: "main", default_branch: "main" } }))
    const [cacheStore, setCacheStore] = createStore({
      value: { branch: "main", default_branch: "main" } as State["vcs"],
    })

    applyDirectoryEvent({
      event: { type: "vcs.branch.updated", properties: { branch: "feature/test" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      vcsCache: {
        store: cacheStore,
        setStore: setCacheStore,
        ready: () => true,
      },
    })

    expect(store.vcs).toEqual({ branch: "feature/test", default_branch: "main" })
    expect(cacheStore.value).toEqual({ branch: "feature/test", default_branch: "main" })
  })

  test("routes disposal events to side-effect handlers", () => {
    const [store, setStore] = createStore(baseState())
    const pushes: string[] = []

    applyDirectoryEvent({
      event: { type: "server.instance.disposed" },
      store,
      setStore,
      push(directory) {
        pushes.push(directory)
      },
      directory: "/tmp",
    })

    expect(pushes).toEqual(["/tmp"])
  })
})
