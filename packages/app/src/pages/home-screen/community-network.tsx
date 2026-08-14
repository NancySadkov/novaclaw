import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import {
  communityAddContact,
  communityChannelHistory,
  communityContacts,
  communityJoinChannel,
  communityPost,
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
  const [history, historyActions] = createResource(connection, (value) =>
    communityChannelHistory(value.http, DEFAULT_CHANNEL),
  )
  const [transport] = createResource(connection, (value) => communityTransportState(value.http))

  /**
   * ⚠️ Read from the instance, never asserted here. This copy used to say "still being built"
   * unconditionally, which would have LIED to anyone who turned airgap on — telling them a feature
   * was unfinished when in fact they had switched the network off themselves.
   */
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
  const [problem, setProblem] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const add = async () => {
    const current = connection()
    const key = adding().trim()
    if (!current || !key) return
    setBusy(true)
    setProblem("")
    try {
      await communityAddContact(current.http, { networkID: key })
      // Joining the default channel here rather than at boot: a user who has added nobody has no
      // network to be in, and subscribing to a topic they cannot reach teaches them nothing.
      await communityJoinChannel(current.http, DEFAULT_CHANNEL)
      setAdding("")
      await contactActions.refetch()
    } catch (error) {
      // The instance's own words — it knows why a key was refused; this screen must not guess.
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const say = async () => {
    const current = connection()
    const body = draft().trim()
    if (!current || !body) return
    setSendNote("")
    try {
      await communityJoinChannel(current.http, DEFAULT_CHANNEL)
      const result = await communityPost(current.http, DEFAULT_CHANNEL, body)
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
                <span class="shrink-0 text-[11px] text-v2-text-text-muted">
                  {contact.blocked ? "blocked" : contact.routes.length > 0 ? "known address" : "no address yet"}
                </span>
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
          <ButtonV2 variant="neutral" size="small" disabled={busy() || !adding().trim()} onClick={() => void add()}>
            {busy() ? "Adding…" : "Add"}
          </ButtonV2>
        </div>
        <Show when={problem()}>
          <span class="text-[11px] leading-snug text-v2-text-text-muted">{problem()}</span>
        </Show>
      </div>

      <div class="flex flex-col gap-1 rounded-xl bg-v2-background-bg-layer-02 px-3 py-3">
        <span class="text-[12px] font-medium text-v2-text-text-base">{DEFAULT_CHANNEL}</span>
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
                <span class="truncate font-mono text-[10px] text-v2-text-text-muted">{message.author}</span>
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
            placeholder={`Say something in ${DEFAULT_CHANNEL}`}
            spellcheck={true}
          />
          <ButtonV2 variant="neutral" size="small" disabled={!draft().trim()} onClick={() => void say()}>
            Say
          </ButtonV2>
        </div>
        <Show when={sendNote()}>
          <span class="text-[11px] leading-snug text-v2-text-text-muted">{sendNote()}</span>
        </Show>
      </div>
    </section>
  )
}
