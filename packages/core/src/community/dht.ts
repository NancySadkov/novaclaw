export * as CommunityDht from "./dht"

import { Effect } from "effect"

/**
 * Community — finding instances through a public Kademlia DHT (`AGENTS.md`, "we run NOTHING").
 *
 * 🔴 A DIRECTORY, not a transport. The sidecar answers *which instances are out there and where do
 * I knock*; everything after that happens on NovaClaw's own HTTP transport, signed and verified as
 * always. What comes back is an ADDRESS, which is hearsay of exactly the same kind as a LAN sighting
 * or a typed doorman address — and it flows into `learnFrom`, which dials it and ASKS who lives
 * there rather than believing anything attached to it.
 *
 * ⚠️ **Nothing here runs at boot.** The binary is spawned the first time an instance that has JOINED
 * runs discovery, and an instance whose owner never turned the community on never starts it at all.
 * A Kademlia node is a long-lived network participant; startup speed is first-class, and this is the
 * shape that keeps both true.
 *
 * ⚠️ **Every failure is silent and total**: no binary, no spawn, no answer, malformed answer — all of
 * them mean "no peers", never an error. The DHT is the convenience; the LAN and a typed address are
 * the guarantees, and a lookup that could fail a join would make the commons a dependency.
 *
 * 🔴 **A missing binary is the ORDINARY case, not a fault.** The sidecar is Rust and the app builds
 * without a cargo toolchain, so most machines will not have it. That must cost nothing beyond the
 * peers it would have found.
 */

/** How long the whole exchange may take. The sidecar's own budget is smaller; this is the backstop. */
export const DHT_TIMEOUT_MS = 40_000

/** Enough to bootstrap from — peer exchange supplies the rest, so a longer list costs dials and buys nothing. */
export const MAX_DHT_PEERS = 8

/**
 * Where the sidecar lives. An explicit override wins so a packaged build can point at its own copy,
 * which is the same escape hatch `packages/host` gives its compiler.
 */
export const binaryPath = (): string => {
  const override = process.env["NOVACLAW_DHT_BINARY"]
  if (override !== undefined && override !== "") return override
  const exe = process.platform === "win32" ? "novaclaw-dht.exe" : "novaclaw-dht"
  return new URL(`../../../dht/target/release/${exe}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
}

/**
 * Addresses the sidecar reported, filtered to what NovaClaw can actually dial.
 *
 * ⚠️ Validated HERE as well as in the sidecar. This crosses a process boundary carrying data that
 * originated with strangers on a public DHT, and a caller that trusted it would be trusting the
 * weakest link in the chain rather than the strongest.
 */
export const parse = (line: string): ReadonlyArray<string> => {
  try {
    const reply = JSON.parse(line) as { peers?: unknown }
    if (!Array.isArray(reply.peers)) return []
    const seen = new Set<string>()
    for (const entry of reply.peers) {
      if (typeof entry !== "string") continue
      const address = entry.trim()
      // host:port only. Anything else is not something `learnFrom` can dial, and passing it on
      // would push a decision about junk down to whoever dials next.
      if (!/^[A-Za-z0-9._:\-[\]]+:\d{1,5}$/.test(address)) continue
      seen.add(address)
      if (seen.size >= MAX_DHT_PEERS) break
    }
    return [...seen]
  } catch {
    return []
  }
}

/**
 * Ask the DHT who else is out there. Answers `[]` for every failure.
 *
 * @param announce - the address this instance believes peers can knock on, when it has one. Omitting
 * it means "look, do not advertise" — the honest default for an instance behind a NAT, whose
 * announcement would be a promise nobody can keep.
 */
export const find = Effect.fn("CommunityDht.find")(function* (input?: {
  readonly announce?: string
  readonly binary?: string
  /**
   * The whole-exchange backstop. Injectable because the default is deliberately longer than a test
   * should wait — a gate that spends 40 s proving a timeout works is a gate people start skipping.
   */
  readonly timeoutMs?: number
  /** Injected in tests so the seam can be exercised without a Rust toolchain. */
  readonly run?: (
    binary: string,
    lines: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<string>>
}) {
  const binary = input?.binary ?? binaryPath()
  const requests = [
    ...(input?.announce === undefined ? [] : [JSON.stringify({ op: "announce", addr: input.announce })]),
    JSON.stringify({ op: "find" }),
  ]

  const run = input?.run ?? defaultRun
  const lines = yield* Effect.tryPromise(() => run(binary, requests)).pipe(
    Effect.timeoutOption(input?.timeoutMs ?? DHT_TIMEOUT_MS),
    // 🔴 Silent by construction — see the file comment. A missing binary is the ordinary case.
    Effect.catchCause(() => Effect.succeedNone),
  )
  if (lines._tag === "None") return []
  // The LAST reply is the answer to `find`; an announce reply precedes it when one was sent.
  const last = [...lines.value].reverse().find((line) => line.trim() !== "")
  return last === undefined ? [] : parse(last)
})

/**
 * Spawn the sidecar, write the requests, read until it has answered each, then close stdin.
 *
 * ⚠️ Closing stdin is what STOPS it. The sidecar treats EOF as "the parent went away" and exits, so
 * a discovery that ends leaves no Kademlia node running behind it — the alternative is a background
 * process nobody asked for, holding connections nobody is using.
 */
const defaultRun = async (binary: string, requests: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const { spawn } = await import("node:child_process")
  return await new Promise<ReadonlyArray<string>>((resolve) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] })
    const lines: string[] = []
    let buffer = ""
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        // Already gone: nothing to do, and a failure to kill must not fail a discovery.
      }
      resolve(lines)
    }
    child.on("error", finish)
    child.on("close", finish)
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()
      for (;;) {
        const at = buffer.indexOf("\n")
        if (at < 0) break
        lines.push(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
        if (lines.length >= requests.length) {
          child.stdin.end()
          finish()
          return
        }
      }
    })
    for (const request of requests) child.stdin.write(`${request}\n`)
  })
}
