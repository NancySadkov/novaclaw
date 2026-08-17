export * as CommunityDht from "./dht"

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"

/**
 * Community — finding instances through a public Kademlia DHT (`AGENTS.md`, "we run NOTHING").
 *
 * 🔴 A DIRECTORY, not a transport. The sidecar answers *which instances are out there and where do
 * I knock*; everything after that happens on NovaClaw's own HTTP transport, signed and verified as
 * always. What comes back is an ADDRESS, which is hearsay of exactly the same kind as a LAN sighting
 * or a typed doorman address — and it flows into `learnFrom`, which dials it and ASKS who lives
 * there rather than believing anything attached to it.
 *
 * 🔴 **Lazily started, then LONG-LIVED.** Nothing spawns at boot, nothing spawns for a user who
 * never opened the community, and nothing spawns while building this layer — the child appears on
 * the first lookup and then stays for the session.
 *
 * Measured 2026-08-17, and it is why the shape changed: **a Kademlia node that lives twenty seconds
 * is bad at Kademlia.** Spawning per lookup meant every query ran against a THREE-ENTRY routing
 * table, milliseconds after startup, and found nothing — the feature worked in every configuration
 * except the one it shipped in. A node that stays alive keeps a deep table (~150 entries within a
 * minute), keeps its connections warm, and republishes its own provider record on kad's own
 * schedule. *Lazy is a statement about when it starts, not about how briefly it lives.*
 *
 * ⚠️ **Every failure is silent and total**: no binary, no spawn, no answer, malformed answer — all of
 * them mean "no peers", never an error. The DHT is the convenience; the LAN and a typed address are
 * the guarantees, and a lookup that could fail a join would make the commons a dependency.
 *
 * 🔴 **A missing binary is the ORDINARY case, not a fault.** The sidecar is Rust and the app builds
 * without a cargo toolchain, so most machines will not have it. That must cost nothing beyond the
 * peers it would have found.
 */

/** How long one exchange may take. The sidecar's own budgets are smaller; this is the backstop. */
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

  /**
   * 🔴 BESIDE THE EXECUTABLE FIRST, then the dev tree — the same order `packages/host` uses, and
   * for the same reason: **a compiled binary has no `node_modules`**, so a path relative to this
   * module resolves to nothing in a packaged app. Checking the dev path first would work on the
   * machine that built it and nowhere else, which is the failure that looks like "the DHT does not
   * work in the release".
   */
  const beside = path.join(path.dirname(process.execPath), exe)
  if (existsSync(beside)) return beside
  return fileURLToPath(new URL(`../../../dht/target/release/${exe}`, import.meta.url))
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
 * Whether an address is worth publishing.
 *
 * 🔴 The announce address is TYPED BY A USER, and the whole point of publishing is that strangers
 * act on it. A malformed one still announces the room — the sidecar simply fails to attach an
 * address to it — which puts a record in the commons that names nobody. Refused here so the junk
 * never leaves this machine.
 *
 * ⚠️ This says the address is well FORMED, never that it is reachable. Nothing on this machine can
 * know that, which is why the setting exists for a person to answer.
 */
export const isAnnounceable = (address: string): boolean => /^[A-Za-z0-9._\-[\]]+:\d{1,5}$/.test(address.trim())

/**
 * The living sidecar, reduced to what this module needs of it.
 *
 * ⚠️ An interface rather than a `ChildProcess` so the seam is exercisable without a Rust toolchain.
 * The tests that matter here are about LIFETIME — reuse, death, restart — and none of them should
 * need a compiler to run.
 */
export interface Node {
  readonly write: (line: string) => void
  readonly onLine: (handler: (line: string) => void) => void
  readonly onExit: (handler: () => void) => void
  readonly stop: () => void
}

export interface Options {
  readonly binary?: string
  /**
   * The whole-exchange backstop. Injectable because the default is deliberately longer than a test
   * should wait — a gate that spends 40 s proving a timeout works is a gate people start skipping.
   */
  readonly timeoutMs?: number
  /** Injected in tests. Returning `undefined` is "no sidecar here", the ordinary case. */
  readonly start?: (binary: string) => Node | undefined
}

export interface Interface {
  /**
   * Ask the DHT who else is out there. Answers `[]` for every failure.
   *
   * @param announce - the address this instance believes peers can knock on, when it has one.
   * Omitting it means "look, do not advertise" — the honest default for an instance behind a NAT,
   * whose announcement would be a promise nobody can keep.
   */
  readonly find: (input?: { readonly announce?: string }) => Effect.Effect<ReadonlyArray<string>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunityDht") {}

export const layerWith = (options: Options = {}): Layer.Layer<Service> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const binary = options.binary ?? binaryPath()
      const timeoutMs = options.timeoutMs ?? DHT_TIMEOUT_MS
      const start = options.start ?? startNode

      /**
       * 🔴 ONE AT A TIME. The protocol is one reply per line, in order, with nothing to match a reply
       * to its request — so two overlapping lookups would each read the other's answer. The sidecar
       * is a shared resource now that it outlives a single call, and this is what makes that safe.
       */
      const gate = yield* Semaphore.make(1)

