import { createMemo } from "solid-js"
import { useServerSync } from "./server-sync"
import { useSDK } from "./sdk"

// V1-nuke slice C: this file was the V1 optimistic-merge module typed against the retired
// Message/Part wire shapes — every export except useSync had ZERO consumers (dead since the
// native transcript path landed). What remains is the live adapter: the directory-scoped sync
// context for the current SDK directory.
export const useSync = () => {
  const serverSync = useServerSync()
  const sdk = useSDK()

  return createMemo(() => serverSync().ensureDirSyncContext(sdk().directory))
}

export type DirectorySync = ReturnType<ReturnType<typeof useSync>>
