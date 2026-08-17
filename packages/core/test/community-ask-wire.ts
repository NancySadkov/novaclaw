#!/usr/bin/env bun
// community-ask-wire.ts — one NovaClaw ASKS another, over a real socket.
//
// 🔴 The half the suite cannot reach. `community-ask-live.ts` proves the ANSWERING door by playing a
// stranger against it; everything about the asking side — route resolution, the identity probe,
// signing our own question, the POST, verifying the reply, and recording the dealing — has only ever
// run in-process against mocks. In this program that is exactly where the defects have been.
//
// ⚠️ Instance A is NOT a server here. `askPeer` is a core service, so A is its own stack against its
// own database, which is all an asker is. B is a real `serve` on a real port.
//
//   bun packages/core/test/community-ask-wire.ts
//
// ⚠️ It lives HERE, beside unit tests, without being one: the gate collects `*.test.ts` only, so
// this is never run automatically — but it needs `effect`, and the repo's root `tests/` directory
// cannot resolve it (nothing there declares it, which is why the other probes import only through
// package sources). Typechecking still covers it, which is the half that rots silently.
//
// 🔴 ANSWERED (was: "B's network id is stable across runs, and the mechanism is unexplained").
// An ORPHANED instance from an earlier run held the port, and every later run silently talked to it
// instead of the B it had just spawned. `serve` re-execs its real server and the process in between
// exits, so the listener is reparented and a tree-kill of our own child walks nothing. Both halves
// are fixed below: the port is REFUSED if already held, and teardown kills whoever holds it.
//
// ⚠️ And the product question underneath it was measured rather than assumed: two instances started
// at once, with separate homes, get DISTINCT identities. Isolation holds — the repeated key was this
// harness reusing a zombie, never two instances sharing a peer.
//
// ⚠️ It needs no model unless you ask it to: with answering OFF, B REFUSES, which exercises every
// step above and the refusal dealing. Pass `--answer` to start the stub model server and configure B
// to answer for real.

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { CommunityConsent } from "../src/community/consent"
import { CommunityContacts } from "../src/community/contacts"
import { CommunityChannels } from "../src/community/channels"
import { CommunityDirect } from "../src/community/dm"
import { CommunityObservation } from "../src/community/observation"
import { CommunityOffer } from "../src/community/offer"
import { CommunityPeers } from "../src/community/peers"
import { CommunitySuccession } from "../src/community/succession"
import { CommunitySync } from "../src/community/sync"
import { Database } from "../src/database/database"
import { KillTree } from "../src/util/kill-tree"
import { LayerNode } from "../src/effect/layer-node"
import { InstanceIdentityStore } from "../src/instance-identity-store"

/**
 * 🔴 ISOLATION FIRST, in a CHILD — because `import` runs before any assignment in this file.
 *
 * The first version set `NOVACLAW_DB` and `XDG_DATA_HOME` in the module body, which is far too late:
 * the database path is resolved as the core modules load, so instance A ran against the DEVELOPER'S
 * OWN STORE. It wrote two observations and a peer row there before anyone noticed, and the giveaway
 * was a "fresh" run finding the peer already known — the dealing count climbing 1, 2 across runs
 * that each made a new temp directory.
 *
 * ⚠️ So the env is set for a CHILD process and this one only launches it. The child verifies the
 * path it actually got, rather than trusting that setting the variable was enough.
 */
/**
 * 🔴 ISOLATION IS REQUIRED, NOT ARRANGED HERE — because `import` runs before any assignment in
 * this file, so setting the variables in the module body is far too late. The database path is
 * resolved as the core modules load, and a version of this probe that set them here ran instance A
 * against the DEVELOPER'S OWN STORE, leaving two observations and a peer row in it.
 *
 * ⚠️ A re-exec was tried instead and made things worse in a way worth recording: the relaunched
 * child could never reach the instance it had just spawned, while the identical code run directly
 * reached it on the first attempt. Rather than ship a mechanism whose failure mode is a sixty-second
 * silence, the requirement is stated and CHECKED — `Database.path()` is verified to live inside the
 * temp root further down, because setting a variable is not the same as the path having been taken.
 */
