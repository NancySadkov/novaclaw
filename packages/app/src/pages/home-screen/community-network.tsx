import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import {
  communityAddContact,
  communityChannelHistory,
  communityChannels,
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

  const [identity] = createResource(connection, (value) => instanceIdentity(value.http))
  const [contacts, contactActions] = createResource(connection, (value) => communityContacts(value.http))
  const [channels, channelActions] = createResource(connection, (value) => communityChannels(value.http))

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
    return state.reason === "airgap" ? "Offline mode is on — nothing goes in or out" : "Not connected yet"
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
      await channelActions.refetch()
      setSelected(name)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }

  const leave = async (name: string) => {
    const current = connection()
    if (!current) return
    await communityLeaveChannel(current.http, name)
    // The selection is resolved against the joined list, so dropping the channel being read falls
    // back to whatever remains rather than leaving the screen pointed at nothing.
    await channelActions.refetch()
    await historyActions.refetch()
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
      </div>

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
        {/* ⚠️ Says plainly that there is no directory yet. Without this, an empty switcher reads as
            "there are no other channels", when the truth is that FINDING them is the part still
            being built — the names themselves have always been free to make up. */}
        <span class="text-[11px] leading-snug text-v2-text-text-muted">
          Anyone can make a channel — a name is only a hash, so nobody owns one. Finding channels you
          were not told about needs the network part that is still being built.
        </span>
      </div>
    </section>
  )
}
