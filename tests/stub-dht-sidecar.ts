#!/usr/bin/env bun
// stub-dht-sidecar.ts — a DHT sidecar that speaks the protocol and touches no network.
//
// 🔴 The sibling of `stub-model-server.ts`, and it exists for the same reason: the DHT seam could
// only be exercised by talking to the real public DHT, which is slow, non-deterministic, and leaves
// a provider record behind that outlives the test. Everything between the config key and the wire DASH
// handler, service, spawn, JSON-lines protocol, reply parsing, the `announceConfirmed` field — is
// ours, and none of it needs a real Kademlia node to be checked.
//
// ⚠️ It must be COMPILED, because the seam spawns a binary and Node refuses to spawn a script
// without a shell:
//
//   bun build --compile tests/stub-dht-sidecar.ts --outfile stub-dht.exe
//   NOVACLAW_DHT_BINARY=/abs/path/stub-dht.exe bun run --cwd packages/novaclaw src/index.ts serve
//
// ⚠️ What it proves is bounded, and the bound is the point: that OUR half is wired correctly. It
// says nothing about whether the real DHT accepts an announcement or finds anybody — for that,
// `dht-reachability-probe.mjs` and a host with a public address are still the only answer.
//
// Verified this way on 2026-08-17: with the address set in config, `announceConfirmed` was absent
// before a discovery and `true` after one, which is the whole chain in two observations.

const decoder = new TextDecoder()
let buffer = ""

/** Peers to hand back, so a caller can exercise `learnFrom` without a network. */
const PEERS = (process.env["STUB_DHT_PEERS"] ?? "").split(",").filter((entry) => entry !== "")

/** ⚠️ Set `STUB_DHT_REFUSE=1` to answer `announced: false` — the case a real node reports when it
 *  has no routing table worth publishing into, and the one a seam is most likely to mishandle. */
const REFUSE = process.env["STUB_DHT_REFUSE"] === "1"

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk)
  for (;;) {
    const at = buffer.indexOf(String.fromCharCode(10))
    if (at < 0) break
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.trim() === "") continue

    let request: { op?: string } = {}
    try {
      request = JSON.parse(line) as { op?: string }
    } catch {
      // A malformed line is ANSWERED, not fatal — the real sidecar does the same, because the
      // parent is entitled to one reply per line or it waits forever for one that never comes.
    }

    if (request.op === "announce") console.log(JSON.stringify({ announced: !REFUSE }))
    else if (request.op === "find") console.log(JSON.stringify({ peers: PEERS }))
    else console.log(JSON.stringify({ table: PEERS.length, mode: "client" }))
  }
}
