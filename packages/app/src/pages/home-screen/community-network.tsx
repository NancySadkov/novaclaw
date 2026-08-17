import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { For, Show, createEffect, createMemo, createResource, createSignal, type Component } from "solid-js"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useGlobal } from "@/context/global"
import { useServerSync } from "@/context/server-sync"
import { useServer } from "@/context/server"
import {
  communityAddContact,
  communityChannelHistory,
  communityChannelSync,
  communityChannels,
  communityArchivedChannels,
  communityDiscover,
  communityDoorman,
  communityOffers,
  communityParticipation,
  communitySetParticipation,
  communityFilters,
  communityAddFilter,
  communityRemoveFilter,
  communityMyOffer,
  communityPublishOffer,
  communityWithdrawOffer,
  communityConversations,
  communityDirectHistory,
  communitySendDirect,
  communityListChannel,
  communityNearbyChannels,
  communityContacts,
  communityJoinChannel,
  communityLeaveChannel,
  communityMuteChannel,
  communityPost,
  communityForgetContact,
  communitySetBlocked,
  communityTransportState,
} from "@/utils/community-api"
import { instanceIdentity } from "@/utils/identity-api"

/**
 * The instance-hosted community — `todo/community-p2p.md`.
 *
 * 🔴 Shown ALONGSIDE the Discord/Reddit links rather than replacing them. This said "a transport
 * does not exist" and named its own exit condition — "when a message can arrive, this becomes the
 * panel and the links move below it". Messages arrive now, so the condition is MET and the layout
 * question is live rather than settled: it is the owner's call, not something to change quietly
 * under cover of a comment fix.
 *
 * ⚠️ The argument for waiting is unchanged and is about population, not capability: swapping links
 * that reach real people for a room whose occupants are whoever else has joined would be a
 * regression the day it shipped, however well the transport works.
 *
 * It is honest about the state rather than pretending to connect — *"the UI never crashes to a
 * dead-end"* means degrading with a calm explanation, not hiding the fact that nobody may be there.
 */

const DEFAULT_CHANNEL = "#NovaClaw"

