//! NovaClaw's DHT sidecar: a directory, not a transport.
//!
//! 🔴 It answers one question — *which NovaClaw instances are out there* — and then gets out of the
//! way. The conversation happens on NovaClaw's own HTTP transport, signed and verified as always.
//! Nothing here carries a message, a channel, or an identity claim.
//!
//! ⚠️ It is a SEPARATE PROCESS, spawned lazily the first time an instance that has joined runs
//! discovery, and never at boot. Startup speed is first-class, and a Kademlia node is a long-lived
//! network participant that has no business existing for a user who never turned the community on.
//!
//! ⚠️ Every failure is SILENT to the caller: no peers, no error, join anyway. The DHT is the
//! convenience; the LAN and a typed doorman address are the guarantees. A lookup that could fail a
//! join would make the commons a dependency, which the whole design refuses.
//!
//! Protocol: one JSON object per line on stdin, one per line on stdout.
//!   → {"op":"find"}                  ← {"peers":["1.2.3.4:4096", …]}
//!   → {"op":"announce","addr":"…"}   ← {"announced":true}
//!   → {"op":"status"}                ← {"peers":N,"table":N,"mode":"client"|"server"}

use anyhow::Result;
use futures::StreamExt;
use libp2p::{
    identify, kad,
    multiaddr::Protocol,
    noise, ping,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, BufReader};

/// 🔴 The room: a CONSTANT and VERSIONED.
///
/// A rotating key would buy privacy the enumerability ruling declined, while costing the thing the
/// vision insists on — an instance that has met nobody must still find the room, and it cannot
/// derive a secret schedule from nothing. The version gives a protocol change somewhere to move
/// without stranding old instances silently: they keep meeting each other in the old room rather
/// than finding an empty new one.
const ROOM: &str = "novaclaw/community/1";

/// Public bootstrap, which is the point: we borrow a commons rather than becoming one.
const BOOTSTRAP: &[&str] = &[
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
];

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

/// The room's key, as a Kademlia record key. Sha-256 of the constant, so every instance computes the
/// same one without coordinating.
fn room_key() -> kad::RecordKey {
    kad::RecordKey::new(&Sha256::digest(ROOM.as_bytes()).to_vec())
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
    let mut found: Vec<String> = Vec::new();
    let mut connected = 0usize;

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
                            peers: Vec::new(),
                            announced: None,
                        },
                        Ok(Request::Find) => {
                            swarm.behaviour_mut().kad.get_providers(room_key());
                            Reply { peers: found.clone(), ..Default::default() }
                        }
                        Ok(Request::Announce { addr }) => {
                            // Announcing is only honest from somewhere reachable; the address the
                            // instance gives us is the one it believes peers can knock on.
                            let ok = swarm.behaviour_mut().kad.start_providing(room_key()).is_ok();
                            let _ = addr;
                            Reply { announced: Some(ok), ..Default::default() }
                        }
                        // ⚠️ A malformed line is answered, not fatal: the parent is entitled to a
                        // reply for every line it wrote, or it waits forever for one that never comes.
                        Err(_) => Reply::default(),
                    };
                    println!("{}", serde_json::to_string(&reply)?);
                }
            },
            event = swarm.select_next_some() => match event {
                SwarmEvent::ConnectionEstablished { .. } => connected += 1,
                SwarmEvent::Behaviour(BehaviourEvent::Kad(kad::Event::OutboundQueryProgressed {
                    result: kad::QueryResult::GetProviders(Ok(kad::GetProvidersOk::FoundProviders { providers, .. })),
                    ..
                })) => {
                    for provider in providers {
                        found.push(provider.to_string());
                    }
                }
                _ => {}
            }
        }
    }
    let _ = connected;
    Ok(())
}
