import { describe, expect, test } from "bun:test"
import type { PermissionV2Request, QuestionRequest, SessionV2Info as Session } from "@novaclaw/sdk/v2/client"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import { applyDirectoryEvent, applyGlobalEvent } from "./event-reducer"

const rootSession = (input: { id: string; parentID?: string; archived?: number }) =>
  ({
    id: input.id,
    parentID: input.parentID,
    time: {
      created: 1,
      updated: 1,
      archived: input.archived,
    },
  }) as unknown as Session

const permissionRequest = (id: string, sessionID: string, title = id) =>
  ({
    id,
    sessionID,
    action: title,
    resources: ["*"],
    metadata: {},
    save: [],
  }) as PermissionV2Request

const questionRequest = (id: string, sessionID: string, title = id) =>
  ({
    id,
    sessionID,
    questions: [
      {
        question: title,
        header: title,
        options: [{ label: title, description: title }],
      },
    ],
  }) as QuestionRequest

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
    permission: {},
    question: {},
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
        permission: { ses_1: [] },
        question: { ses_1: [] },
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
    expect(store.permission.ses_1).toBeUndefined()
    expect(store.question.ses_1).toBeUndefined()
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
          permission: { [item.info.id]: [] },
          question: { [item.info.id]: [] },
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
      expect(store.permission[item.info.id]).toBeUndefined()
      expect(store.question[item.info.id]).toBeUndefined()
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
        permission: { [dropped.id]: [] },
        question: { [dropped.id]: [] },
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
    expect(store.permission[dropped.id]).toBeUndefined()
    expect(store.question[dropped.id]).toBeUndefined()
    expect(store.session_status[dropped.id]).toBeUndefined()
    expect(todos).toEqual([dropped.id])
  })

  test("tracks permission and question request lifecycles", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        permission: { [sessionID]: [permissionRequest("perm_1", sessionID), permissionRequest("perm_3", sessionID)] },
        question: { [sessionID]: [questionRequest("q_1", sessionID), questionRequest("q_3", sessionID)] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "permission.v2.asked", properties: permissionRequest("perm_2", sessionID) },
      store,
      setStore,
      push() {},
      directory: "/tmp",
    })
    expect(store.permission[sessionID]?.map((x) => x.id)).toEqual(["perm_1", "perm_2", "perm_3"])

    applyDirectoryEvent({
      event: { type: "permission.v2.asked", properties: permissionRequest("perm_2", sessionID, "updated") },
      store,
      setStore,
      push() {},
      directory: "/tmp",
    })
    expect(store.permission[sessionID]?.find((x) => x.id === "perm_2")?.action).toBe("updated")

    applyDirectoryEvent({
      event: { type: "permission.v2.replied", properties: { sessionID, requestID: "perm_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
    })
    expect(store.permission[sessionID]?.map((x) => x.id)).toEqual(["perm_1", "perm_3"])

    applyDirectoryEvent({
      event: { type: "question.asked", properties: questionRequest("q_2", sessionID) },
      store,
      setStore,
      push() {},
      directory: "/tmp",
    })
    expect(store.question[sessionID]?.map((x) => x.id)).toEqual(["q_1", "q_2", "q_3"])

    applyDirectoryEvent({
      event: { type: "question.asked", properties: questionRequest("q_2", sessionID, "updated") },
      store,
      setStore,
      push() {},
      directory: "/tmp",
    })
    expect(store.question[sessionID]?.find((x) => x.id === "q_2")?.questions[0]?.header).toBe("updated")

    applyDirectoryEvent({
      event: { type: "question.rejected", properties: { sessionID, requestID: "q_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
    })
    expect(store.question[sessionID]?.map((x) => x.id)).toEqual(["q_1", "q_3"])
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
