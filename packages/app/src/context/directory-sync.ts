import { Binary } from "@novaclaw/core/util/binary"
import type { SessionV2Info as Session } from "@novaclaw/sdk/v2/client"
import { createMemo } from "solid-js"
import { produce, reconcile, type SetStoreFunction } from "solid-js/store"
import type { createServerSyncContextInner } from "./server-sync"
import type { State } from "./global-sync/types"

const sessionFields = new Set(["session_status", "session_working", "session_diff", "todo", "permission"])

export const createDirSyncContext = (
  directory: string,
  serverSync: ReturnType<typeof createServerSyncContextInner>,
) => {
  // MCP is an optional capability, not part of opening a directory. The status surface reads the
  // passive configured/connected projection; the runner and explicit MCP controls materialize a
  // client on demand. Keeping this false is the boundary that prevents Home/Chats from starting
  // every enabled local process and remote socket before the user has asked for one.
  const current = createMemo(() => serverSync.child(directory, { mcp: false }))
  const data = new Proxy({} as State, {
    get(_, property: keyof State) {
      if (property === "session_working") return serverSync.session.data.session_working.bind(serverSync.session.data)
      if (sessionFields.has(property)) return serverSync.session.data[property as keyof typeof serverSync.session.data]
      return current()[0][property]
    },
  })
  const set = ((...input: unknown[]) => {
    if (typeof input[0] === "string" && sessionFields.has(input[0])) {
      return (serverSync.session.set as (...args: unknown[]) => unknown)(...input)
    }
    const result = (current()[1] as (...args: unknown[]) => unknown)(...input)
    if (input[0] === "session") current()[0].session.forEach(serverSync.session.remember)
    return result
  }) as SetStoreFunction<State>

  const index = (sessionID: string) => {
    const session = serverSync.session.get(sessionID)
    if (!session || session.location.directory !== directory) return
    const [store, setStore] = current()
    const result = Binary.search(store.session, session.id, (item) => item.id)
    if (result.found) {
      setStore("session", result.index, reconcile(session))
      return
    }
    setStore(
      "session",
      produce((draft) => void draft.splice(result.index, 0, session)),
    )
  }

  return {
    data,
    set,
    get status() {
      return current()[0].status
    },
    get ready() {
      return current()[0].status !== "loading"
    },
    session: {
      remember(session: Session) {
        serverSync.session.remember(session)
        index(session.id)
      },
      get(sessionID: string) {
        const session = serverSync.session.get(sessionID)
        if (session?.location.directory === directory) return session
      },
      async sync(sessionID: string, options?: { force?: boolean }) {
        await serverSync.session.sync(sessionID, options)
        index(sessionID)
      },
      diff: serverSync.session.diff,
      todo: serverSync.session.todo,
    },
    mcp: {
      toggle: (name: string) => serverSync.mcp.toggle(directory, name),
    },
    get directory() {
      return current()[0].path.directory
    },
  }
}
