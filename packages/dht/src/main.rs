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
//!   → {"op":"version"}                      ← {"protocol":"novaclaw-dht-jsonl/1",…}
//!   → {"op":"status"}                       ← {"table":152,"mode":"client"}
//!   → {"op":"announce","addr":"1.2.3.4:4096"} ← {"announced":true}
//!   → {"op":"withdraw"}                     ← {"announced":false}
//!   → {"op":"find"}                         ← {"peers":["1.2.3.4:4096", …]}

use anyhow::Result;
use futures::StreamExt;
use libp2p::{
    identify, kad,
    multiaddr::Protocol,
    noise, ping,
    core::Endpoint,
    swarm::{ConnectionId, NetworkBehaviour, SwarmEvent},
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

/// Build identity supplied by `build.ts`. Direct `cargo test` remains useful without the packaging
/// environment, but no packaged artifact may contain these development fallbacks: both the pre-pack
/// guard and the artifact smoke compare every field against the current source tree.
const BUILD_PROTOCOL: &str = match option_env!("NOVACLAW_DHT_PROTOCOL_VERSION") {
    Some(value) => value,
    None => "development",
};
const BUILD_VERSION: &str = match option_env!("NOVACLAW_DHT_PRODUCT_VERSION") {
    Some(value) => value,
    None => "development",
};
const BUILD_SOURCE: &str = match option_env!("NOVACLAW_DHT_SOURCE_ID") {
    Some(value) => value,
    None => "development",
};

/// The env var a parent process uses to REPLACE the compiled list, space or comma separated.
///
/// 🔴 Because a bootstrap list is an operational fact an outage can hinge on, and AGENTS.md's
/// self-healing law says those live in runtime-editable stores rather than in a binary (Codex review
/// P2). The instance reads `community.dht.bootstrap` from its settings store and passes it here, so a
/// user whose bootstrap operator vanished asks any working model to point them elsewhere instead of
/// waiting for a new release.
///
/// ⚠️ An EMPTY value is meaningful and is not the same as absent: it means dial nobody
/// automatically. Absent means use what shipped.
const BOOTSTRAP_ENV: &str = "NOVACLAW_DHT_BOOTSTRAP";

/// Public bootstrap, which is the point: we borrow a commons rather than becoming one.
const BOOTSTRAP: &[&str] = &[
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
];

/// How long one `find` may take before answering with whatever it has.
///
/// ⚠️ It ALWAYS answers. A discovery that hangs is worse than one that finds nothing: the caller
/// is a user waiting on a button.
///
/// 🔴 EIGHT seconds, measured down from 25. At 25 the first live run took 25.2 s — and that time
/// is spent in FRONT of a discovery that also looks on the LAN, so an instance sitting beside
/// another one waited half a minute to be told about a neighbour it could see instantly. **The DHT
/// is a convenience, and a convenience that slows the guarantees down is not one.**
///
/// ⚠️ A shorter budget finds fewer providers per call, and that is the right trade: one reachable
/// instance is a complete entry point, because peer exchange supplies everyone else.
const FIND_BUDGET: Duration = Duration::from_secs(8);

/// Enough to bootstrap from. Peer exchange supplies the rest, so a long list buys nothing and costs
/// a dial each.
const MAX_PEERS: usize = 8;

/// How long an `announce` may take, warm-up included, before it answers honestly that it failed.
///
/// 🔴 Longer than `FIND_BUDGET` on purpose, and it does NOT sit in front of a user. Announcing runs
/// once for an instance that has decided it is reachable; finding runs whenever somebody opens the
/// community and is the thing that must feel instant.
const ANNOUNCE_BUDGET: Duration = Duration::from_secs(30);

/// Peers the routing table must hold before publishing is worth attempting.
///
/// 🔴 A publish reaches the peers CLOSEST TO THE KEY, chosen from the ones we know. Measured
/// 2026-08-17: `announce` arriving one line after startup published into a **3-entry** table and the
/// record reached nobody — confirmed absent from the public DHT by an outside instrument while this
/// program reported success. Twenty is roughly a full bucket: enough for the query to have somewhere
/// to walk, far below the ~150 the table reaches within a minute.
const MIN_TABLE_TO_PUBLISH: usize = 20;

/// How long a `find` waits for a routing table before querying anyway.
///
/// 🔴 Without this the feature is DEAD IN PRODUCTION and green everywhere else. The seam spawns
/// this process, writes `find`, reads one reply and closes stdin — so **every** production find is a
/// cold one, issued milliseconds after startup against a 3-entry table. Measured 2026-08-17: two cold
/// finds returned nothing while a find after a 30 s sleep returned the peer. The warm-up is nearly
/// free: the table crosses 20 entries in **1.5-2.0 s** (50 in 2.5-3.0 s), so this buys the whole
/// feature for about two seconds and never lets a slow network hold the budget open.
const WARM_UP_BUDGET: Duration = Duration::from_secs(5);

#[derive(NetworkBehaviour)]
struct Behaviour {
    kad: kad::Behaviour<kad::store::MemoryStore>,
    identify: identify::Behaviour,
    ping: ping::Behaviour,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Request {
    Version,
    Find,
    Announce { addr: String },
    Withdraw,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    arch: Option<String>,
}

/// The room's DHT key: the **multihash** of [`ROOM`], not its bare digest.
///
/// 🔴 The two-byte prefix is the whole point. Kademlia keys are opaque bytes, so a bare
/// `Sha256::digest` "works" — it announces and looks up against itself perfectly, and every test
/// passes. But every other implementation of this DHT keys on a CID's multihash (`sha2-256`, 32
/// bytes), so a bare digest puts us in a room of our own that nothing else can name. Measured
/// 2026-08-17: the reachability probe and this sidecar disagreed exactly here, and the probe's
/// verdicts were about a room the product never used — a silence that read as "the DHT does not
/// carry our announcements" for as long as nobody compared the two key derivations.
///
/// ⚠️ Being nameable by ordinary tooling is a FEATURE here, not a leak: `notes/spec/community-p2p.md`
/// records the ruling that enumerability is the price of true p2p. It is also the only reason the
/// announcement can be checked from outside our own code, which is how this defect was found.
fn room_key() -> kad::RecordKey {
    let mut key = Vec::with_capacity(34);
    key.push(0x12); // sha2-256
    key.push(0x20); // 32 bytes
    key.extend_from_slice(&Sha256::digest(ROOM.as_bytes()));
    kad::RecordKey::new(&key)
}

/// `host:port` → `/ip4/host/tcp/port/http` (or `/dns4/…` for a name).
///
/// 🔴 The HTTP endpoint travels as a MULTIADDR, which is the whole reason no custom record type is
/// needed: multiaddrs already express `/http`, and identify already propagates external addresses.
fn http_multiaddr(addr: &str) -> Option<Multiaddr> {
    // ⚠️ BRACKETED IPv6 first, because `rsplit_once(':')` on `[2001:db8::1]:4096` would otherwise
    // split inside the address itself. An IPv6-only instance could not publish at all until this
    // existed (Codex review P3), while the inverse parser below has read IPv6 the whole time.
    let (host, port) = match addr.strip_prefix('[') {
        Some(rest) => {
            let (inner, tail) = rest.split_once(']')?;
            (inner, tail.strip_prefix(':')?)
        }
        None => addr.rsplit_once(':')?,
    };
    let port: u16 = port.parse().ok()?;
    // A port is 1..=65535; zero is not a port anyone answers on, and `u16` alone would accept it.
    if port == 0 {
        return None;
    }
    let base = match host.parse::<std::net::Ipv4Addr>() {
        Ok(ip) => Multiaddr::empty().with(Protocol::Ip4(ip)),
        Err(_) => match host.parse::<std::net::Ipv6Addr>() {
            Ok(ip) => Multiaddr::empty().with(Protocol::Ip6(ip)),
            Err(_) => Multiaddr::empty().with(Protocol::Dns4(host.into())),
        },
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
    for addr in bootstrap_list() {
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
                        Ok(Request::Version) => Reply {
                            protocol: Some(BUILD_PROTOCOL.to_string()),
                            version: Some(BUILD_VERSION.to_string()),
                            source: Some(BUILD_SOURCE.to_string()),
                            platform: Some(std::env::consts::OS.to_string()),
                            arch: Some(std::env::consts::ARCH.to_string()),
                            ..Default::default()
                        },
                        Ok(Request::Status) => Reply {
                            table: Some(swarm.behaviour_mut().kad.kbuckets().map(|b| b.num_entries()).sum()),
                            mode: Some(format!("{:?}", swarm.behaviour().kad.mode()).to_lowercase()),
                            ..Default::default()
                        },
                        Ok(Request::Announce { addr }) => announce(&mut swarm, &addr).await,
                        Ok(Request::Withdraw) => withdraw(&mut swarm),
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

/// The addresses to dial at startup: the parent's list if it supplied one, else what shipped.
///
/// ⚠️ Set-but-empty is honoured as "dial nobody", which is why this distinguishes `Err` from an
/// empty string rather than treating both as "use the defaults".
fn bootstrap_list() -> Vec<String> {
    match std::env::var(BOOTSTRAP_ENV) {
        Err(_) => BOOTSTRAP.iter().map(|addr| addr.to_string()).collect(),
        Ok(raw) => raw
            .split([',', ' ', '\n', '\t'])
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect(),
    }
}

/// The `/http` endpoints kad already knows for a peer.
///
/// ⚠️ `handle_pending_outbound_connection` is how kad supplies addresses to the swarm for a dial;
/// asking it directly is the same question without the dial. Anything that is not an `/http` address
/// is dropped: a peer's libp2p listen addresses are where its DHT node lives, not where its instance
/// answers.
fn endpoints_of(swarm: &mut libp2p::Swarm<Behaviour>, peer: PeerId) -> Vec<String> {
    swarm
        .behaviour_mut()
        .kad
        .handle_pending_outbound_connection(ConnectionId::new_unchecked(0), Some(peer), &[], Endpoint::Dialer)
        .unwrap_or_default()
        .iter()
        .filter_map(http_address)
        .collect()
}

/// A duration constant, overridable by env for MEASUREMENT.
///
/// ⚠️ Not a feature knob and not documented as one: the defaults are the product. It exists because
/// choosing `FIND_BUDGET` and `WARM_UP_BUDGET` well needs them varied against the live network, and a
/// budget nobody can vary is a budget nobody re-measures.
fn budget(name: &str, default: Duration) -> Duration {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(default)
}

/// Whether the field diagnostic on stderr is on. Read per call, never cached: a sidecar that must
/// be turned up in the field is one somebody is already having a bad day with.
fn debug_enabled() -> bool {
    std::env::var_os("NOVACLAW_DHT_DEBUG").is_some()
}

fn table_size(swarm: &mut libp2p::Swarm<Behaviour>) -> usize {
    swarm.behaviour_mut().kad.kbuckets().map(|b| b.num_entries()).sum()
}

/// Pump the swarm until the routing table is worth using, or the deadline passes.
///
/// ⚠️ Returns whether it got there. A publish MUST refuse when it did not; a lookup proceeds
/// anyway, because a thin table still answers sometimes and the alternative is refusing to look.
async fn warm_up(swarm: &mut libp2p::Swarm<Behaviour>, deadline: tokio::time::Instant) -> bool {
    while table_size(swarm) < MIN_TABLE_TO_PUBLISH {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return false,
            _ = swarm.select_next_some() => {}
        }
    }
    true
}

/// Publish the room record, and answer whether it actually reached the network.
///
/// 🔴 `start_providing` returning `Ok` means the LOCAL store accepted the key. It is not publication
/// and it cannot fail for any reason a caller cares about — the first version reported that value as
/// `announced`, so the sidecar said `true` while an outside instrument confirmed the record was
/// absent from the public DHT. What follows waits for the query itself, so `announced` names
/// something that can be false.
///
/// ⚠️ Announcing is only honest from somewhere reachable, and that is still the CALLER's judgement:
/// a NAT'd instance publishing an address nobody can dial costs the commons a useless record. An
/// unreachable instance loses nothing by staying silent, because it dials out and was never going to
/// be found.
async fn announce(swarm: &mut libp2p::Swarm<Behaviour>, addr: &str) -> Reply {
    /*
     * The address the INSTANCE believes peers can knock on, advertised as an external multiaddr so
     * identify carries it to whoever finds us.
     */
    // 🔴 REFUSED when the address cannot become a multiaddr, rather than announced without one.
    //
    // The old code attached the endpoint when it could and announced the room either way, so an
    // impossible address published a provider record naming nobody — and the UI reported a
    // successful publish of a door that cannot be opened (Codex review P3). The parent validates
    // too; this is the half that makes the acknowledgement honest whatever reaches it.
    let Some(ma) = http_multiaddr(addr) else {
        return Reply { announced: Some(false), ..Default::default() };
    };
    swarm.add_external_address(ma);

    let deadline = tokio::time::Instant::now() + ANNOUNCE_BUDGET;

    // Somewhere to publish TO. A table that never fills means no network, and the honest answer to
    // that is `false`, not a hang.
    if !warm_up(swarm, deadline).await {
        return Reply { announced: Some(false), ..Default::default() };
    }

    let Ok(query) = swarm.behaviour_mut().kad.start_providing(room_key()) else {
        return Reply { announced: Some(false), ..Default::default() };
    };

    loop {
        tokio::select! {
            // ⚠️ A timeout is a FAILED announcement, reported as one. The caller's fallbacks — the
            // LAN, peer exchange, a typed address — are what the design leans on anyway.
            _ = tokio::time::sleep_until(deadline) => return Reply { announced: Some(false), ..Default::default() },
            event = swarm.select_next_some() => {
                if let SwarmEvent::Behaviour(BehaviourEvent::Kad(kad::Event::OutboundQueryProgressed {
                    id, result: kad::QueryResult::StartProviding(result), ..
                })) = event {
                    if id == query {
                        return Reply { announced: Some(result.is_ok()), ..Default::default() }
                    }
                }
            }
        }
    }
}

/// Stop being a provider for the room.
///
/// 🔴 **This is the most a Kademlia node can truthfully do, and the caller must not claim more.**
/// There is no unpublish in Kademlia: records already replicated onto other nodes live until their
/// TTL expires. What `stop_providing` does is local and real — this node stops republishing on kad's
/// 12-hour schedule and stops answering as a provider — so the record decays instead of being
/// renewed forever. The honest sentence for a user is "we stop advertising, and the copies out
/// there expire", never "withdrawn".
///
/// ⚠️ Synchronous and unconditional: there is no query to await and nothing that can fail, which is
/// why it answers immediately rather than taking a budget. A user turning the community off is
/// entitled to have that take effect before the process is asked to exit.
fn withdraw(swarm: &mut libp2p::Swarm<Behaviour>) -> Reply {
    swarm.behaviour_mut().kad.stop_providing(&room_key());
    Reply { announced: Some(false), ..Default::default() }
}

/// One bounded discovery: ask who provides the room and keep the `/http` endpoints their records
/// carry.
///
/// 🔴 It does NOT dial the providers. The endpoint arrives INSIDE the provider record, and dialling
/// it as libp2p is impossible by construction — there is no `/http` transport in this swarm. Measured
/// 2026-08-17: the first version dialled each provider and waited for identify to supply the address,
/// which produced `MultiaddrNotSupported` for every provider and an empty answer while the address
/// sat in the very error being discarded. Not dialling is also strictly cheaper and removes any
/// dependence on the provider's libp2p port being reachable, which NovaClaw never promised: it
/// promises HTTP.
///
/// 🔴 It awaits ITS OWN query rather than returning whatever a previous one left behind — the first
/// version did the latter, which meant the first `find` always answered empty and every later one
/// answered stale.
async fn find(swarm: &mut libp2p::Swarm<Behaviour>) -> Reply {
    // A cold query answers nothing: see WARM_UP_BUDGET. Best effort — we look either way.
    warm_up(swarm, tokio::time::Instant::now() + budget("NOVACLAW_DHT_WARMUP_SECS", WARM_UP_BUDGET)).await;

    let query = swarm.behaviour_mut().kad.get_providers(room_key());
    let deadline = tokio::time::Instant::now() + budget("NOVACLAW_DHT_FIND_SECS", FIND_BUDGET);
    let mut providers: HashSet<PeerId> = HashSet::new();
    let mut addresses: Vec<String> = Vec::new();

    loop {
        if addresses.len() >= MAX_PEERS {
            break;
        }
        tokio::select! {
            // ⚠️ The BACKSTOP, not the expected cost. The loop leaves as soon as the query says it
            // is finished, so a budget rise does not become a latency rise.
            _ = tokio::time::sleep_until(deadline) => break,
            event = swarm.select_next_some() => {
                /*
                 * ⚠️ A field diagnostic, on STDERR, off unless `NOVACLAW_DHT_DEBUG` is set. The parent
                 * ignores stderr, so this can never corrupt the JSON-lines protocol. A discovery that
                 * finds nobody is otherwise indistinguishable from one that found peers carrying no
                 * usable address — a distinction that cost a whole investigation to make once.
                 */
                if debug_enabled() {
                    eprintln!("[dht] {event:?}");
                }
                if let SwarmEvent::Behaviour(BehaviourEvent::Kad(kad::Event::OutboundQueryProgressed {
                    id, result: kad::QueryResult::GetProviders(result), ..
                })) = event
                {
                    if id == query {
                        if let Ok(kad::GetProvidersOk::FoundProviders { providers: peers, .. }) = result {
                            for peer in peers {
                                if providers.insert(peer) {
                                    for addr in endpoints_of(swarm, peer) {
                                        if !addresses.contains(&addr) {
                                            addresses.push(addr);
                                        }
                                    }
                                }
                            }
                        }
                        /*
                         * 🔴 STOP once we have somewhere to knock — NOT on `step.last`.
                         *
                         * `step.last` looked like the principled condition and measured 0/3 against
                         * 6/6 without it: it fires at ~12.8 s, before the network's providers arrive,
                         * so honouring it ended every lookup just early enough to find nobody. What
                         * the spec actually relies on is weaker and true: *one reachable instance is
                         * a complete entry point, because peer exchange supplies everyone else.*
                         *
                         * So a hit leaves immediately and a miss pays the full budget, which is the
                         * right way round: the budget bounds the bad case and never prices the good
                         * one.
                         */
                        if !addresses.is_empty() {
                            break;
                        }
                    }
                }
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

    #[test]
    fn build_identity_has_an_explicit_development_fallback() {
        assert!(!BUILD_PROTOCOL.is_empty());
        assert!(!BUILD_VERSION.is_empty());
        assert!(!BUILD_SOURCE.is_empty());
        assert!(!std::env::consts::OS.is_empty());
        assert!(!std::env::consts::ARCH.is_empty());
    }

    /// The room key is derived, not configured — every instance computes the same one without
    /// coordinating, which is what makes a constant room work at all.
    /// 🔴 The key is pinned to BYTES computed outside this program, not to itself.
    ///
    /// ⚠️ The test this replaces asserted `len() == 32` — which is exactly what the defect produced,
    /// so it passed for as long as the sidecar was wrong and would have failed on the fix. A key
    /// compared only against itself agrees with itself in any room, including one nobody else can
    /// name; the only assertion worth making here is against a value derived independently
    /// (`sha2-256` multihash of the room string, the same bytes a CID carries).
    #[test]
    fn the_room_key_is_the_multihash_every_other_implementation_uses() {
        let expected =
            hex_bytes("1220b870bd7d2d1220267743739dfa2a11aab2d12da887138eeffae2ca12a6fbe974");
        assert_eq!(room_key().as_ref(), expected.as_slice());
        // 32 bytes of digest behind a 2-byte `sha2-256` prefix.
        assert_eq!(room_key().as_ref().len(), 34);
        assert_eq!(&room_key().as_ref()[..2], &[0x12, 0x20]);
    }

    fn hex_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("valid hex"))
            .collect()
    }
}
