import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useGlobal } from "@/context/global"
import { useServerSync } from "@/context/server-sync"
import { useServer } from "@/context/server"
import {
  communityAddContact,
  communityChannelHistory,
  communityChannels,
  communityArchivedChannels,
  communityDiscover,
  communityOffers,
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
 * 🔴 Deliberately shown ALONGSIDE the Discord/Reddit links rather than replacing them yet. The
 * owner's goal is to replace them, but a transport does not exist: swapping working links that reach
 * real people for an empty room would be a regression, not a launch. When a message can arrive, this
 * becomes the panel and the links move below it.
 *
 * It is honest about that state rather than pretending to connect — *"the UI never crashes to a
 * dead-end"* means degrading with a calm explanation, not hiding the fact that nothing is listening.
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
  const [myOffer, myOfferActions] = createResource(connection, (value) => communityMyOffer(value.http))
  const [offerEndpoint, setOfferEndpoint] = createSignal("")
  const [offerModels, setOfferModels] = createSignal("")
  const [offerPrice, setOfferPrice] = createSignal("")
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
    // reading them: one they chose, one we have not built, and one they can fix in the next minute.
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
      setFound(
        result.peers === 0
          ? "Found nobody yet. Anyone running NovaClaw on this network shows up here, or paste someone's address above."
          : `${result.peers} ${result.peers === 1 ? "instance" : "instances"} reachable` +
              (result.learned > 0 ? ` — ${result.learned} newly discovered` : ""),
      )
      await Promise.all([contactActions.refetch(), nearbyActions.refetch()])
    } catch (error) {
      setFound(error instanceof Error ? error.message : String(error))
    } finally {
      setFinding(false)
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
      // ⚠️ Says which of the two things happened. "Sent" would be a lie while nothing can carry it,
      // and silence would leave the user unsure whether their words went anywhere at all.
      setSendNote(
        result.delivered
          ? "Sent."
          : "Saved to your own copy — nobody can receive it yet, so it will not reach anyone until the network part lands.",
      )
      await historyActions.refetch()
    } catch (error) {
      setSendNote(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section class="flex flex-col gap-3" data-slot="community-network">
      <div class="flex flex-col gap-1">
        <span class="text-sm font-medium text-v2-text-text-base">Your own community</span>
        <span class="text-[12px] leading-snug text-v2-text-text-muted">
          Runs between NovaClaw instances — no company in the middle, and nobody who can switch it off.
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
          {/* ⚠️ Stated BEFORE the controls, and read from the peer-facing endpoint so the user sees
              their advertisement exactly as other people see it — not a local echo of what they typed. */}
          <Show
            when={myOffer()?.offer}
            fallback={<span class="text-[11px] text-v2-text-text-muted">You are not offering anything.</span>}
          >
            {(mine) => (
              <span class="text-[11px] leading-snug text-v2-text-text-base">
                You are offering {mine().endpoint} — {mine().models.join(", ") || "models unspecified"} ·{" "}
                {mine().price}
              </span>
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
            NovaClaw does not handle money. Terms are yours to state and yours to settle, directly.
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
          when={(history()?.length ?? 0) > 0}
          fallback={
            /* ⚠️ Says WHY it is empty, in the INSTANCE's terms. "No messages" would read as a
               broken screen, and a hardcoded reason would misreport an airgapped instance. */
            <span class="text-[11px] leading-snug text-v2-text-text-muted">{emptyReason()}</span>
          }
        >
          <For each={history() ?? []}>
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
  )
}
