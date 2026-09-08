#!/usr/bin/env node
// dht-reachability-probe.mjs — can NovaClaw instances find each other through the public DHT?
//
// 🔴 The one link the design still rests on and nobody has measured: that a REACHABLE instance's
// announcement becomes findable. Everything either side of it is measured (2026-08-17):
//
//   · the client reaches the commons  — 49 peers, 47-entry routing table, TCP only, behind NAT
//   · lookups work                    — 15 providers for a long-lived public CID (the control)
//
// ⚠️ WITHDRAWN: "a NAT'd announcement is not findable". It was never measured. This file `await`ed an
// `async *generator`, so the announcement half of every earlier run published NOTHING, and the zeroes
// it produced were lookups for records that were never sent. The control passed throughout, which is
// what made the zeroes look like a result about NAT instead of a broken instrument.
//
// ⚠️ Run this ON A HOST WITH A PUBLIC ADDRESS and an inbound TCP port. It must NOT be the project's
// own VPS: `novaclaw.app is a static page about Nova and must not be responsible for the network`,
// and a node there makes it network infrastructure — which is what that ruling refuses.
//
// ⚠️ It needs js-libp2p, which the app does not depend on yet. Install into a scratch directory:
//   bun add libp2p @libp2p/kad-dht @libp2p/tcp @chainsafe/libp2p-noise @chainsafe/libp2p-yamux \
//           @libp2p/identify @libp2p/ping @libp2p/bootstrap multiformats
//   node dht-reachability-probe.mjs [announce|find|control] [tcp-port]
//
// Two hosts: run `announce` on the reachable one, then `find` anywhere. `control` proves the lookup
// path works at all — without it, "found nothing" is indistinguishable from a broken harness, which
// is the mistake this file exists to prevent somebody repeating.

import { createLibp2p } from "libp2p"
import { kadDHT } from "@libp2p/kad-dht"
import { tcp } from "@libp2p/tcp"
import { noise } from "@chainsafe/libp2p-noise"
import { yamux } from "@chainsafe/libp2p-yamux"
import { identify } from "@libp2p/identify"
import { ping } from "@libp2p/ping"
import { bootstrap } from "@libp2p/bootstrap"
import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"
import * as raw from "multiformats/codecs/raw"

const BOOTSTRAP = [
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
]

/**
 * 🔴 The room. A CONSTANT and VERSIONED, as the spec settled: a rotating key would buy privacy the
 * enumerability ruling declined, while costing the thing the vision insists on — an instance that
 * has met nobody must still find the room, and it cannot derive a secret schedule from nothing.
 */
const ROOM = "novaclaw/community/1"
const roomCid = async () => CID.createV1(raw.code, await sha256.digest(new TextEncoder().encode(ROOM)))

/** A long-lived public block, for the control. */
const KNOWN = CID.parse("QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB")

const mode = process.argv[2] ?? "control"
const port = Number(process.argv[3] ?? 0)

const node = await createLibp2p({
  /**
   * 🔴 BOTH stacks. A host can be publicly routable over IPv6 while sitting behind NAT on IPv4 —
   * which is the ordinary situation for a machine on a modern home connection, and the only way this
   * probe gets a REACHABLE announcement without renting a server. Listening on v4 alone would make
   * such a host look unreachable when it is not.
   */
  addresses: {
    listen: [`/ip4/0.0.0.0/tcp/${port}`, `/ip6/::/tcp/${port === 0 ? 0 : port + 1}`],
    /**
     * 🔴 STATE the public address; do not hope it is discovered. Measured 2026-08-17 on a VPS whose
     * public IPv4 sits on eth0: listening on 0.0.0.0 enumerated a SUBSET of interfaces and missed it,
     * so the announcement carried loopback and a docker bridge — addresses nobody can dial, from a
     * host that is perfectly reachable. The lookup then found nothing, and the cause looked like the
     * DHT rather than like an address list.
     */
    ...(process.env.ANNOUNCE_ADDR ? { announce: [process.env.ANNOUNCE_ADDR] } : {}),
  },
  transports: [tcp()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  peerDiscovery: [bootstrap({ list: BOOTSTRAP })],
  services: {
    identify: identify(),
    // ⚠️ kad-dht DECLARES this dependency and refuses to start without it — better than failing at
    // runtime, where a missing piece would surface as "discovery found nobody".
    ping: ping(),
    /**
     * 🔴 SERVER mode when announcing. clientMode queries the DHT and stores nothing for anybody,
     * which is free-riding on the commons — the opposite of the stated reason for joining it. In
     * the product this follows observed reachability (AutoNAT), never a preference.
     */
    dht: kadDHT({ clientMode: mode !== "announce" }),
  },
})

console.log(`mode=${mode} peer=${node.peerId.toString()}`)
console.log("addrs:", node.getMultiaddrs().map(String))

// Give the routing table time to fill; a lookup before it does answers nothing and means nothing.
await new Promise((resolve) => setTimeout(resolve, 25_000))
console.log("routing table:", node.services.dht.routingTable.size)

const search = async (cid, label) => {
  let found = 0
  const providers = []
  try {
    for await (const event of node.services.dht.findProviders(cid, { signal: AbortSignal.timeout(60_000) })) {
      if (event.name !== "PROVIDER") continue
      found += event.providers.length
      for (const provider of event.providers) providers.push(provider.id.toString())
      if (found >= 5) break
    }
  } catch (error) {
    console.log(`${label} error:`, String(error).slice(0, 140))
  }
  console.log(`${label}: ${found} provider(s)`, providers.slice(0, 5))
  return found
}

if (mode === "control") {
  const n = await search(KNOWN, "control (known public CID)")
  console.log(n > 0 ? "CONTROL PASSES — lookups work here" : "CONTROL FAILS — do not trust any other result")
} else if (mode === "announce") {
  const cid = await roomCid()
  console.log("room CID:", cid.toString())
  /**
   * 🔴 DRAINED, and the count is printed. `provide` is an `async *generator`: `await`ing it builds the
   * generator and runs NOT ONE LINE of its body, so the original `await node.services.dht.provide(cid)`
   * published nothing while looking exactly like a successful announcement. Every "0 providers" this
   * probe reported before 2026-08-17 was a lookup for a record that was never sent — including the
   * conclusion, since withdrawn, that a NAT'd announcement is not findable.
   *
   * ⚠️ The multiaddrs are passed EXPLICITLY. They are the second parameter, and a record that names
   * no address is one nobody can act on.
   */
  let sent = 0
  for await (const event of node.services.dht.provide(cid, node.getMultiaddrs())) {
    if (event.name === "PEER_RESPONSE" && event.messageName === "ADD_PROVIDER") sent += 1
  }
  console.log(`announced — record accepted by ${sent} peer(s).`)
  if (sent === 0) console.log("⚠️ NOBODY STORED IT. A `find` below would say nothing about reachability.")
  console.log("Leave this running, then run `find` elsewhere.")
  await new Promise(() => {})
} else {
  const cid = await roomCid()
  console.log("room CID:", cid.toString())
  const control = await search(KNOWN, "control (known public CID)")
  if (control === 0) console.log("⚠️ CONTROL FAILED — a zero below proves nothing about NovaClaw.")
  await search(cid, "novaclaw room")
}

await node.stop()