      let node: Node | undefined
      let alive = false
      /** The address last successfully announced, so a reconnect re-announces and a repeat does not. */
      let announced: string | undefined
      let pending: ((line: string | undefined) => void) | undefined

      const ensure = (): Node | undefined => {
        if (alive && node !== undefined) return node
        node = undefined
        announced = undefined
        const started = start(binary)
        if (started === undefined) return undefined
        alive = true
        started.onLine((line) => {
          const settle = pending
          pending = undefined
          settle?.(line)
        })
        started.onExit(() => {
          alive = false
          const settle = pending
          pending = undefined
          // ⚠️ A death mid-request answers the waiter rather than leaving it for the timeout. The
          // caller is a user waiting on a button, and we already know the answer is "nothing".
          settle?.(undefined)
        })
        node = started
        return started
      }

      /** One request, one reply, bounded. `undefined` means the sidecar did not answer. */
      const ask = (request: string) =>
        Effect.callback<string | undefined>((resume) => {
          const started = ensure()
          if (started === undefined) return resume(Effect.succeed(undefined))
          pending = (line) => resume(Effect.succeed(line))
          try {
            started.write(`${request}\n`)
          } catch {
            pending = undefined
            resume(Effect.succeed(undefined))
          }
        }).pipe(
          Effect.timeoutOption(timeoutMs),
          Effect.map((reply) => (reply._tag === "None" ? undefined : reply.value)),
          Effect.tap((reply) =>
            Effect.sync(() => {
              /**
               * ⚠️ A silent sidecar is a WEDGED sidecar, and it is now long-lived — so it is killed
               * rather than kept. Keeping it would poison every later lookup with a process that
               * never answers, which is worse than the spawn it costs to replace.
               */
              if (reply === undefined) stop()
            }),
          ),
          Effect.catchCause(() => Effect.succeed(undefined)),
        )

      const stop = () => {
        alive = false
        announced = undefined
        const settle = pending
        pending = undefined
        settle?.(undefined)
        try {
          node?.stop()
        } catch {
          // Already gone. A failure to stop must never fail anything.
        }
        node = undefined
      }

      /**
       * ⚠️ Closing the scope closes the sidecar. A DHT node outliving the instance that wanted it is
       * a background process nobody asked for, holding connections nobody is using.
       */
      yield* Effect.addFinalizer(() => Effect.sync(stop))

      const find: Interface["find"] = (input) =>
        gate.withPermits(1)(
          Effect.gen(function* () {
            /**
             * 🔴 The node is ensured FIRST, because `announced` describes THE NODE and a restart
             * resets it. Deciding before ensuring read the DEAD node's state: a replaced sidecar was
             * never told to announce, and — worse — the skipped request desynchronised every reply
             * after it, so the next lookup parsed an announce acknowledgement and reported no peers.
             */
            yield* Effect.sync(ensure)

            /**
             * ⚠️ Announced ONCE per living sidecar, not once per lookup. kad republishes a provider
             * record on its own schedule for as long as the node lives, so repeating it here would
             * buy nothing — and this is a second reason the node wants to be long-lived: a process
             * that exits after one lookup can never republish anything.
             */
            /**
             * ⚠️ A malformed address is DROPPED, not passed on — and the lookup still happens. The
             * setting being wrong must cost the user the advertisement, never the discovery.
             */
            const advertise =
              input?.announce !== undefined && isAnnounceable(input.announce) ? input.announce.trim() : undefined
            if (advertise !== undefined && advertise !== announced) {
              const reply = yield* ask(JSON.stringify({ op: "announce", addr: advertise }))
              if (reply !== undefined) announced = advertise
            }
            const reply = yield* ask(JSON.stringify({ op: "find" }))
            return reply === undefined ? [] : parse(reply)
          }),
        )

      return Service.of({ find })
    }),
  )

export const layer: Layer.Layer<Service> = layerWith()

/**
 * ⚠️ INSTANCE-GLOBAL, like the DB beside it. One node per instance is the whole point — two would
 * be two Kademlia participants, two routing tables to fill and two announcements of the same address.
 * It needs nothing, so it composes anywhere; it costs nothing until the first lookup asks it to.
 */
export const node = makeGlobalNode({ service: Service, layer, deps: [] })

/**
 * Spawn the real sidecar.
 *
 * ⚠️ `stdin` stays OPEN for the life of the node — closing it is what stops the child, so it is the
 * shutdown path and never part of a request.
 */
const startNode = (binary: string): Node | undefined => {
  try {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] })
    let buffer = ""
    let onLine: ((line: string) => void) | undefined
    let onExit: (() => void) | undefined
    child.on("error", () => onExit?.())
    child.on("close", () => onExit?.())
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()
      for (;;) {
        const at = buffer.indexOf("\n")
        if (at < 0) break
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        onLine?.(line)
      }
    })
    return {
      write: (line) => child.stdin.write(line),
      onLine: (handler) => {
        onLine = handler
      },
      onExit: (handler) => {
        onExit = handler
      },
      stop: () => {
        child.stdin.end()
        child.kill()
      },
    }
  } catch {
    // 🔴 The ordinary case: no binary on this machine. Silent by construction — see the file comment.
    return undefined
  }
}
