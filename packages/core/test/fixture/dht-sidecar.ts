import type { CommunityDht } from "@novaclaw/core/community/dht"

/**
 * A scripted DHT sidecar. `replies` are handed out in order, one per request; `undefined` means
 * "say nothing", which is how a wedged child is spelled.
 *
 * ⚠️ **Nothing here spawns the real sidecar.** It is a Rust binary and the app builds without a
 * cargo toolchain, so "no binary" is the ORDINARY machine — and a test that needs a Rust toolchain
 * to run is a test that stops running.
 *
 * ⚠️ It lives in `fixture/` because TWO files now need it: `community-dht.test.ts`, which owns the
 * seam's own behaviour, and `config-remove.test.ts`, which has to prove the config REMOVE verb
 * reaches it (NC-SEC-011 — it did not). Copying the stub into the second file would have made the
 * two able to disagree about what a sidecar does, which is the same drift that produced the defect
 * being tested.
 */
export const scripted = (replies: ReadonlyArray<string | undefined>) => {
  const state = {
    starts: 0,
    written: [] as Array<string>,
    stopped: 0,
    kill: undefined as undefined | (() => void),
  }
  const start = () => {
    state.starts += 1
    let onLine: ((line: string) => void) | undefined
    let onExit: (() => void) | undefined
    state.kill = () => onExit?.()
    const node: CommunityDht.Node = {
      write: (line) => {
        state.written.push(line.trim())
        const reply = replies[state.written.length - 1]
        if (reply !== undefined) queueMicrotask(() => onLine?.(reply))
      },
      onLine: (handler) => {
        onLine = handler
      },
      onExit: (handler) => {
        onExit = handler
      },
      stop: () => {
        state.stopped += 1
      },
    }
    return node
  }
  return { state, start }
}

/** A sidecar that never was — the ordinary machine. */
export const absent = () => undefined

/** The reply shape a `find` gets back. */
export const peers = (addresses: ReadonlyArray<string>) => JSON.stringify({ peers: addresses })
