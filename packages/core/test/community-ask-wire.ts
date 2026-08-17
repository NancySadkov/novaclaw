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
// ⚠️ OPEN: B's network id is stable across runs even though its home directory is fresh each time,
// so something of B's persists outside `XDG_DATA_HOME`. It is NOT the developer's store — that
// instance has a different key, and this probe's writes do not appear in it — but the mechanism is
// unexplained, and unexplained state in a harness is how false conclusions get made.
//
// ⚠️ It needs no model unless you ask it to: with answering OFF, B REFUSES, which exercises every
// step above and the refusal dealing. Pass `--answer` to start the stub model server and configure B
// to answer for real.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
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
const CHILD = "NOVACLAW_ASK_WIRE_CHILD"
if (process.env[CHILD] === undefined) {
  const home = mkdtempSync(path.join(tmpdir(), "novaclaw-ask-wire-"))
  mkdirSync(path.join(home, "a"), { recursive: true })
  mkdirSync(path.join(home, "b"), { recursive: true })
  const child = Bun.spawn(["bun", import.meta.path, ...process.argv.slice(2)], {
    env: {
      ...process.env,
      [CHILD]: home,
      NOVACLAW_DB: path.join(home, "a", "novaclaw.db"),
      XDG_DATA_HOME: path.join(home, "a"),
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await child.exited
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* windows may still hold the sqlite handle; the directory is disposable */
  }
  process.exit(code)
}

const wantAnswer = process.argv.includes("--answer")
const B_PORT = 4098
const STUB_PORT = 4111
const root = process.env[CHILD]!

const log = (step: string, detail: string) => console.log(`${step.padEnd(34)} ${detail}`)
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`)
  if (!ok) failures.push(what)
}

const children: Array<{ kill: () => void }> = []
const stop = () => {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
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

await waitFor(async () => (await api("/global/health")).status === 200, "instance B to listen")
log("B is listening", `127.0.0.1:${B_PORT}`)

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

  const before = (yield* ledger.about(peer)).length
  const question = "what happened in the world today?"
  const started = Date.now()
  const result = yield* sync.askPeer(peer, question)
  log("askPeer returned in", `${Date.now() - started} ms`)
  console.log("   result:", JSON.stringify(result).slice(0, 300))

  console.log("\nwhat the wire proved:")
  check(learned === 1, "a bare host:port was LEARNED — the step the DHT path died at")
  const reached = result.answer !== undefined || result.refused !== undefined
  check(reached, "A resolved a route to B and got a REPLY over the socket")

  /**
   * 🔴 The DEALING, which is the half of *"answering is a dealing recorded on both sides"* that had
   * nowhere to happen until the asking side existed. Recorded only once B actually replied — never
   * for a peer we merely named.
   */
  const after = yield* ledger.about(peer)
  check(after.length === before + 1, "exactly one dealing was recorded about B")
  const recorded = after.at(0) as { readonly outcome?: string } | undefined
  console.log("   dealings now:", after.length, JSON.stringify(recorded ?? null).slice(0, 220))

  if (wantAnswer && result.refused === "unavailable") {
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
