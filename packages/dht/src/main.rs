//! NovaClaw's DHT sidecar: a directory, not a transport.
//!
//! 🔴 It answers one question — *which NovaClaw instances are out there, and where do I knock* — and
//! then gets out of the way. The conversation happens on NovaClaw's own HTTP transport, signed and
//! verified as always. Nothing here carries a message, a channel, or an identity claim.
//!
//! ⚠️ It is a SEPARATE PROCESS, spawned lazily the first time an instance that has joined runs
//! discovery, and never at boot. Startup speed is first-class, and a Kademlia node is a long-lived
//! network participant that has no business existing for a user who never turned the community on.
//!
//! ⚠️ Every failure is SILENT to the caller: no peers, no error, join anyway. The DHT is the
//! convenience; the LAN and a typed doorman address are the guarantees.
//!
//! Protocol — one JSON object per line in, one per line out. Every request gets exactly one reply.
//!   → {"op":"status"}                       ← {"table":152,"mode":"client"}
//!   → {"op":"announce","addr":"1.2.3.4:4096"} ← {"announced":true}
//!   → {"op":"find"}                         ← {"peers":["1.2.3.4:4096", …]}

use anyhow::Result;
use futures::StreamExt;
use libp2p::{
    identify, kad,
    multiaddr::Protocol,
    noise, ping,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};

/// 🔴 The room: a CONSTANT and VERSIONED.
///
/// A rotating key would buy privacy the enumerability ruling declined, while costing what the vision
/// insists on — an instance that has met nobody must still find the room, and it cannot derive a
/// secret schedule from nothing. The version gives a protocol change somewhere to move without
/// stranding old instances silently: they keep meeting each other in the old room.
const ROOM: &str = "novaclaw/community/1";

/// Public bootstrap, which is the point: we borrow a commons rather than becoming one.
const BOOTSTRAP: &[&str] = &[
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
];

/// How long one `find` may take before answering with whatever it has.
///
/// ⚠️ It ALWAYS answers. A discovery that hangs is worse than one that finds nothing: the caller is
/// a user waiting on a button, and the design already says an unreachable DHT costs freshness, never
/// the join.
const FIND_BUDGET: Duration = Duration::from_secs(25);

/// Enough to bootstrap from. Peer exchange supplies the rest, so a long list buys nothing and costs
/// a dial each.
const MAX_PEERS: usize = 8;

#[derive(NetworkBehaviour)]
struct Behaviour {
    kad: kad::Behaviour<kad::store::MemoryStore>,
    identify: identify::Behaviour,
    ping: ping::Behaviour,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Request {
    Find,
    Announce { addr: String },
    Status,
}

#[derive(Serialize, Default)]
struct Reply {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    peers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    announced: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    table: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
}

fn room_key() -> kad::RecordKey {
    kad::RecordKey::new(&Sha256::digest(ROOM.as_bytes()).to_vec())
}

/// `host:port` → `/ip4/host/tcp/port/http` (or `/dns4/…` for a name).
///
/// 🔴 The HTTP endpoint travels as a MULTIADDR, which is the whole reason no custom record type is
/// needed: multiaddrs already express `/http`, and identify already propagates external addresses.
fn http_multiaddr(addr: &str) -> Option<Multiaddr> {
    let (host, port) = addr.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    let base = match host.parse::<std::net::Ipv4Addr>() {
        Ok(ip) => Multiaddr::empty().with(Protocol::Ip4(ip)),
        Err(_) => Multiaddr::empty().with(Protocol::Dns4(host.into())),
    };
    Some(base.with(Protocol::Tcp(port)).with(Protocol::Http))
}

/// The inverse: an advertised `/http` multiaddr → the `host:port` NovaClaw dials.
///
/// ⚠️ Only `/http` addresses are kept. A peer's libp2p listen addresses are where its DHT node
/// lives, not where its instance answers, and dialling those would be knocking on the wrong door.
fn http_address(ma: &Multiaddr) -> Option<String> {
    let mut host: Option<String> = None;
    let mut port: Option<u16> = None;
    let mut is_http = false;
    for part in ma.iter() {
        match part {
            Protocol::Ip4(ip) => host = Some(ip.to_string()),
            Protocol::Ip6(ip) => host = Some(format!("[{ip}]")),
            Protocol::Dns4(name) | Protocol::Dns6(name) | Protocol::Dns(name) => host = Some(name.to_string()),
            Protocol::Tcp(p) => port = Some(p),
            Protocol::Http => is_http = true,
            _ => {}
        }
    }
    match (is_http, host, port) {
        (true, Some(h), Some(p)) => Some(format!("{h}:{p}")),
        _ => None,
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut swarm = libp2p::SwarmBuilder::with_new_identity()
        .with_tokio()
        .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)?
        .with_dns()?
        .with_behaviour(|key| {
            let peer = key.public().to_peer_id();
            Behaviour {
                kad: kad::Behaviour::new(peer, kad::store::MemoryStore::new(peer)),
                // The public network's identify protocol, not ours: we are a guest in this commons.
                identify: identify::Behaviour::new(identify::Config::new("/ipfs/id/1.0.0".into(), key.public())),
                ping: ping::Behaviour::default(),
            }
        })?
        .build();

    swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse()?)?;