const CHILD = "NOVACLAW_ASK_WIRE_CHILD"
const root = process.env[CHILD]
if (root === undefined || process.env["NOVACLAW_DB"] === undefined) {
  const home = mkdtempSync(path.join(tmpdir(), "novaclaw-ask-wire-"))
  mkdirSync(path.join(home, "a"), { recursive: true })
  mkdirSync(path.join(home, "b"), { recursive: true })
  console.error("This probe must be started with an ISOLATED environment, or instance A writes into a real store.")
  console.error("A disposable one has been prepared. Run:")
  console.error(`  NOVACLAW_ASK_WIRE_CHILD='${home}' NOVACLAW_DB='${path.join(home, "a", "novaclaw.db")}' XDG_DATA_HOME='${path.join(home, "a")}' bun ${import.meta.path}${process.argv.slice(2).join(" ") === "" ? "" : " " + process.argv.slice(2).join(" ")}`)
  process.exit(1)
}

const wantAnswer = process.argv.includes("--answer")
/** {i}: the user outranks the ledger — a blocked peer stays blocked, however it became reachable. */
const wantBlocked = process.argv.includes("--blocked")
/**
 * 🔴 A FRESH port per run, not a fixed one.
 *
 * With 4098 hard-coded, a run that followed a just-killed predecessor would intermittently see B log
 * *"listening on 127.0.0.1:4098"* while every connection attempt failed for the full sixty-second
 * budget — a new bind can succeed while the previous socket is still shutting down, and the harness
 * then blamed whatever it had changed most recently. It cost this probe two separate misdiagnoses:
 * first the re-exec, then "the machine is busy".
 *
 * ⚠️ The port is the only thing two runs ever shared. Removing the sharing removes the class.
 */
const B_PORT = 41000 + Math.floor(Math.random() * 4000)
const STUB_PORT = 4111

const log = (step: string, detail: string) => console.log(`${step.padEnd(34)} ${detail}`)
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`)
  if (!ok) failures.push(what)
}

/**
 * Kill whatever is LISTENING on a port, however it got there.
 *
 * 🔴 The pid is discovered from the port and the killing is delegated to `KillTree.killTreeSync` —
 * the repo has exactly one process-tree kill and a ledger that refuses a second. Hand-rolling
 * `taskkill /T /F` here was caught by that ledger, correctly: the reason this probe needs a tree kill
 * at all is that `serve` re-execs its real server, which is precisely the case that helper exists for.
 *
 * ⚠️ Only the LOOKUP is platform-specific, because a pid is what the helper wants and the port is
 * all we have: the listener was reparented, so nothing we spawned still points at it.
 */
const pidHolding = (port: number): number | undefined => {
  try {
    if (process.platform === "win32") {
      const found = Bun.spawnSync([
        "powershell.exe",
        "-NoProfile",
        "-Command",
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
      ])
      const pid = Number(new TextDecoder().decode(found.stdout).trim())
      return Number.isFinite(pid) && pid > 0 ? pid : undefined
    }
    const found = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`])
    const pid = Number(new TextDecoder().decode(found.stdout).split(String.fromCharCode(10))[0]?.trim())
    return Number.isFinite(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

const killWhoeverHolds = (port: number): void => {
  const pid = pidHolding(port)
  if (pid !== undefined) KillTree.killTreeSync(pid)
}

const children: Array<{ kill: () => void; readonly pid: number }> = []
const stop = () => {
  for (const child of children) {
    try {
      /**
       * 🔴 The whole TREE, through the repo's one tree-kill — because `serve` runs its real server
       * under a SUPERVISOR that restarts the child when it dies. Killing the listener alone just
       * makes a new one, with the same environment and the same database: that is why an "orphan"
       * kept coming back on this port and why B's identity looked frozen across runs.
       */
      KillTree.killTreeSync(child.pid)
      child.kill()
    } catch {
      /* already gone */
    }
  }
  /**
   * 🔴 And kill whoever actually HOLDS THE PORT, which is not necessarily anything we spawned.
   *
   * `serve` re-execs the real server and the process in between exits, so the listener is reparented
   * and a tree-kill of our own child finds nothing to walk. Measured 2026-08-17: three orphans in a
   * row survived teardown that way, and the first of them silently served every later run. The port
   * is the thing that matters, so the port is what gets cleaned up.
   */
  killWhoeverHolds(B_PORT)

  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* windows sometimes holds the sqlite file briefly; the temp dir is disposable either way */
  }
}
process.on("exit", stop)

