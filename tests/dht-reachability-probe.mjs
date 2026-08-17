#!/usr/bin/env node
// dht-reachability-probe.mjs — can NovaClaw instances find each other through the public DHT?
//
// 🔴 The one link the design still rests on and nobody has measured: that a REACHABLE instance's
// announcement becomes findable. Everything either side of it is measured (2026-08-17):
//
//   · the client reaches the commons  — 49 peers, 47-entry routing table, TCP only, behind NAT
//   · lookups work                    — 15 providers for a long-lived public CID (the control)
//   · a NAT'd announcement            — NOT findable, and the transport was built for that
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
  addresses: { listen: [`/ip4/0.0.0.0/tcp/${port}`] },
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
  await node.services.dht.provide(cid)
  console.log("announced. Leave this running, then run `find` elsewhere.")
  await new Promise(() => {})
} else {
  const cid = await roomCid()
  console.log("room CID:", cid.toString())
  const control = await search(KNOWN, "control (known public CID)")
  if (control === 0) console.log("⚠️ CONTROL FAILED — a zero below proves nothing about NovaClaw.")
  await search(cid, "novaclaw room")
}

await node.stop()
