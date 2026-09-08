export * as CommunityDht from "./dht"

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Semaphore } from "effect"
import { CommunityConsent } from "./consent"
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
/**
 * The sidecar's file name. Exported because the RELEASE BUILD needs the same answer: it resolves
 * `../dht/build/<name>` to decide whether a target ships with a DHT, and when that lookup misses it
 * only WARNS. So a rename that reached the Rust crate and one of its two readers would produce a
 * release that is silently discovery-less — the exact failure the comments in `binaryPath` below
 * were written about, arriving through the build instead of through the runtime.
 *
 * ⚠️ **`packages/dht/protocol.ts` has its own copy and that one cannot be merged away.** It is the
 * TS shim beside a cargo crate: `packages/dht` declares no dependencies and publishes no `exports`
 * map, so nothing can import it and it can import nothing. Its consumers (`dht/build.ts`,
 * `desktop/scripts/dht-packaging.ts`) reach it by relative path for that reason. Giving a Rust
 * crate a workspace edge and a published TS surface to save one ternary is the wrong trade; the two
 * copies name each other instead.
 *
 * ⚠️ **`core/test/community-dht.test.ts` spells the name a third time ON PURPOSE — do not "fix" it.**
 * It writes a fixture file with that literal name and asserts `binaryPath()` finds it. Importing
 * this function there would make the test construct and then find whatever name the code currently
 * says, which is a test that cannot fail on a rename — the one thing it exists to catch.
 */
export const dhtExecutableName = (platform: NodeJS.Platform = process.platform): string =>
  platform === "win32" ? "novaclaw-dht.exe" : "novaclaw-dht"