export const CommunityNetwork: Component = () => {
  const server = useServer()
  const global = useGlobal()
  const connection = createMemo(() => server.current ?? global.servers.list()[0])
  const dialog = useDialog()
  const sync = useServerSync()
  /**
   * The probe the add-model dialog runs needs a directory to resolve config against, and the scratch
   * cwd is the one always available on this screen.
   *
   * ⚠️ Resolved exactly as `new-agent-bar.tsx` does — the ctx sync preferred, the top-level sync as
   * fallback — so a not-yet-warm ctx never yields an undefined path. A second way of finding the same
   * value would drift from that one.
   */
  const serverCtx = createMemo(() => {
    const current = server.current
    return current ? global.ensureServerCtx(current) : undefined
  })
  const activeSync = () => serverCtx()?.sync ?? sync()
  const scratchDir = createMemo(() => (activeSync().data.path as { scratchDir?: string } | undefined)?.scratchDir)

  const [identity] = createResource(connection, (value) => instanceIdentity(value.http))
  const [contacts, contactActions] = createResource(connection, (value) => communityContacts(value.http))
  const [channels, channelActions] = createResource(connection, (value) => communityChannels(value.http))
  /**
   * Channels the user left, whose messages this instance still holds.
   *
   * 🔴 Principle 12: leaving keeps the history on purpose, and without this the only route back to
   * it is retyping the name exactly — a value the user has no way to know, for a room sitting on
   * their own disk. Discovering channels never seen before is a different problem and needs the
   * network; this is the half already here.
   */
  const [archived, archivedActions] = createResource(connection, (value) =>
    communityArchivedChannels(value.http),
  )
  /**
   * Channels the instances we can reach advertise — ONE HOP, and the copy says so.
   *
   * ⚠️ Only what each peer CHOSE to disclose. Being in a room is not public: the sync endpoints
   * answer an unknown topic exactly like an empty one so nobody can map an instance's rooms, and
   * this must not undo that through another door.
   */
  const [nearby, nearbyActions] = createResource(connection, (value) => communityNearbyChannels(value.http))

  /**
   * 1:1 chat.
   *
   * ⚠️ A DM is a different thing from a channel post and the UI must not blur them: a channel is a
   * public broadcast anyone in the room stores, while this is sealed to one person's key and cannot
   * be read by whoever carries it. The copy says exactly that much and no more — "only they can read
   * it" is true; "untraceable" would not be, because who talked to whom is visible to anyone watching
   * the connection.
   */
  const [talkingTo, setTalkingTo] = createSignal("")
  const [conversations, conversationActions] = createResource(connection, (value) =>
    communityConversations(value.http),
  )
  const [dms, dmActions] = createResource(
    () => {
      const value = connection()
      const peer = talkingTo()
      return value === undefined || peer === "" ? undefined : ([value, peer] as const)
    },
    ([value, peer]) => communityDirectHistory(value.http, peer),
  )
  /**
   * Model servers people offer each other — the owner's motivation for the whole thing: "users may
   * offer their model servers for free or for btc".
   *
   * ⚠️ An offer is a CLAIM, not a promise, and the copy has to say so. The signature proves who wrote
   * it and that the endpoint was not rewritten in transit; it says nothing about whether the server
   * exists, serves what it says, or will still be there in an hour. Those are separate questions and
   * nothing here answers them.
   */
  const [offers, offerActions] = createResource(connection, (value) => communityOffers(value.http))
  /**
   * 🔴 What the USER is currently offering. Found missing by publishing one and watching the panel
   * not change: `offers` lists what PEERS advertise and deliberately excludes our own, so a user
   * could offer their machine and see no evidence of it anywhere — no way to know what they were
   * advertising, or that it was still live. Principle 12(d): say what is in force, before the control.
   */
  /**
   * 🔴 Asked BEFORE anything else is rendered: this instance may not have joined the community at
   * all, and a fresh install has not. Three not-participating states look identical from outside and
   * must not be shown the same way — never asked deserves the warning, switched-off deserves a
   * switch, and airgapped deserves neither, because flipping a community setting would not change it.
   */
  const [participation, participationActions] = createResource(connection, (value) =>
    communityParticipation(value.http),
  )
  const [switching, setSwitching] = createSignal(false)
  const [publishing, setPublishing] = createSignal("")

  const setParticipation = async (value: {
    consented?: boolean
    enabled?: boolean
    answers?: { enabled?: boolean; perDay?: number }
    announce?: string
  }) => {
    const current = connection()
    if (!current) return
    setSwitching(true)
    try {
      await communitySetParticipation(current.http, value)
      await participationActions.refetch()
    } finally {
      setSwitching(false)
    }
  }

  const [myOffer, myOfferActions] = createResource(connection, (value) => communityMyOffer(value.http))
  const [offerEndpoint, setOfferEndpoint] = createSignal("")
  const [offerModels, setOfferModels] = createSignal("")
  const [offerPrice, setOfferPrice] = createSignal("")
  const [offerPayTo, setOfferPayTo] = createSignal("")
  const [offerNote, setOfferNote] = createSignal("")

  /**
   * Accept somebody's offer — ONE CLICK, and not zero.
   *
   * 🔴 Opens the existing add-model dialog with the address filled in, rather than writing config
   * here. That dialog PROBES the endpoint before saving, which checks the server exists and lists
   * models — the one thing a signature on an offer cannot tell you. Writing config from this panel
   * would be a second door carrying a subset of those rules.
   *
   * ⚠️ Decisions §4 sets the standard: "the vision's headline repair is ONE CLICK, NOT ZERO … instead
   * of silently re-pointing where the user's prompts go while nobody watches." So this prefills and
   * hands over; the person still sees the address and presses save.
   */
  const useOffer = (endpoint: string) => {
    const current = connection()
    const directory = scratchDir()
    if (!current || !directory) {
      setOfferNote("Open a project first — the check that this endpoint works runs against one.")
      return
    }
    void import("@/components/settings-v2/dialog-new-model").then((module) => {
      dialog.show(() => (
        <module.DialogNewModel http={current.http} directory={directory} initialEndpoint={endpoint} />
      ))
    })
  }

  const publishOffer = async () => {
    const current = connection()
    const endpoint = offerEndpoint().trim()
    if (!current || !endpoint) return
    setOfferNote("")
    try {
      await communityPublishOffer(current.http, {
        endpoint,
        // Comma-separated because a user typing model names should not have to learn a syntax.
        models: offerModels()
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== ""),
        // ⚠️ Their words, kept as written. Not parsed into an amount — this software settles nothing.
        price: offerPrice().trim() === "" ? "free" : offerPrice().trim(),
        payTo: offerPayTo().trim(),
      })
      setOfferNote("Offered. Peers see it next time they look.")
      await Promise.all([offerActions.refetch(), myOfferActions.refetch()])
    } catch (error) {
      setOfferNote(error instanceof Error ? error.message : String(error))
    }
  }

  const withdrawOffer = async () => {
    const current = connection()
    if (!current) return
    await communityWithdrawOffer(current.http)
    setOfferNote("Withdrawn. Peers that already copied it keep theirs until they look again.")
    await Promise.all([offerActions.refetch(), myOfferActions.refetch()])
  }

  /**
   * Words the user has chosen not to read — the second of the two powers a user has here, the first
   * being blocking a person.
   *
   * 🔴 The rules are theirs and only theirs. §10: a filter computed from instructions found in a
   * channel would let the spammer write the filter that judges them, which is why the agent-facing
   * tool cannot reach these in either direction — not to write one, and not to read which words to
   * avoid.
   */
  const [filters, filterActions] = createResource(connection, (value) => communityFilters(value.http))
  const [filterDraft, setFilterDraft] = createSignal("")

  const addFilter = async () => {
    const current = connection()
    const pattern = filterDraft().trim()
    if (!current || !pattern) return
    await communityAddFilter(current.http, pattern)
    setFilterDraft("")
    await Promise.all([filterActions.refetch(), historyActions.refetch()])
  }

  const removeFilter = async (pattern: string) => {
    const current = connection()
    if (!current) return
    await communityRemoveFilter(current.http, pattern)
    await Promise.all([filterActions.refetch(), historyActions.refetch()])
  }

  const [dmDraft, setDmDraft] = createSignal("")
  const [dmNote, setDmNote] = createSignal("")

  const sendDirect = async () => {
    const current = connection()
    const peer = talkingTo()
    const body = dmDraft().trim()
    if (!current || peer === "" || !body) return
    setDmNote("")
    try {
      const result = await communitySendDirect(current.http, peer, body)
      setDmDraft("")
      // ⚠️ Says which of the two happened, like the channel compose box. The message is kept either
      // way — a send that could not reach them must not also lose what the user wrote.
      setDmNote(
        result.sent
          ? "Delivered."
          : result.reason === "no-route"
            ? "Saved. You have no address for them yet — find them first, or ask them for one."
            : "Saved to your copy. They could not be reached just now.",
      )
      await Promise.all([dmActions.refetch(), conversationActions.refetch()])
    } catch (error) {
      setDmNote(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Which channel is on screen.
   *
   * ⚠️ A signal that may be empty, resolved against the JOINED list rather than trusted. A selection
   * can outlive its channel — leaving the one you are reading is the obvious way — and a screen
   * pinned to a channel this instance no longer subscribes to would sit there asking for history it
   * will never be sent.
   */
  const [selected, setSelected] = createSignal("")
  const channel = createMemo(() => {
    const joined = channels() ?? []
    const wanted = selected()
    if (wanted !== "" && joined.some((entry) => entry.name === wanted)) return wanted
    return joined[0]?.name ?? DEFAULT_CHANNEL
  })

  const [history, historyActions] = createResource(
    () => {
      const value = connection()
      return value === undefined ? undefined : ([value, channel()] as const)
    },
    ([value, name]) => communityChannelHistory(value.http, name),
  )
  /**
   * How many the PAGE read — not how many survived the user's filters.
   *
   * 🔴 The first version of the line below counted `messages.length`, which is the count AFTER
   * filtering, so a rule matching everything produced "Showing the most recent 0 of 260" — blaming
   * the page for what a filter did, next to a `hidden` line saying the opposite. Two sentences about
   * the same absence, disagreeing. The page read 200 either way; what happened to them afterwards is
   * the other line's job.
   */
  const pageRead = createMemo(() => (history()?.messages.length ?? 0) + (history()?.hidden ?? 0))

  /**
   * 🔴 Catch up on what the channel held before we got here.
   *
   * Gossip only reaches whoever is online, so without this a channel opened on a fresh instance shows
   * only what arrives from this second onward — measured on two real instances as 601 messages on one
   * side and 1 on the other. `sync.sync` existed and was tested from the day it was written; nothing
   * in a running instance had ever called it.
   *
   * ⚠️ On opening a channel rather than on a timer: catch-up costs a round trip per peer, and paying
   * that for channels nobody is reading is exactly the kind of ambient cost this subsystem bounds
   * everywhere else. Opening the channel is the moment the history is about to be read.
   *
   * ⚠️ Deliberately not awaited before rendering. The local log draws immediately and the fetched
   * messages appear when they land, so a slow or unreachable peer costs freshness and never the view.
   */
  createEffect(() => {
    const value = connection()
    const name = channel()
    if (value === undefined) return
    void communityChannelSync(value.http, name)
      .then((result) => {
        if (result.fetched > 0) historyActions.refetch()
      })
      .catch(() => {
        // A failed catch-up is not an error the user needs: the local log is already on screen.
      })
  })

  const [transport] = createResource(connection, (value) => communityTransportState(value.http))

  /**
   * ⚠️ Read from the instance, never asserted here. This copy used to say "still being built"
   * unconditionally, which would have LIED to anyone who turned airgap on — telling them a feature
   * was unfinished when in fact they had switched the network off themselves.
   */
  /**
   * The connection state, in one line, ALWAYS on screen.
   *
   * 🔴 It used to live only in the empty-channel copy, which meant it vanished the moment a channel
   * had any messages — exactly when "why is nothing new arriving?" becomes the question. A status a
   * user can only see while there is nothing to see is not a status.
   */
  const status = createMemo(() => {
    const state = transport()
    if (state === undefined) return "Checking…"
    if (state.kind === "online") return `Connected · ${state.peers} ${state.peers === 1 ? "peer" : "peers"}`
    if (state.kind === "connecting") return "Connecting…"
    if (state.reason === "airgap") return "Offline mode is on — nothing goes in or out"
    // ⚠️ Three different sentences, because they are three different situations for the person
    // reading them: one they chose (airgap), one they have not yet accepted (never joined), and one
    // they can fix in the next minute (nobody to dial).
    return "Ready — add someone with an address to reach anybody"
  })

  /**
   * Who said this, in words.
   *
   * 🔴 The channel used to print the raw `nid_…` key on every message. A wall of base64 is exactly
   * the unreadability this product rejects — and it matters more here than in the contact list,
   * because messages are what people actually read.
   *
   * ⚠️ Falls back to a SHORTENED key, never the full 47 characters: an unknown author is the common
   * case in an open channel, and the full string swamps the message it belongs to.
   */
  const nameFor = createMemo(() => {
    const byKey = new Map<string, string | undefined>()
    for (const contact of contacts() ?? []) {
      byKey.set(contact.networkID, contact.petname)
      // 🔴 Every key they ever held maps to the SAME name. A message carries whichever key signed
      // it, so without this a contact's whole history goes anonymous the moment they rotate — and
      // the older the message, the more likely that is.
      for (const former of contact.formerIDs ?? []) byKey.set(former, contact.petname)
    }
    return (author: string) => {
      const petname = byKey.get(author)
      if (petname) return petname
      // A stranger, or a contact with no petname: their key, shortened. Never a guess at who they
      // might be — attributing a message to the wrong person is the one failure worth avoiding here.
      return author.startsWith("nid_") ? `${author.slice(0, 12)}…` : author
    }
  })

  const emptyReason = createMemo(() => {
    const state = transport()
    if (state?.kind === "online") return "No messages yet."
    if (state?.kind === "off" && state.reason === "airgap")
      return "Offline mode is on, so nothing goes in or out. Your key and contacts are saved; turn it off in Settings to reach people."
    return "Nothing here yet — the piece that carries messages between instances is still being built. Your key and your contacts are already saved, and this fills in when it lands."
  })

  const [draft, setDraft] = createSignal("")
  const [sendNote, setSendNote] = createSignal("")
  const [adding, setAdding] = createSignal("")
  const [addingName, setAddingName] = createSignal("")
  const [problem, setProblem] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const add = async () => {
    const current = connection()
    const key = adding().trim()
    if (!current || !key) return
    setBusy(true)
    setProblem("")
    try {
      await communityAddContact(current.http, {
        networkID: key,
        ...(addingName().trim() === "" ? {} : { petname: addingName().trim() }),
      })
      // Joining the default channel here rather than at boot: a user who has added nobody has no
      // network to be in, and subscribing to a topic they cannot reach teaches them nothing.
      await communityJoinChannel(current.http, DEFAULT_CHANNEL)
      setAdding("")
      setAddingName("")
      await contactActions.refetch()
    } catch (error) {
      // The instance's own words — it knows why a key was refused; this screen must not guess.
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const forget = async (networkID: string) => {
    const current = connection()
    if (!current) return
    await communityForgetContact(current.http, networkID)
    await contactActions.refetch()
  }

  const toggleBlock = async (networkID: string, blocked: boolean) => {
    const current = connection()
    if (!current) return
    await communitySetBlocked(current.http, networkID, blocked)
    await contactActions.refetch()
  }

  const [joining, setJoining] = createSignal("")
  const [finding, setFinding] = createSignal(false)
  const [found, setFound] = createSignal("")

  /**
   * 🔴 Bootstrap, as one button. Looks for instances on this network, then asks everyone reachable
   * who else they know — so a single address, from any source, reaches a network nobody can switch
   * off. There is no seed list here to seize.
   */
  const find = async () => {
    const current = connection()
    if (!current) return
    setFinding(true)
    setFound("")
    try {
      // ⚠️ The address box doubles as the input: an address is enough, because the instance there
      // tells us its own key. Asking a person to type 47 characters of base64 is the thing
      // principle 12 exists to forbid.
      const typed = adding().trim()
      const result = await communityDiscover(current.http, typed === "" ? undefined : [typed])
      /**
       * 🔴 "Found nobody" has to name WHY, because two very different situations produce it.
       *
       * An empty seed zone gives no starting addresses at all — nothing to dial, and pasting an
       * address is the fix. A zone that answered with hosts that are all dead is a different
       * problem, and telling somebody to paste an address they may not have would be sending them
       * to fix the wrong thing.
       *
       * ⚠️ The transport records the same rule one file over: *"we know nobody to dial" is a
       * different sentence to a person than "this is not built yet", and it is one they can fix in a
       * minute.*
       */
      setFound(
        result.peers > 0
          ? `${result.peers} ${result.peers === 1 ? "instance" : "instances"} reachable` +
              (result.learned > 0 ? ` — ${result.learned} newly discovered` : "")
          : !result.seedsAsked
            ? "Found nobody on this network. Starting addresses are turned off, so paste someone's address above to reach the wider network."
            : result.seedsFound === 0
              ? "Found nobody on this network, and no starting addresses were published. Paste someone's address above — one is enough to reach everyone they know."
              : `Found nobody yet: ${result.seedsFound} starting ${result.seedsFound === 1 ? "address" : "addresses"} were tried and none answered. Paste someone's address above if you have one.`,
      )
      await Promise.all([contactActions.refetch(), nearbyActions.refetch()])
    } catch (error) {
      setFound(error instanceof Error ? error.message : String(error))
    } finally {
      setFinding(false)
    }
  }

  /**
   * 🔴 Naming a DOORMAN — an address you were given, and how far you trust whoever answers.
   *
   * Joining needs none of this: the button above finds instances on the LAN, through the seed
   * records and by peer exchange, with nobody's permission. This is the other path, and AGENTS.md
   * says when it matters — not at the door, but once TRANSACTIONS do. It is also what keeps the
   * seeds a convenience: when every default door is shut, this one still opens.
   *
   * ⚠️ The rating is the USER's sentence and nothing else may write it. It is deliberately a
   * coarse 1..5 rather than a percentage: only its ORDER is ever read, and a finer scale would
   * promise a precision nobody has about a stranger.
   */
  /**
   * 🔴 Which contact is being RE-RATED, if any.
   *
   * A rating was write-once until now: mis-click a 2 for a 5 and the only way back was to re-enter
   * the address. These ratings are the ladder, so a person has to be able to correct one about
   * somebody they already know — including peers they met through exchange and never typed an
   * address for.
   */
  const [rating, setRating] = createSignal<string | undefined>(undefined)

  const rate = async (networkID: string, level: number) => {
    const current = connection()
    if (!current) return
    // `add` UPDATES an existing contact, so re-rating needs no second endpoint. Omitting `trust`
    // elsewhere leaves an existing rating alone, which is why this is safe to reuse.
    await communityAddContact(current.http, { networkID, trust: level })
    setRating(undefined)
    await contactActions.refetch()
  }

  const [trust, setTrust] = createSignal(0)
  const [doormanNote, setDoormanNote] = createSignal("")
  const [naming, setNaming] = createSignal(false)

  const nameDoorman = async () => {
    const current = connection()
    const address = adding().trim()
    if (!current || address === "" || trust() === 0) return
    setNaming(true)
    setDoormanNote("")
    try {
      const named = adding().trim()
      const petname = addingName().trim()
      const result = await communityDoorman(current.http, {
        address: named,
        trust: trust(),
        ...(petname === "" ? {} : { petname }),
      })
      setDoormanNote(
        result.found
          ? `Added as a doorman you trust ${trust()} of 5.`
          : // ⚠️ Nothing answered, so there is nobody to trust. A rating is a statement about a
            // PERSON, and recording it against an address that answers nothing would attach the
            // user's sentence to whoever is given that address next.
            "Nothing answered there, so nobody was added. Check the address and try again.",
      )
      if (result.found) {
        setAdding("")
        setAddingName("")
        setTrust(0)
        await Promise.all([contactActions.refetch(), nearbyActions.refetch()])
      }
    } catch (error) {
      setDoormanNote(error instanceof Error ? error.message : String(error))
    } finally {
      setNaming(false)
    }
  }

  const join = async () => {
    const current = connection()
    const name = joining().trim()
    if (!current || !name) return
    setProblem("")
    try {
      // ⚠️ Sent as TYPED. The store canonicalises (case, a leading `#`) when it hashes the name to a
      // topic, so normalising here as well would be a second implementation of that rule — and the
      // two would eventually disagree about which room a user is in.
      await communityJoinChannel(current.http, name)
      setJoining("")
      await Promise.all([channelActions.refetch(), archivedActions.refetch(), nearbyActions.refetch()])
      setSelected(name)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }

  /** Rejoin a room we already hold messages for — the same door as `join`, without the typing. */
  const rejoin = async (name: string) => {
    const current = connection()
    if (!current) return
    await communityJoinChannel(current.http, name)
    await Promise.all([channelActions.refetch(), archivedActions.refetch()])
    setSelected(name)
  }

  const leave = async (name: string) => {
    const current = connection()
    if (!current) return
    await communityLeaveChannel(current.http, name)
    // The selection is resolved against the joined list, so dropping the channel being read falls
    // back to whatever remains rather than leaving the screen pointed at nothing.
    await Promise.all([channelActions.refetch(), archivedActions.refetch(), historyActions.refetch()])
  }

  const setListed = async (name: string, listed: boolean) => {
    const current = connection()
    if (!current) return
    await communityListChannel(current.http, name, listed)
    await channelActions.refetch()
  }

  const mute = async (name: string, muted: boolean) => {
    const current = connection()
    if (!current) return
    await communityMuteChannel(current.http, name, muted)
    await channelActions.refetch()
  }

  const say = async () => {
    const current = connection()
    const body = draft().trim()
    if (!current || !body) return
    setSendNote("")
    try {
      await communityJoinChannel(current.http, channel())
      const result = await communityPost(current.http, channel(), body)
      setDraft("")
      /**
       * ⚠️ Says which of the two things happened. "Sent" would be a lie while nothing can carry it,
       * and silence would leave the user unsure whether their words went anywhere at all.
       *
       * 🔴 The second line used to end "until the network part lands" — written when there was no
       * transport, and left in place after one shipped. It told a user whose only problem was having
       * no peers yet that the FEATURE did not exist, which is a reason to stop trying rather than to
       * go and find someone. The message is retained and served to any peer that syncs later, so the
       * honest sentence is about reachability, not about what is built.
       */
      setSendNote(
        result.delivered
          ? "Sent."
          : "Saved to your own copy — no peer was reachable just now, so it will go out when one is.",
      )
      await historyActions.refetch()
    } catch (error) {
      setSendNote(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * 🔴 The door. Nothing below renders until this instance has joined, because joining is a decision
   * with consequences the person has to see FIRST — and because the module genuinely is not running
   * until they make it.
   *
   * ⚠️ The warning is shown only for `never_consented`. Somebody who accepted it and later switched
   * the module off gets a switch, not the warning again: consent is sticky, and re-asking would be
   * nagging dressed as care.
   */
  const refusals = () => participation()?.refusals ?? []
  const neverAsked = () => refusals().includes("never_consented")
  const switchedOff = () => refusals().includes("switched_off")

  /**
   * ⚠️ A `<Show>`, NOT an early `return` from the component body — and that distinction is the whole
   * bug this replaced. A Solid component body runs ONCE: at that moment the participation resource
   * is still pending, so an early return computed `undefined` and rendered the joined panel forever,
   * to a user who had never joined. The types were fine and the logic read correctly; only opening
   * the page showed it.
   */
  const notJoined = () => (

      <section class="flex flex-col gap-3" data-slot="community-network">
        <div class="flex flex-col gap-1">
          <span class="text-sm font-medium text-v2-text-text-base">Your own community</span>
          <Show when={neverAsked()}>
            <span class="text-[12px] leading-snug text-v2-text-text-muted">
              NovaClaw instances can talk to each other directly — yours and other people's. It is off until you
              turn it on, and there are three things to know first.
            </span>
            {/* Stated plainly and without euphemism. Both are consequences of the architecture, not
                defects in it, and a person cannot consent to what they were not told. */}
            <ul class="mt-2 flex flex-col gap-2">
              <li class="text-[12px] leading-snug text-v2-text-text-base">
                <b>Nobody moderates this.</b> There is no company in the middle, which also means there is no one
                to delete what a stranger writes or to appeal to. You may see things you find offensive or
                upsetting. You can block people, and that is the only power anyone has here.
              </li>
              <li class="text-[12px] leading-snug text-v2-text-text-base">
                <b>Other people will see your IP address.</b> Because there is no central server, your machine
                connects directly to theirs — so anyone you talk to learns roughly where you are, in the way any
                direct connection reveals.
              </li>
              {/* 🔴 The THIRD thing, added when the DHT shipped, and it is a different sentence from
                  the one above it. "The people you speak to know where you are" is the cost of a direct
                  connection; "this software's users are a public list" is the cost of a public directory,
                  and somebody in a country where the second one is dangerous deserves the second one.

                  ⚠️ The screen exists to state the architecture's costs, not to make them sound
                  smaller. This is accepted as the price of a network nobody owns — the alternative is a
                  server that knows who is online — and it is not a separate switch, because an instance
                  nobody can find is an instance nobody can reach. */}
              <li class="text-[12px] leading-snug text-v2-text-text-base">
                <b>Being findable is public.</b> Instances announce themselves in a shared public directory so
                strangers can find each other without anyone running a server. That means it is possible for
                someone to list machines running NovaClaw without ever talking to them. There is no version of
                this that is both serverless and private about who is here.
              </li>
              {/* 🔴 The FOURTH thing, and the only one that is about the user's own machine rather
                  than about what leaves it. §5(k) of the honesty ledger requires this disclosure "by
                  the time any of this ships", and the store, the agent's operations and the automatic
                  recording of every question asked have all shipped.

                  ⚠️ It says AI-WRITTEN, and it should: a file of judgements about named people,
                  composed by a model, is a different thing to a log of what happened, and somebody
                  deciding whether to join deserves the first description rather than the second. The
                  last sentence is a promise the code now keeps — `forget` deletes the notes with the
                  contact, which it did not until it was checked. */}
              <li class="text-[12px] leading-snug text-v2-text-text-base">
                <b>Your instance keeps notes about people.</b> When it deals with someone — asks them
                something, is answered or refused — it records how that went, in its own words, so it can
                judge who is worth listening to later. The notes are written by the AI, they are about
                identifiable people, and they stay on this machine: nothing is published or shared. Forgetting
                someone deletes theirs.
              </li>
            </ul>
            <span class="mt-2 text-[11px] leading-snug text-v2-text-text-muted">
              You can turn it off again at any time, here in Community settings.
            </span>
            <div class="mt-2 flex items-center gap-2">
              <ButtonV2
                appearance="base"
                disabled={switching()}
                onClick={() => void setParticipation({ consented: true })}
              >
                I understand — turn it on
              </ButtonV2>
            </div>
          </Show>

          <Show when={switchedOff()}>
            <span class="text-[12px] leading-snug text-v2-text-text-muted">
              Community is turned off. Nothing goes in or out, and other instances cannot reach yours.
            </span>
            <div class="mt-2 flex items-center gap-2">
              <ButtonV2 appearance="base" disabled={switching()} onClick={() => void setParticipation({ enabled: true })}>
                Turn it back on
              </ButtonV2>
            </div>
          </Show>

          <Show when={refusals().includes("airgap")}>
            {/* ⚠️ No community control offered: the airgap is a machine-level decision that overrides
                this one, so a switch here would do nothing and reading it as broken would be fair. */}
            <span class="text-[12px] leading-snug text-v2-text-text-muted">
              Offline mode is on, so the community is off regardless of this setting. Turn off offline mode in
              Settings to use it.
            </span>
          </Show>
        </div>
      </section>
  )

  return (
    <Show when={participation() === undefined || participation()?.participating} fallback={notJoined()}>
    <section class="flex flex-col gap-3" data-slot="community-network">
      <div class="flex flex-col gap-1">
        <span class="text-sm font-medium text-v2-text-text-base">Your own community</span>
        <span class="text-[12px] leading-snug text-v2-text-text-muted">
          {/* ⚠️ Says "nobody ELSE". The line read "nobody who can switch it off" until a Turn off
              button appeared two elements below it — a promise the screen itself contradicted. The
              claim worth making is about who CANNOT: no company, no operator, no one but the person
              reading this. */}
          Runs between NovaClaw instances — no company in the middle, and nobody but you who can switch it
          off.
        </span>
        <div class="mt-1 flex items-center gap-2">
          {/* A dot, not a warning triangle: not being connected yet is the ORDINARY state of a fresh
              install, and dressing it as an error would teach people to distrust a working screen. */}
          <span
            class="size-1.5 shrink-0 rounded-full"
            classList={{
              "bg-v2-text-text-muted": transport()?.kind !== "online",
              "bg-emerald-400": transport()?.kind === "online",
            }}
          />
          <span class="text-[11px] text-v2-text-text-muted">{status()}</span>
          {/* 🔴 The way back out, beside the state it turns off rather than buried in a settings
              page: a person who joined and then wants to stop should not have to find where. Consent
              is NOT withdrawn by this — turning it off is reversible without being warned again. */}
          <ButtonV2
            appearance="ghost"
            class="ml-auto text-[11px]"
            disabled={switching()}
            onClick={() => void setParticipation({ enabled: false })}
          >
            Turn off
          </ButtonV2>
        </div>
      </div>

      <div class="flex flex-col gap-1 rounded-xl bg-v2-background-bg-layer-02 px-3 py-3">
        <span class="text-[12px] font-medium text-v2-text-text-base">Your key</span>
        {/* Selectable, because the only thing a user does with this is hand it to someone. */}
        <span class="select-text break-all font-mono text-[11px] text-v2-text-text-muted">
          {identity()?.networkID ?? "…"}
        </span>
        <span class="text-[11px] leading-snug text-v2-text-text-muted">
          Share it so someone can add you. The address behind it can change; this cannot.
        </span>
      </div>

      <div class="flex flex-col gap-2">
        <span class="text-[12px] font-medium text-v2-text-text-base">
          People you know ({contacts()?.length ?? 0})
        </span>
        <Show
          when={(contacts()?.length ?? 0) > 0}
          fallback={
            <span class="text-[11px] leading-snug text-v2-text-text-muted">
              Nobody yet. Paste someone's key below — one person is enough to reach everyone they know.
            </span>
          }
        >
          <For each={contacts() ?? []}>
            {(contact) => (
              <div class="flex items-center justify-between gap-2 rounded-lg bg-v2-background-bg-layer-02 px-3 py-2">
                <span class="min-w-0 truncate text-[12px] text-v2-text-text-base">
                  {contact.petname ?? contact.networkID}
                </span>
                <div class="flex shrink-0 items-center gap-2">
                  {/* 🔴 The user's own rating, shown back to them — it was write-only until now.
                      A declaration you cannot see is one you cannot check, and these ratings are the
                      ladder: which of these people this instance weighs a stranger's word by. */}
                  <Show
                    when={rating() === contact.networkID}
                    fallback={
                      <ButtonV2 variant="ghost" size="small" onClick={() => setRating(contact.networkID)}>
                        {contact.trust === undefined ? "Rate trust" : `trusted ${contact.trust}/5`}
                      </ButtonV2>
                    }
                  >
                    {/* ⚠️ The same 1..5 the doorman row uses. One scale, one meaning — a second
                        control with a different range would be a second answer to "how far". */}
                    <For each={[1, 2, 3, 4, 5]}>
                      {(level) => (
                        <ButtonV2
                          variant={contact.trust === level ? "neutral" : "ghost"}
                          size="small"
                          onClick={() => void rate(contact.networkID, level)}
                        >
                          {level}
                        </ButtonV2>
                      )}
                    </For>
                  </Show>
                  <span class="text-[11px] text-v2-text-text-muted">
                    {contact.blocked ? "blocked" : contact.routes.length > 0 ? "known address" : "no address yet"}
                  </span>
                  {/* ⚠️ Starting a conversation belongs HERE, on the person. The DM list can only show
                      conversations that already exist, so without this the feature is reachable only
                      by someone who has already been written to — which is nobody, on a fresh
                      install. */}
                  <Show when={!contact.blocked}>
                    <ButtonV2 variant="ghost" size="small" onClick={() => setTalkingTo(contact.networkID)}>
                      Message
                    </ButtonV2>
                  </Show>
                  {/* The only power a user has here, so it belongs on the row rather than behind a
                      menu — and it acts at ingress, not as a display filter. */}
                  <ButtonV2
                    variant="ghost"
                    size="small"
                    onClick={() => void toggleBlock(contact.networkID, !contact.blocked)}
                  >
                    {contact.blocked ? "Unblock" : "Block"}
                  </ButtonV2>
                  {/* A wrong key pasted once must not be permanent — with no registry there is no
                      support desk to undo it for you. */}
                  <ButtonV2 variant="ghost" size="small" onClick={() => void forget(contact.networkID)}>
                    Forget
                  </ButtonV2>
                </div>
              </div>
            )}
          </For>
        </Show>
        {/*
          🔴 Say what blocking DOES, shown only once somebody is blocked so it is never ambient noise.
          Both halves are things a user gets wrong, and the second is the one that surprises people:

          · it drops their messages at ARRIVAL, so unblocking cannot bring back what was refused —
            the right way round, and the reason it is not a display filter;
          · it does NOT hide this instance from them. Their address stays usable and this instance
            may still ask theirs for public room history. The IP a direct connection reveals is the
            cost accepted when JOINING (AGENTS.md), not something a per-person control withdraws —
            so a person who reads "Block" as "they can no longer see me" is reading in a promise
            nothing here makes.
        */}
        <Show when={(contacts() ?? []).some((entry) => entry.blocked)}>
          <span class="text-[11px] leading-snug text-v2-text-text-muted">
            Blocking drops their messages as they arrive — nothing is stored, so unblocking will not
            bring back what was refused. It does not hide you from them: joining the community is what
            exposes your address, and that stays true for everyone you have met.
          </span>
        </Show>
        <div class="flex items-center gap-2">
          <TextInputV2
            appearance="base"
            value={adding()}
            onInput={(event) => setAdding(event.currentTarget.value)}
            placeholder="Paste a key (nid_…)"
            spellcheck={false}
            autocapitalize="off"
            autocorrect="off"
          />
          {/* A name YOU chose, not one they claim. There is no registry, so nothing stops two peers
              calling themselves the same thing — only the key tells them apart, and a list of raw
              keys is unreadable to anyone. Adding an existing peer with a name renames them. */}
          <TextInputV2
            appearance="base"
            value={addingName()}
            onInput={(event) => setAddingName(event.currentTarget.value)}
            placeholder="Name them (optional)"
          />
          <ButtonV2 variant="neutral" size="small" disabled={busy() || !adding().trim()} onClick={() => void add()}>
            {busy() ? "Adding…" : "Add"}
          </ButtonV2>
        </div>
        <Show when={problem()}>
          <span class="text-[11px] leading-snug text-v2-text-text-muted">{problem()}</span>
        </Show>
        <div class="mt-1 flex items-center gap-2">
          <ButtonV2 variant="ghost" size="small" disabled={finding()} onClick={() => void find()}>
            {finding() ? "Looking…" : "Find instances"}
          </ButtonV2>
          <span class="text-[11px] leading-snug text-v2-text-text-muted">
            Looks on this network, then asks whoever answers who else they know.
          </span>
        </div>
        {/* 🔴 ANSWERING — a second switch, and the only one that spends the user's tokens.
            AGENTS.md makes the ledger mandatory for unattended operation, and this is the capability
            it exists to make safe; joining does not imply it and must never turn it on. */}
        <div class="mt-2 flex items-center gap-2">
          <ButtonV2
            variant="neutral"
            size="small"
            disabled={switching()}
            onClick={() =>
              void setParticipation({ answers: { enabled: !(participation()?.answers.enabled ?? false) } })
            }
          >
            {participation()?.answers.enabled ? "Stop answering peers" : "Answer peers' questions"}
          </ButtonV2>
          <span class="text-[11px] leading-snug text-v2-text-text-muted">
            <Show
              when={participation()?.answers.enabled}
              fallback={
                "Off. Other instances can ask this one questions; answering spends your tokens, so it stays off until you say otherwise."
              }
            >
              {/* ⚠️ The COUNT, not just the switch: a budget you cannot see moving is one you cannot
                  trust, and this is the number that stops a stranger spending a day of tokens. */}
              {`${participation()?.answers.today ?? 0} of ${participation()?.answers.perDay ?? 0} answered today. Each reply is signed by this instance, so a careless one costs your standing.`}
            </Show>
          </span>
        </div>
        {/* 🔴 PUBLISHING this instance's address — the strongest switch on this panel, and the
            only one that leaves something behind. Joining reveals this machine's IP to peers it
            talks to; answering spends tokens; this puts an address in a public directory that
            anyone can read WITHOUT ever talking to us, and it outlives the moment it was set.
            AGENTS.md accepts being findable as the price of true p2p — but that is about being
            enumerable once you are in, not about volunteering to be the network's front door.

            ⚠️ It is TYPED, never detected. An instance sees its interfaces, and a machine behind a
            NAT sees private ones; a guess publishes a door nobody can open. The person who
            forwarded the port is the only one who knows. */}
        <div class="mt-2 flex items-start gap-2">
          <Show
            when={participation()?.announce}
            fallback={
              <>
                <TextInputV2
                  appearance="base"
                  value={publishing()}
                  onInput={(event) => setPublishing(event.currentTarget.value)}
                  placeholder="your-address:4096"
                  spellcheck={false}
                  autocapitalize="off"
                  autocorrect="off"
                />
                <ButtonV2
                  variant="neutral"
                  size="small"
                  disabled={switching() || publishing().trim() === ""}
                  onClick={() => void setParticipation({ announce: publishing().trim() })}
                >
                  Publish this address
                </ButtonV2>
                <span class="text-[11px] leading-snug text-v2-text-text-muted">
                  Off. Other instances find this one on your network, from addresses you type, and through
                  peers you already know. Publishing lets strangers find you directly — set it only if
                  this address really reaches you from the internet.
                </span>
              </>
            }
          >
            <ButtonV2 variant="neutral" size="small" disabled={switching()} onClick={() => void setParticipation({ announce: "" })}>
              Stop publishing
            </ButtonV2>
            <span class="text-[11px] leading-snug text-v2-text-text-muted">
              {`Published as ${participation()?.announce}. Anyone reading the public directory can see it, and it stays there for a while after you stop.`}
            </span>
          </Show>
        </div>
        {/* 🔴 The doorman row. Joining never needs it; it is how a user says "I know this one, and
            this is how far I trust them" once value is involved. */}
        <div class="mt-1 flex items-center gap-2">
          <span class="text-[11px] leading-snug text-v2-text-text-muted">Trust the address above:</span>
          <For each={[1, 2, 3, 4, 5]}>
            {(level) => (
              <ButtonV2
                variant={trust() === level ? "neutral" : "ghost"}
                size="small"
                onClick={() => setTrust(trust() === level ? 0 : level)}
              >
                {level}
              </ButtonV2>
            )}
          </For>
          <ButtonV2
            variant="neutral"
            size="small"
            disabled={naming() || !adding().trim() || trust() === 0}
            onClick={() => void nameDoorman()}
          >
            {naming() ? "Asking…" : "Add as doorman"}
          </ButtonV2>
        </div>
        <Show when={doormanNote()}>
          <span class="text-[11px] leading-snug text-v2-text-text-muted">{doormanNote()}</span>
        </Show>
        <Show when={found()}>
          <span class="text-[11px] leading-snug text-v2-text-text-muted">{found()}</span>
        </Show>
      </div>

      <div class="flex flex-col gap-1 rounded-xl bg-v2-background-bg-layer-02 px-3 py-3">
        <span class="text-[12px] font-medium text-v2-text-text-base">Model servers</span>
        <Show
          when={(offers() ?? []).length > 0}
          fallback={
            <span class="text-[11px] leading-snug text-v2-text-text-muted">
              Nobody you can reach is offering one yet.
            </span>
          }
        >
          <For each={offers() ?? []}>
            {(offer) => (
              <div class="flex flex-col gap-0.5 border-t border-white/5 pt-2 first:border-0 first:pt-0">
                <span class="truncate text-[10px] text-v2-text-text-muted">{nameFor()(offer.from)}</span>
                <span class="text-[12px] leading-snug text-v2-text-text-base">{offer.endpoint}</span>
                <div class="flex items-center gap-2">
                  <span class="text-[11px] leading-snug text-v2-text-text-muted">
                    {offer.models.join(", ") || "models unspecified"} · {offer.price}
                  </span>
                  {/*
                    ⛔ COPIES the address. There is deliberately no button that pays: NovaClaw
                    generates no invoice, holds no balance and settles nothing, and a control that
                    looked like it paid would be the most dangerous thing on this screen.
                  */}
                  <Show when={offer.payTo}>
                    <ButtonV2
                      variant="ghost"
                      size="small"
                      onClick={() => void navigator.clipboard.writeText(offer.payTo)}
                    >
                      Copy payment address
                    </ButtonV2>
                  </Show>
                  {/*
                    🔴 COPIES the address; it does not configure anything. Adding it as a provider
                    automatically would point this user's prompts at somebody else's machine — the one
                    thing the data-plane promise is about — off the back of an advertisement. Handing
                    them the address and letting them decide in Settings keeps that choice theirs and
                    visible, and costs one paste.
                  */}
                  {/* ⚠️ "Use this" prefills; it never saves. The dialog it opens probes the endpoint
                      first, and the user presses through — see `useOffer`. */}
                  <ButtonV2 variant="ghost" size="small" onClick={() => useOffer(offer.endpoint)}>
                    Use this
                  </ButtonV2>
                  <ButtonV2
                    variant="ghost"
                    size="small"
                    onClick={() => void navigator.clipboard.writeText(offer.endpoint)}
                  >
                    Copy address
                  </ButtonV2>
                </div>
              </div>
            )}
          </For>
        </Show>
        {/* 🔴 Says exactly what the signature buys and what it does not. Someone reading this is about
            to send their prompts somewhere, and "verified" would be read as "vouched for". */}
        <span class="mt-1 text-[11px] leading-snug text-v2-text-text-muted">
          Each one is signed, so the address cannot have been changed on the way to you. Whether it
          works, serves what it says, or is still there tomorrow is between you and them. "Use this"
          fills the address into your model settings and checks it answers — your prompts would then go
          to that person's machine, so nothing is saved until you say so.
        </span>
        <div class="mt-2 flex flex-col gap-2 border-t border-white/5 pt-2">
          {/* ⚠️ Stated BEFORE the controls. Read from the OWNER's endpoint: reading the peer door
              here meant an airgap or a stricter rule silently turned "you are offering X" into "you
              are not offering anything", which is a different sentence and a false one. */}
          <Show
            when={myOffer()?.offer}
            fallback={<span class="text-[11px] text-v2-text-text-muted">You are not offering anything.</span>}
          >
            {(mine) => (
              <Show
                when={myOffer()?.servable}
                fallback={
                  /* 🔴 Stored, but peers are being served NOTHING — an endpoint or payment address
                     an older build accepted and this one refuses. Said plainly, with the form below
                     as the one action that fixes it. */
                  <span class="text-[11px] leading-snug text-v2-text-text-base">
                    Your offer of {mine().endpoint} is no longer being sent to anyone — its address is not one
                    this version will advertise. Re-enter it below to fix that.
                  </span>
                }
              >
                <span class="text-[11px] leading-snug text-v2-text-text-base">
                  You are offering {mine().endpoint} — {mine().models.join(", ") || "models unspecified"} ·{" "}
                  {mine().price}
                </span>
              </Show>
            )}
          </Show>
          <span class="text-[11px] text-v2-text-text-muted">Offer your own:</span>
          <TextInputV2
            appearance="base"
            value={offerEndpoint()}
            onInput={(event) => setOfferEndpoint(event.currentTarget.value)}
            placeholder="Address, e.g. https://my-box:8010/v1"
          />
          <TextInputV2
            appearance="base"
            value={offerModels()}
            onInput={(event) => setOfferModels(event.currentTarget.value)}
            placeholder="Models, comma separated"
          />
          <div class="flex items-center gap-2">
            <TextInputV2
              appearance="base"
              value={offerPrice()}
              onInput={(event) => setOfferPrice(event.currentTarget.value)}
              placeholder="Terms in your own words — e.g. free, or 500 sats a request"
            />
            <TextInputV2
              appearance="base"
              value={offerPayTo()}
              onInput={(event) => setOfferPayTo(event.currentTarget.value)}
              placeholder="Lightning address, if you want paying (optional)"
            />
            <ButtonV2 variant="neutral" size="small" disabled={!offerEndpoint().trim()} onClick={() => void publishOffer()}>
              Offer
            </ButtonV2>
            <ButtonV2 variant="ghost" size="small" onClick={() => void withdrawOffer()}>
              Withdraw
            </ButtonV2>
          </div>
          {/* ⚠️ No payment exists. Saying so plainly is better than a user assuming the software will
              collect for them and discovering otherwise after giving away compute. */}
          <span class="text-[11px] leading-snug text-v2-text-text-muted">
            NovaClaw does not handle money — no invoices, no balances, nothing counted. An address here
            is shown to others so they can pay you from their own wallet, or not.
          </span>
          <Show when={offerNote()}>
            <span class="text-[11px] leading-snug text-v2-text-text-muted">{offerNote()}</span>
          </Show>
        </div>
      </div>

      <Show when={(conversations() ?? []).length > 0 || talkingTo() !== ""}>
        <div class="flex flex-col gap-1 rounded-xl bg-v2-background-bg-layer-02 px-3 py-3">
          <span class="text-[12px] font-medium text-v2-text-text-base">Direct messages</span>
          <div class="flex flex-wrap items-center gap-1">
            <For each={conversations() ?? []}>
              {(peer) => (
                <ButtonV2
                  variant={peer === talkingTo() ? "neutral" : "ghost"}
                  size="small"
                  onClick={() => setTalkingTo(peer)}
                >
                  {nameFor()(peer)}
                </ButtonV2>
              )}
            </For>
          </div>
          <Show when={talkingTo() !== ""}>
            <For each={dms() ?? []}>
              {(message) => (
                <div class="flex flex-col gap-0.5 border-t border-white/5 pt-2 first:border-0 first:pt-0">
                  <span class="truncate text-[10px] text-v2-text-text-muted">
                    {message.direction === "out" ? "You" : nameFor()(message.peer)}
                  </span>
                  <span class="text-[12px] leading-snug text-v2-text-text-base">{message.body}</span>
                </div>
              )}
            </For>
            <div class="mt-2 flex items-center gap-2">
              <TextInputV2
                appearance="base"
                value={dmDraft()}
                onInput={(event) => setDmDraft(event.currentTarget.value)}
                placeholder={`Write to ${nameFor()(talkingTo())}`}
                spellcheck={true}
              />
              <ButtonV2 variant="neutral" size="small" disabled={!dmDraft().trim()} onClick={() => void sendDirect()}>
                Send
              </ButtonV2>
            </div>
            <Show when={dmNote()}>
              <span class="text-[11px] leading-snug text-v2-text-text-muted">{dmNote()}</span>
            </Show>
            {/* ⚠️ Precisely what is and is not promised. "Only they can read it" is true — the seal is
                to their key, so even an instance relaying it holds ciphertext. Anything implying
                anonymity would be false: who talked to whom is visible to anyone watching. */}
            <span class="text-[11px] leading-snug text-v2-text-text-muted">
              Sealed to their key — only they can read it, not even an instance passing it along. That
              you two talked is not hidden.
            </span>
          </Show>
        </div>
      </Show>

      <div class="flex flex-col gap-1 rounded-xl bg-v2-background-bg-layer-02 px-3 py-3">
        {/*
          🔴 A channel SWITCHER, not a label. `#NovaClaw` is where everyone starts, and a forum with
          exactly one room forever is a mailing list — the whole point of a name being nothing but a
          hash is that anyone can make a room without asking us for it.
        */}
        <div class="flex flex-wrap items-center gap-1">
          <For each={channels() ?? []}>
            {(entry) => (
              <ButtonV2
                variant={entry.name === channel() ? "neutral" : "ghost"}
                size="small"
                onClick={() => setSelected(entry.name)}
              >
                {/* ⚠️ Muted is shown, never hidden: a channel you silenced and then forgot you
                    silenced looks exactly like a channel nobody posts in. */}
                {entry.muted ? `${entry.name} · muted` : entry.name}
              </ButtonV2>
            )}
          </For>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[12px] font-medium text-v2-text-text-base">{channel()}</span>
          <Show when={(channels() ?? []).find((entry) => entry.name === channel())}>
            {(entry) => (
              <>
                <ButtonV2 variant="ghost" size="small" onClick={() => void mute(entry().name, !entry().muted)}>
                  {entry().muted ? "Unmute" : "Mute"}
                </ButtonV2>
                {/* ⚠️ Says what is IN FORCE, per principle 12(d) — not an unlabelled switch. Being
                    in a room is not public unless the user says it is. */}
                <ButtonV2
                  variant="ghost"
                  size="small"
                  onClick={() => void setListed(entry().name, !entry().listed)}
                >
                  {entry().listed ? "Listed — others can find you here" : "Not listed"}
                </ButtonV2>
                {/* Leaving KEEPS the history — the store refuses to delete it, so this is a
                    subscription change and not a destructive act needing a confirmation. */}
                <ButtonV2 variant="ghost" size="small" onClick={() => void leave(entry().name)}>
                  Leave
                </ButtonV2>
              </>
            )}
          </Show>
        </div>
        <Show
          when={(history()?.messages.length ?? 0) > 0}
          fallback={
            /* ⚠️ Says WHY it is empty, in the INSTANCE's terms. "No messages" would read as a
               broken screen, and a hardcoded reason would misreport an airgapped instance. */
            <span class="text-[11px] leading-snug text-v2-text-text-muted">{emptyReason()}</span>
          }
        >
          <For each={history()?.messages ?? []}>
            {(message) => (
              <div class="flex flex-col gap-0.5 border-t border-white/5 pt-2 first:border-0 first:pt-0">
                <span class="truncate text-[10px] text-v2-text-text-muted" title={message.author}>
                  {nameFor()(message.author)}
                </span>
                <span class="text-[12px] leading-snug text-v2-text-text-base">{message.body}</span>
              </div>
            )}
          </For>
        </Show>
        <div class="mt-2 flex items-center gap-2">
          <TextInputV2
            appearance="base"
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
            placeholder={`Say something in ${channel()}`}
            spellcheck={true}
          />
          <ButtonV2 variant="neutral" size="small" disabled={!draft().trim()} onClick={() => void say()}>
            Say
          </ButtonV2>
        </div>
        <Show when={sendNote()}>
          <span class="text-[11px] leading-snug text-v2-text-text-muted">{sendNote()}</span>
        </Show>
        {/* ⚠️ Reported, never silent: a room that looks quiet because of a rule the user forgot they
            wrote is indistinguishable from one nobody posts in. */}
        {/*
          🔴 Say that this is a PAGE. Retention keeps thousands and a reader gets 200, and nothing
          said so — a user looking for something said last week saw the oldest of 200 and no reason
          to think anything older survived. That is the same silence the `hidden` line beneath exists
          to break, and catching up made it concrete: an instance can fetch 600 messages and show 200.

          ⚠️ Shown only when there IS more, so a quiet room stays quiet. Deliberately states the
          numbers rather than offering a control: paging is a product decision, and inventing one
          here would answer it by accident.
        */}
        <Show when={(history()?.held ?? 0) > pageRead()}>
          <span class="text-[11px] text-v2-text-text-muted">
            {`Showing the most recent ${pageRead()} of ${history()?.held ?? 0} messages this room holds.`}
          </span>
        </Show>
        <Show when={(history()?.hidden ?? 0) > 0}>
          <span class="text-[11px] leading-snug text-v2-text-text-muted">
            {`${history()?.hidden} message(s) hidden by your words below.`}
          </span>
        </Show>
        <div class="mt-2 flex flex-col gap-1 border-t border-white/5 pt-2">
          <div class="flex flex-wrap items-center gap-1">
            <span class="text-[11px] text-v2-text-text-muted">Hide messages containing:</span>
            <For each={filters() ?? []}>
              {(pattern) => (
                <ButtonV2 variant="ghost" size="small" onClick={() => void removeFilter(pattern)}>
                  {`${pattern} ✕`}
                </ButtonV2>
              )}
            </For>
          </div>
          <div class="flex items-center gap-2">
            <TextInputV2
              appearance="base"
              value={filterDraft()}
              onInput={(event) => setFilterDraft(event.currentTarget.value)}
              placeholder="A word you would rather not read"
            />
            <ButtonV2 variant="ghost" size="small" disabled={!filterDraft().trim()} onClick={() => void addFilter()}>
              Hide
            </ButtonV2>
          </div>
          {/* ⚠️ Says they are HIDDEN, not deleted — removing a rule brings them back, and a user who
              thought they had destroyed something would be wrong in a way that matters. */}
          <span class="text-[11px] leading-snug text-v2-text-text-muted">
            Your words, kept on this machine. Messages are hidden, not deleted — remove a word and they
            come back.
          </span>
        </div>
        {/*
          ⚠️ Offered BEFORE the free-text box, because principle 12 makes free text the fallback for
          what discovery missed rather than the front door. These are rooms whose messages are on
          this disk right now — the user has already met them.
        */}
        <Show when={(nearby() ?? []).length > 0}>
          <div class="mt-2 flex flex-col gap-1 border-t border-white/5 pt-2">
            <span class="text-[11px] text-v2-text-text-muted">
              Channels the instances you can reach say they are in:
            </span>
            <div class="flex flex-wrap items-center gap-1">
              <For each={nearby() ?? []}>
                {(name) => (
                  <ButtonV2 variant="ghost" size="small" onClick={() => void rejoin(name)}>
                    {name}
                  </ButtonV2>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={(archived() ?? []).length > 0}>
          <div class="mt-2 flex flex-col gap-1 border-t border-white/5 pt-2">
            <span class="text-[11px] text-v2-text-text-muted">
              You left these, and still have what was said in them:
            </span>
            <div class="flex flex-wrap items-center gap-1">
              <For each={archived() ?? []}>
                {(entry) => (
                  <ButtonV2 variant="ghost" size="small" onClick={() => void rejoin(entry.name)}>
                    {`${entry.name} · ${entry.messages} ${entry.messages === 1 ? "message" : "messages"}`}
                  </ButtonV2>
                )}
              </For>
            </div>
          </div>
        </Show>
        <div class="mt-2 flex items-center gap-2 border-t border-white/5 pt-2">
          <TextInputV2
            appearance="base"
            value={joining()}
            onInput={(event) => setJoining(event.currentTarget.value)}
            placeholder="Join a channel by name, e.g. #recipes"
          />
          <ButtonV2 variant="neutral" size="small" disabled={!joining().trim()} onClick={() => void join()}>
            Join
          </ButtonV2>
        </div>
        {/* ⚠️ Rewritten WITH the control it sits under. It used to say finding channels "needs the
            network part that is still being built", which stopped being true the moment discovery
            shipped — and copy describing the previous version is the failure principle 12 records,
            because the user reads an instruction to do what the control no longer needs. */}
        <span class="text-[11px] leading-snug text-v2-text-text-muted">
          Anyone can make a channel — a name is only a hash, so nobody owns one. Channels your peers
          list show up above; the rest you can join by name. Nobody sees which channels you are in
          unless you list them.
        </span>
      </div>
    </section>
    </Show>
  )
}