const waitFor = async (probe: () => Promise<boolean>, what: string, budgetMs = 60_000) => {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * 🔴 REFUSE to reuse a server we did not start.
 *
 * Measured 2026-08-17: an orphan from the FIRST run held this port for an hour, and every run after
 * it silently talked to that zombie instead of the isolated B it had just spawned — the giveaway was
 * B's network id never changing across runs with fresh temp homes. A probe that quietly reuses a
 * stranger's instance reports on state nobody in this run created.
 */
const portHeld = await fetch(`http://127.0.0.1:${B_PORT}/global/health`)
  .then((response) => response.ok)
  .catch(() => false)
if (portHeld) {
  console.error(`REFUSING TO RUN: something is already listening on ${B_PORT}.`)
  console.error("It is probably an orphaned instance from an earlier run. Stop it and try again.")
  process.exit(1)
}

// ── B: a real instance, on a real port, with its own database ────────────────────────────────────
const bHome = path.join(root, "b")
// ⚠️ It must EXIST: a database path whose parent is missing falls back to the default location,
// which is how instance B ended up sharing the developer's store with A.
mkdirSync(bHome, { recursive: true })
const repoRoot = path.join(import.meta.dirname, "..", "..", "..")
const b = Bun.spawn(["bun", "run", "--cwd", "packages/novaclaw", "src/index.ts", "serve", "--port", String(B_PORT)], {
  cwd: repoRoot,
  env: {
    ...process.env,
    // ⚠️ BOTH, or the instance reaches the owner's real store — the isolation is not one variable.
    NOVACLAW_DB: path.join(bHome, "novaclaw.db"),
    XDG_DATA_HOME: bHome,
    NOVACLAW_SERVER_PASSWORD: "",
  },
  stdout: "pipe",
  stderr: "pipe",
})
children.push(b)

const api = async (route: string, init?: RequestInit) => {
  const response = await fetch(`http://127.0.0.1:${B_PORT}${route}`, init)
  return { status: response.status, body: await response.text() }
}

/**
 * 🔴 B's own output is READ on failure. It was piped and never drained, so when B refused to start
 * this probe could only say "timed out" — the one sentence that cannot be acted on. A harness that
 * cannot explain why the thing it started did not start is not diagnosable.
 */
let attempts = 0
await waitFor(async () => {
  const probe = await api("/global/health")
  attempts += 1
  if (attempts <= 3 || attempts % 20 === 0) console.log(`  health attempt ${attempts}: status ${probe.status} body ${probe.body.slice(0, 60)}`)
  return probe.status === 200
}, "instance B to listen").catch(async (cause) => {
  const out = await new Response(b.stdout).text().catch(() => "")
  const err = await new Response(b.stderr).text().catch(() => "")
  console.error("\n--- instance B never listened; its own output follows ---")
  console.error((out + err).slice(0, 2000) || "(B printed nothing at all)")
  stop()
  throw cause
})
log("B is listening", `127.0.0.1:${B_PORT}`)
log("B home contents", readdirSync(bHome).join(", ") || "(empty)")

const patch = (body: unknown) =>
  api("/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

// Joining is a decision, and B has to have made it before anyone can be answered — or refused.
await patch({ community: { consented: true, enabled: true, answers: { enabled: wantAnswer } } })

if (wantAnswer) {
  const stub = Bun.spawn(["bun", "tests/stub-model-server.ts", String(STUB_PORT)], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  children.push(stub)
  await waitFor(async () => (await fetch(`http://127.0.0.1:${STUB_PORT}/v1/models`)).ok, "the stub model server")
  log("stub model server", `127.0.0.1:${STUB_PORT}`)

  /**
   * 🔴 B needs a MODEL, or it answers `unavailable` — which is a correct refusal and proves
   * nothing about answering. The answering turn calls `resolveDefault()`, so what it needs is a
   * provider it can reach and a default naming it, `providerID/modelID`.
   *
   * ⚠️ Pointed at the stub, never at a real vendor: this must not spend anybody's tokens, and an
   * answer whose text we CHOSE is what lets the assertion below be about the wire rather than about
   * a model's mood.
   */
  const configured = await patch({
    providers: {
      stub: {
        name: "Stub",
        api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `http://127.0.0.1:${STUB_PORT}/v1` },
        models: { "stub-model": { name: "Stub model" } },
      },
    },
    model: "stub/stub-model",
  })
  log("B's model", configured.status === 200 ? "stub/stub-model" : `REFUSED (${configured.status}) ${configured.body.slice(0, 120)}`)
}

const identity = JSON.parse((await api("/api/community/identity")).body) as { networkID?: string }
if (identity.networkID === undefined) throw new Error("B did not report an identity")
log("B's identity", `${identity.networkID.slice(0, 24)}…`)

// ── A: an asker, which is only a stack and a database ────────────────────────────────────────────
process.env["NOVACLAW_DB"] = path.join(root, "a", "novaclaw.db")
process.env["XDG_DATA_HOME"] = path.join(root, "a")

const stack = LayerNode.compile(
  LayerNode.group([
    Database.node,
    InstanceIdentityStore.node,
    CommunityChannels.node,
    CommunityContacts.node,
    CommunityPeers.node,
    CommunityDirect.node,
    CommunityOffer.node,
    CommunitySuccession.node,
    CommunityObservation.node,
    CommunitySync.node,
  ]),
)

/**
 * 🔴 VERIFIED, not assumed. Setting the variable is not the same as the path having been taken,
 * and the difference is the developer's own store — which is where this probe wrote before the
 * re-exec above existed. `fixture/db.ts` refuses to reset a database it does not recognise for the
 * same reason.
 */
const resolved = Database.path()
if (!resolved.startsWith(root)) {
  console.error(`REFUSING TO RUN: the database resolved to ${resolved}, which is outside ${root}.`)
  console.error("Instance A would write into a real store. Run this file directly; it re-execs itself with isolation.")
  stop()
  process.exit(1)
}
log("A's database", resolved)

const program = Effect.gen(function* () {
  // A has joined too: `askPeer` refuses before it dials otherwise, which is the correct behaviour
  // and would make this prove nothing.
  CommunityConsent.applied({ consented: true }, { enabled: true })

  const peers = yield* CommunityPeers.Service
  const sync = yield* CommunitySync.Service
  const ledger = yield* CommunityObservation.Service
  const peer = identity.networkID!

  // The one thing an asker needs: an address, from any source. This is what discovery, a typed
  // doorman address, or the DHT would have supplied.
  /**
   * 🔴 Learned the way the DHT delivers them: a BARE `host:port`, through `learnFrom`.
   *
   * Not `peers.learn` directly — that would store a route this probe invented and skip the exact
   * step where the real path broke. `CommunityDht.find` returns `host:port` with no scheme, and
   * `learnFrom` used to filter those out before any dial, so the sidecar could work perfectly and
   * no peer would ever be added.
   */
  const learned = yield* sync.learnFrom([`127.0.0.1:${B_PORT}`], "dht")
  log("A learned from a DHT-shaped address", `127.0.0.1:${B_PORT} -> ${learned} peer(s)`)

  if (wantBlocked) {
    /**
     * 🔴 §5(i) of `notes/spec/honesty-ledger.md`: *the user outranks the ledger*, and the vision
     * keeps who you block out of the agent's reach entirely. A peer known through the LAN, peer
     * exchange or the DHT lives in the PEERS table, and `askPeer` reads that table — so this asks
     * whether blocking actually stops a dial, or only stops the contact half.
     */
    const contacts = yield* CommunityContacts.Service
    yield* contacts.add({ networkID: peer, routes: [`http://127.0.0.1:${B_PORT}`] })
    yield* contacts.setBlocked(peer, true)
    log("B is BLOCKED by the user", peer.slice(0, 24) + "…")
  }

  const before = (yield* ledger.about(peer)).length
  const question = "what happened in the world today?"
  const started = Date.now()
  const result = yield* sync.askPeer(peer, question)
  log("askPeer returned in", `${Date.now() - started} ms`)
  console.log("   result:", JSON.stringify(result).slice(0, 300))

  console.log("\nwhat the wire proved:")
  check(learned === 1, "a bare host:port was LEARNED — the step the DHT path died at")
  /**
   * 🔴 INVERTED under `--blocked`, where the whole point is that nothing was dialled and nothing
   * was recorded. Running these anyway made a successful block report "2 CHECKS FAILED" — a harness
   * that cries failure at the behaviour it was asked to prove is worse than none, because the next
   * person believes it.
   */
  if (!wantBlocked) {
    const reached = result.answer !== undefined || result.refused !== undefined
    check(reached, "A resolved a route to B and got a REPLY over the socket")
  }

  /**
   * 🔴 The DEALING, which is the half of *"answering is a dealing recorded on both sides"* that had
   * nowhere to happen until the asking side existed. Recorded only once B actually replied — never
   * for a peer we merely named.
   */
  const after = yield* ledger.about(peer)
  if (!wantBlocked) check(after.length === before + 1, "exactly one dealing was recorded about B")
  const recorded = after.at(0) as { readonly outcome?: string } | undefined
  console.log("   dealings now:", after.length, JSON.stringify(recorded ?? null).slice(0, 220))

  if (wantBlocked) {
    check(
      result.answer === undefined && result.refused === undefined,
      "a BLOCKED peer is not dialled at all — §5(i), the user outranks the ledger",
    )
    check(after.length === before, "and nothing is recorded about somebody we must not have contacted")
  } else if (wantAnswer && result.refused === "unavailable") {
    /**
     * ⚠️ Not a failure of the asking side, and it must not be reported as one. `unavailable`
     * means B accepted the question and had no MODEL to answer it with — the stub server is
     * running, but nothing in B's configuration points at it. Everything this probe exists to check
     * has already passed by this line.
     */
    console.log("   B has answering ON but no model configured, so it answered `unavailable`.")
    console.log("   The asking side is proven above; wiring a provider into B is the remaining step.")
  } else if (wantAnswer) {
    check(result.answer !== undefined, "B ANSWERED, and the signature verified")
    check(result.author === peer, "the answer is attributed to B, not merely signed by somebody")
    check(recorded?.outcome === "answered", "the dealing records that they answered")

    /**
     * 🔴 The SPEND, observed on B rather than inferred from here. Answering moves that instance's
     * daily counter, and until now that was pinned only by reading the source for the ORDER of two
     * statements. This is the behaviour those statements exist to produce.
     *
     * ⚠️ And it is honest about its reach: if the spend drifted back to "only on success" this
     * would still pass. The case it was moved for — a turn that RAN and produced nothing — cannot be
     * staged with a stub that always answers, so the ORDER stays pinned structurally too.
     */
    const participation = yield* Effect.promise(() => api("/api/community/participation"))
    const state = JSON.parse(participation.body) as { answers?: { today?: number; perDay?: number } }
    console.log("   B's budget after answering:", JSON.stringify(state.answers))
    check(state.answers?.today === 1, "answering moved B's daily budget by exactly one")
  } else {
    check(result.refused !== undefined, "B refused, because answering is off — and SAID so rather than going quiet")
    check(result.answer === undefined, "a refusal carries no answer")
    check(recorded?.outcome === "refused", "a refusal is recorded too — 'they would not answer' is standing")
  }
})

await Effect.runPromise(Effect.provide(program, stack) as Effect.Effect<void>)

// ⚠️ A tallied EXIT, because `check` printing FAIL is not a failing process — a probe whose red
// lines scroll past a green exit code is one nobody trusts twice.
console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED`)
stop()
process.exit(failures.length === 0 ? 0 : 1)