    // ⚠️ DIALLED, not merely added. `add_address` seeds the table with a peer we have never spoken
    // to; only a connection proves the address and identify confirms who answered.
    for addr in BOOTSTRAP {
        if let Ok(ma) = addr.parse::<Multiaddr>() {
            if let Some(Protocol::P2p(id)) = ma.iter().last() {
                swarm.behaviour_mut().kad.add_address(&id, ma.clone());
            }
            let _ = swarm.dial(ma);
        }
    }
    let _ = swarm.behaviour_mut().kad.bootstrap();

    let mut lines = BufReader::new(tokio::io::stdin()).lines();

    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                // ⚠️ EOF means the parent went away. A DHT node outliving the instance that wanted it
                // is a background process nobody asked for, holding connections nobody is using.
                Ok(None) | Err(_) => break,
                Ok(Some(text)) => {
                    let reply = match serde_json::from_str::<Request>(&text) {
                        Ok(Request::Status) => Reply {
                            table: Some(swarm.behaviour_mut().kad.kbuckets().map(|b| b.num_entries()).sum()),
                            mode: Some(format!("{:?}", swarm.behaviour().kad.mode()).to_lowercase()),
                            ..Default::default()
                        },
                        Ok(Request::Announce { addr }) => {
                            /*
                             * 🔴 The address the INSTANCE believes peers can knock on, advertised as
                             * an external multiaddr so identify carries it to whoever finds us.
                             *
                             * ⚠️ Announcing is only honest from somewhere reachable. We do not check
                             * that here — a NAT'd instance announcing costs the network a useless
                             * record and costs itself nothing, and the caller is better placed to
                             * know. Measured 2026-08-17: an announcement with only private addresses
                             * does not become findable, which is survivable because an unreachable
                             * instance dials OUT and never needed to be found.
                             */
                            if let Some(ma) = http_multiaddr(&addr) {
                                swarm.add_external_address(ma);
                            }
                            let ok = swarm.behaviour_mut().kad.start_providing(room_key()).is_ok();
                            Reply { announced: Some(ok), ..Default::default() }
                        }
                        Ok(Request::Find) => find(&mut swarm).await,
                        // ⚠️ A malformed line is ANSWERED, not fatal: the parent is entitled to one
                        // reply per line, or it waits forever for one that never comes.
                        Err(_) => Reply::default(),
                    };
                    println!("{}", serde_json::to_string(&reply)?);
                }
            },
            // Pump the swarm while idle so the routing table fills and connections stay alive.
            _ = swarm.select_next_some() => {}
        }
    }
    Ok(())
}