export const binaryPath = (): string => {
  const override = process.env["NOVACLAW_DHT_BINARY"]
  if (override !== undefined && override !== "") return override
  const exe = dhtExecutableName()

  /**
   * 🔴 BESIDE THE EXECUTABLE FIRST, then the dev tree — the same order `packages/host` uses, and
   * for the same reason: **a compiled binary has no `node_modules`**, so a path relative to this
   * module resolves to nothing in a packaged app. Checking the dev path first would work on the
   * machine that built it and nowhere else, which is the failure that looks like "the DHT does not
   * work in the release".
   */
  const beside = path.join(path.dirname(process.execPath), exe)
  if (existsSync(beside)) return beside

  /**
   * 🔴 **Then the packaged desktop's resources** — the candidate whose absence meant the product's
   * primary face had no DHT at all (review 1.7). `packages/host` has had this line since it
   * replaced `@parcel/watcher`; this module was written without it, so even once the packager
   * copied the binary there would have been nothing to look for it. Both halves are the fix.
   *
   * ⚠️ Electron's main process has `resourcesPath`; a plain node or bun process does not, hence the
   * guarded read rather than a bare property access.
   */
  const resources = (process as { resourcesPath?: string }).resourcesPath
  if (resources !== undefined && resources !== "") {
    const packaged = path.join(resources, "dht", exe)
    if (existsSync(packaged)) return packaged
  }

  // ⚠️ `build/`, the sidecar's published artifact, not cargo's `target/release` scratch tree: the
  // packager copies `build/`, so a dev tree that resolved somewhere else would be testing a path
  // the product does not use.
  return fileURLToPath(new URL(`../../../dht/build/${exe}`, import.meta.url))
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
 * The announce rule lives in `./address`, a leaf with no store imports — see that file for why.
 * Re-exported here because every existing caller reaches for it through `CommunityDht`.
 */
export { isAnnounceable, splitAnnounce } from "./address"

import { CommunityAddress } from "./address"

/**
 * The most bytes an unterminated reply may occupy before the sidecar is treated as broken.
 *
 * 🔴 A ceiling of OUR OWN — the rule this subsystem keeps relearning: *wherever a value somebody
 * else controls becomes our allocation, it needs a bound we chose.* The reader accumulates until it
 * sees a newline, so a child that never sends one grows this process's memory for as long as it runs.
 *
 * ⚠️ This file already said the sidecar "could crash mid-line, be an old build, or be something
 * else entirely on a machine where the path was overridden" — and then read its output without a
 * limit. 64 KB is thousands of times the largest honest reply, which carries at most `MAX_DHT_PEERS`
 * `host:port` strings.
 */
export const MAX_REPLY_BYTES = 64 * 1024

/**
 * A line-buffered reader with a ceiling. Returns the complete lines in a chunk, or `undefined` once
 * the sidecar has overrun it.
 */
export const readLines = (state: { buffer: string }, chunk: string): ReadonlyArray<string> | undefined => {
  state.buffer += chunk
  const lines: string[] = []
  for (;;) {
    const at = state.buffer.indexOf("\n")
    if (at < 0) break
    lines.push(state.buffer.slice(0, at))
    state.buffer = state.buffer.slice(at + 1)
  }
  /**
   * ⚠️ Checked AFTER draining, so a legitimate burst of many COMPLETE lines is never mistaken for
   * an overrun. What matters is how much UNTERMINATED text is being held.
   */
  // ⚠️ BYTES, not `String.length`. A peer chooses this text, and UTF-16 code units under-count a
  // byte budget by up to 3x — so a 64 KiB anti-overrun ceiling was reachable at 192 KiB with CJK.
  if (Buffer.byteLength(state.buffer, "utf8") > MAX_REPLY_BYTES) return undefined
  return lines
}

/**
 * Did the sidecar say it PUBLISHED?
 *
 * 🔴 `announced: false` is a real answer, not a formality. The sidecar waits for a routing table
 * worth publishing into and then for the query's own result, so it reports failure when there was no
 * network to publish to — and this seam used to treat any reply at all as success, which meant a
 * failed announcement was recorded as done and never retried.
 */
export const announcedOk = (line: string): boolean => {
  try {
    return (JSON.parse(line) as { announced?: unknown }).announced === true
  } catch {
    return false
  }
}

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
  readonly start?: (binary: string, bootstrap?: ReadonlyArray<string>) => Node | undefined
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
  /**
   * What the last announcement attempt CLAIMED, or `undefined` if none has been made this session.
   *
   * 🔴 So a surface can stop asserting what nobody confirmed. The panel said "Published as X"
   * because the CONFIG said so, which is a statement about the user's intention rather than about the
   * network — and an announcement genuinely fails when there is no routing table to publish into.
   */
  readonly announced: () => Effect.Effect<
    | {
        readonly address: string
        readonly published: boolean
        /** `no-sidecar` when this build has no directory helper; `refused` when one tried and failed. */
        readonly reason?: string
      }
    | undefined
  >
  /**
   * Stop advertising this instance and stop the node.
   *
   * ⚠️ Named `withdraw` rather than `stop` because the network-facing half is the point: a stopped
   * process that never withdrew leaves its provider record to be found until it expires.
   */
  readonly withdraw: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunityDht") {}

/**
 * 🔴 **The live node, module-level — so a settings write can reach it** (review 1.7, unit 5 F3; Codex P1).
 *
 * The child was stopped only by scope close or a wedge-kill, which meant turning the community OFF,
 * engaging the AIRGAP, or clearing the published address all left a Kademlia node running: kad
 * republishes the provider record every 12 hours for as long as it lives, so an instance went on
 * advertising itself to the commons after its owner had switched the feature off. The consent screen
 * promises the opposite, and a promise a subsystem does not keep is worse than one never made.
 *
 * ⚠️ Module-level for the reason `offline.ts` and `consent.ts` both give at length: the caller is
 * the post-commit config path, which has no service in context and must not build one — building a
 * layer from a parameter mints a fresh memo key and gives you a SECOND DHT node, which is two
 * Kademlia participants announcing the same address.
 */
let live: { readonly settle: (input: Gate) => Effect.Effect<void> } | undefined

/** What the community's settings say right now, as far as the DHT is concerned. */
export interface Gate {
  /** Whether this instance takes part at all — consent AND the switch AND the airgap. */
  readonly participates: boolean
  /** The address the user asks us to publish, when they have set one. */
  readonly announce?: string
  /**
   * Where the DHT should start from, when the user has overridden it.
   *
   * ⚠️ Part of the GATE because changing it must take effect without restarting the instance — the
   * self-healing law's own requirement. A node already dialled into the old set is stopped, and the
   * next lookup starts one that reads the new list.
   */
  readonly bootstrap?: ReadonlyArray<string>
}

/**
 * Bring the sidecar into line with the settings that were just committed.
 *
 * 🔴 **Withdraw, THEN stop** — and in that order, because stopping alone is not withdrawing. There
 * is no unpublish in Kademlia: `withdraw` makes this node stop republishing and stop answering as a
 * provider, and the copies already replicated elsewhere expire at their TTL. Killing the child
 * without withdrawing leaves those copies to be found for the rest of their life while we are not
 * even running — the same outcome, minus the one thing we could actually do about it.
 *
 * ⚠️ A no-op with no I/O when no node was ever started, which is the ordinary case: most machines
 * have no sidecar binary, and a user who never opened the community has never spawned one.
 */
export const reconcile = (input: Gate): Effect.Effect<void> => live?.settle(input) ?? Effect.void

/**
 * The bootstrap list from the settings store, or the empty array meaning "whatever shipped".
 *
 * ⚠️ Read LIVE from the same process-wide config the consent gate uses, not captured at layer build:
 * the whole point of moving this out of the binary is that an agent can repair it while the instance
 * runs, and a snapshot would make that true only until the next boot.
 */
const bootstrapNow = (): ReadonlyArray<string> => {
  const stored = CommunityConsent.storedConfig() as
    | { community?: { dht?: { bootstrap?: unknown } } }
    | undefined
  const list = stored?.community?.dht?.bootstrap
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : []
}

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
      /** The bootstrap list the LIVING node was started with, so a changed one restarts it. */
      let dialledWith: ReadonlyArray<string> = []
      /** The address last successfully announced, so a reconnect re-announces and a repeat does not. */
      let announced: string | undefined
      /** What the last announcement attempt claimed, so a caller can stop asserting something nobody confirmed. */
      let lastAnnounce: { readonly address: string; readonly published: boolean; readonly reason?: string } | undefined
      let pending: ((line: string | undefined) => void) | undefined

      const ensure = (): Node | undefined => {
        if (alive && node !== undefined) return node
        node = undefined
        announced = undefined
        dialledWith = bootstrapNow()
        const started = start(binary, dialledWith)
        if (started === undefined) return undefined
        /**
         * 🔴 Assigned BEFORE the handlers are attached, because the handlers below compare against
         * it — a child that dies during its own registration must be recognised as the live one.
         */
        node = started
        alive = true
        /**
         * 🔴 **Every handler is bound to the node that raised it** (review 1.7, unit 5 F4).
         *
         * They used to close over the layer's mutable state alone, so a replaced child's late
         * `'close'` — arriving after `stop()` had already spawned its successor — set `alive = false`
         * on the LIVING node and settled the pending request belonging to it. Measured: after one
         * wedge-kill, that discovery's find and the next two lookups all returned `[]`, and only a
         * lookup 800 ms later found a peer. A predecessor's death says nothing about the node that
         * replaced it, and a stale `'data'` line is somebody else's answer to somebody else's
         * question.
         */
        started.onLine((line) => {
          if (node !== started) return
          const settle = pending
          pending = undefined
          settle?.(line)
        })
        started.onExit(() => {
          if (node !== started) return
          alive = false
          const settle = pending
          pending = undefined
          // ⚠️ A death mid-request answers the waiter rather than leaving it for the timeout. The
          // caller is a user waiting on a button, and we already know the answer is "nothing".
          settle?.(undefined)
        })
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
              input?.announce !== undefined && CommunityAddress.isAnnounceable(input.announce) ? input.announce.trim() : undefined
            if (advertise !== undefined && advertise !== announced) {
              const reply = yield* ask(JSON.stringify({ op: "announce", addr: advertise }))
              /**
               * 🔴 Remembered only when it actually PUBLISHED. Recording the address on any reply
               * meant `advertise !== announced` was false ever after, so an announcement that failed
               * because the routing table was still empty was never tried again — the instance
               * believed it was published for the rest of the session, and so did its owner.
               *
               * ⚠️ Leaving it unset is what makes the next discovery retry, which is exactly when
               * conditions are likely to be better: the node has been alive longer.
               */
              const published = reply !== undefined && announcedOk(reply)
              if (published) announced = advertise
              /**
               * 🔴 WHY it did not publish, because the panel was telling everybody the same wrong
               * thing (review 1.15). "The network did not accept this address — check that it really
               * reaches you from the internet" is sound advice for a refused announce and useless for
               * a machine that has no sidecar at all, which is the ordinary case: the binary is Rust
               * and most installs never built one. That sentence sent people to re-check a firewall
               * rule when nothing on their machine could have published anything.
               */
              lastAnnounce = {
                address: advertise,
                published,
                ...(published ? {} : { reason: node === undefined ? "no-sidecar" : "refused" }),
              }
            }
            const reply = yield* ask(JSON.stringify({ op: "find" }))
            return reply === undefined ? [] : parse(reply)
          }),
        )

      /**
       * Stop advertising, then stop the node — the whole of what a settings change can enforce.
       *
       * ⚠️ Under the SAME semaphore as `find`, because the protocol is one reply per line with
       * nothing to match a reply to its request: a withdraw written beside a lookup would leave each
       * reading the other's answer, which is the desynchronisation that made a replaced sidecar
       * report no peers three lookups running.
       */
      const withdrawAndStop = gate.withPermits(1)(
        Effect.gen(function* () {
          if (!alive || node === undefined) return
          yield* ask(JSON.stringify({ op: "withdraw" }))
          yield* Effect.sync(stop)
          lastAnnounce = undefined
        }),
      )

      const settle = (input: Gate) =>
        !input.participates ||
        (input.announce ?? "").trim() !== (announced ?? "") ||
        (input.bootstrap ?? bootstrapNow()).join(" ") !== dialledWith.join(" ")
          ? withdrawAndStop
          : Effect.void

      live = { settle }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          live = undefined
        }),
      )

      return Service.of({ find, announced: () => Effect.sync(() => lastAnnounce), withdraw: () => withdrawAndStop })
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
const startNode = (binary: string, bootstrap?: ReadonlyArray<string>): Node | undefined => {
  try {
    /**
     * ⚠️ The override travels as an ENV VAR, and it is only set when the store says something: an
     * unset variable means "use the addresses compiled into this build", while an empty one means
     * "dial nobody automatically". Those are different instructions and the sidecar tells them
     * apart, so passing `""` for "no preference" would silently disable bootstrap entirely.
     */
    const env =
      bootstrap === undefined || bootstrap.length === 0
        ? process.env
        : { ...process.env, NOVACLAW_DHT_BOOTSTRAP: bootstrap.join(" ") }
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"], env })
    const state = { buffer: "" }
    let onLine: ((line: string) => void) | undefined
    let onExit: (() => void) | undefined
    child.on("error", () => onExit?.())
    child.on("close", () => onExit?.())
    /**
     * 🔴 **Writing to a dead child raises `EPIPE` on the STREAM, and an unhandled stream error kills
     * the whole process** (review 1.7, unit 5 F2). Reproduced against a stub that answers one
     * request and exits, under both bun and node 24: `UNCAUGHT EXCEPTION: EPIPE` — the instance
     * server died because a Kademlia helper it did not need had gone away. The `try` around
     * `stdin.write` cannot catch it: the write returns, and the error arrives later as an EVENT.
     *
     * ⚠️ Treated as a death rather than swallowed. A pipe we cannot write to is a node we cannot
     * ask, so the waiter is settled and the next lookup starts a fresh child — the same path a
     * `'close'` takes, which is what it actually is.
     */
    child.stdin.on("error", () => onExit?.())
    child.stdout.on("error", () => onExit?.())
    child.stdout.on("data", (chunk: Buffer) => {
      const lines = readLines(state, chunk.toString())
      if (lines === undefined) {
        /**
         * ⚠️ Treated as a DEATH, not a parse failure: a child sending an unterminated flood is
         * not going to recover, and the caller's contract is that every failure means "no peers".
         * Killing it also stops the flood, which a silent `return` would not.
         */
        try {
          child.kill()
        } catch {
          // Already gone.
        }
        onExit?.()
        return
      }
      for (const line of lines) onLine?.(line)
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