/// One bounded discovery: ask who provides the room, dial them, and keep the `/http` endpoints they
/// advertise.
///
/// 🔴 It awaits ITS OWN query rather than returning whatever a previous one left behind — the first
/// version did the latter, which meant the first `find` always answered empty and every later one
/// answered stale.
async fn find(swarm: &mut libp2p::Swarm<Behaviour>) -> Reply {
    let query = swarm.behaviour_mut().kad.get_providers(room_key());
    let deadline = tokio::time::Instant::now() + FIND_BUDGET;
    let mut providers: HashSet<PeerId> = HashSet::new();
    let mut addresses: Vec<String> = Vec::new();

    loop {
        if addresses.len() >= MAX_PEERS {
            break;
        }
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            event = swarm.select_next_some() => match event {
                SwarmEvent::Behaviour(BehaviourEvent::Kad(kad::Event::OutboundQueryProgressed {
                    id, result: kad::QueryResult::GetProviders(Ok(found)), ..
                })) if id == query => {
                    if let kad::GetProvidersOk::FoundProviders { providers: peers, .. } = found {
                        for peer in peers {
                            // ⚠️ Dialled so identify tells us where their INSTANCE answers. The DHT
                            // record names a peer; only identify carries the `/http` endpoint.
                            if providers.insert(peer) {
                                let _ = swarm.dial(peer);
                            }
                        }
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received { peer_id, info, .. })) => {
                    if providers.contains(&peer_id) {
                        for ma in info.listen_addrs.iter() {
                            if let Some(addr) = http_address(ma) {
                                if !addresses.contains(&addr) {
                                    addresses.push(addr);
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    Reply { peers: addresses, ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 The conversion is the part a network test cannot check and a typo silently breaks: a wrong
    /// address is not an error, it is a dial to somebody who never joined.
    #[test]
    fn http_endpoint_round_trips() {
        let ma = http_multiaddr("203.0.113.9:4096").expect("ipv4 host:port");
        assert_eq!(ma.to_string(), "/ip4/203.0.113.9/tcp/4096/http");
        assert_eq!(http_address(&ma).as_deref(), Some("203.0.113.9:4096"));

        let named = http_multiaddr("peer.example:8443").expect("dns host:port");
        assert_eq!(named.to_string(), "/dns4/peer.example/tcp/8443/http");
        assert_eq!(http_address(&named).as_deref(), Some("peer.example:8443"));
    }

    /// ⚠️ A peer's libp2p listen addresses are where its DHT NODE lives, not where its instance
    /// answers. Keeping one would send NovaClaw knocking on the wrong door, and the reply would look
    /// like an instance that is simply down.
    #[test]
    fn libp2p_addresses_are_not_http_endpoints() {
        let swarm_addr: Multiaddr = "/ip4/203.0.113.9/tcp/4001".parse().unwrap();
        assert_eq!(http_address(&swarm_addr), None);

        let quic: Multiaddr = "/ip4/203.0.113.9/udp/4001/quic-v1".parse().unwrap();
        assert_eq!(http_address(&quic), None);
    }

    /// ⚠️ Junk answers None rather than panicking: this parses input that arrived from a stranger,
    /// through a DHT, and a sidecar that dies on a malformed address takes discovery with it.
    #[test]
    fn malformed_input_is_refused_quietly() {
        assert!(http_multiaddr("no-port").is_none());
        assert!(http_multiaddr("host:not-a-port").is_none());
        assert!(http_multiaddr("").is_none());
        assert!(http_multiaddr("host:99999").is_none());
    }

    /// The room key is derived, not configured — every instance computes the same one without
    /// coordinating, which is what makes a constant room work at all.
    #[test]
    fn the_room_key_is_stable() {
        assert_eq!(room_key(), room_key());
        assert_eq!(room_key().as_ref().len(), 32);
    }
}
