import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { listAgents, listSessions } from "@/apps/agent-list"
import { briefTooBigForTier, isTier, modelRef, parseModelRef } from "@/apps/agent-model"
import { useModels } from "@/context/models"
import { planClone } from "@/apps/agent-clone"
import { chatFor } from "@/apps/roster-live"
import { GOVERNING_ID, displayName, memoryDisclosure, type AgentLike } from "@/apps/contacts"

// ONE agent configuration dialog, opened from two places (AGENTS.md → *the structural metaphor*;
// `todo/named-agents.md`).
//
// 🔴 **This is where the composer's Tune button now leads.** Tune used to be a chat-scoped popover
// under the message box, which said the quiet part: settings belonged to a *conversation*. Under the
// roster they belong to a *colleague* — its brief, its personality, what it remembers — and the chat
// only carries how this particular conversation runs. So the button opens the colleague's config,
// with the chat's own controls as a section inside it rather than the whole of it.
//
// ⚠️ **A field the system would discard is not rendered as editable.** The governing agent's profile
// is fixed in code and a config write naming it is dropped at materialisation, so those inputs are
// read-only here and say why. Offering an input whose value goes nowhere is worse than offering
// nothing: the user does the work, sees no error, and learns not to trust the surface.

export function AgentConfigDialog(props: {
  /** Which colleague. `undefined` while a chat is still resolving its agent. */
  agentID: string | undefined
  onDismiss: () => void
  /** The chat-scoped controls, when this was opened from a conversation. Absent from Contacts: there
   *  is no chat to tune, and rendering an empty section would imply one. */
  tuning?: () => JSX.Element
}) {
  const language = useLanguage()
  const global = useGlobal()
  const server = useServer()
  const sync = useServerSync()

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const current = conn()
    return current ? global.ensureServerCtx(current) : undefined
  })
  const [agents] = createResource(ctx, (current) => listAgents(current.sdk.client.v2))
  const agent = createMemo<AgentLike | undefined>(() => (agents() ?? []).find((row) => row.id === props.agentID))

  const governing = createMemo(() => props.agentID === GOVERNING_ID)
  const name = createMemo(() => agent()?.name?.trim() || (props.agentID ? displayName(props.agentID) : ""))

  // Drafts start empty and fall back to the stored value at render, so an edit survives a re-read of
  // the roster while an untouched field keeps tracking the server.
  const [renamed, setRenamed] = createSignal<string | undefined>()
  const [title, setTitle] = createSignal<string | undefined>()
  const [personality, setPersonality] = createSignal<string | undefined>()
  const [memory, setMemory] = createSignal<"own" | "none" | undefined>()
  const [archive, setArchive] = createSignal<boolean | undefined>()
  const [model, setModel] = createSignal<string | undefined>()
  const models = useModels()
  const [saving, setSaving] = createSignal(false)

  const nameValue = () => renamed() ?? agent()?.name ?? (props.agentID ? displayName(props.agentID) : "")
  const titleValue = () => title() ?? agent()?.title ?? ""
  const personalityValue = () => personality() ?? agent()?.personality ?? ""
  const memoryValue = () => memory() ?? agent()?.memory ?? "own"
  // Default ON — `undefined` means on, per the owner's "unless the settings disable it".
  const archiveValue = () => archive() ?? agent()?.archiveChats ?? true
  // "" is the INHERIT choice, and it is a real value rather than a missing one: a colleague with no
  // model of its own follows the instance default, which is a decision the user can return to.
  const modelValue = () => {
    const chosen = model()
    if (chosen !== undefined) return chosen
    const bound = agent()?.model
    return bound ? modelRef({ providerID: bound.providerID, modelID: bound.id }) : ""
  }
  const boundTier = createMemo(() => {
    const ref = parseModelRef(modelValue())
    if (ref === undefined) return undefined
    const found = models
      .list()
      .find((item) => item.id === ref.modelID && item.provider.id === ref.providerID) as { tier?: unknown } | undefined
    return isTier(found?.tier) ? found.tier : undefined
  })
  // The one thing a product whose user picks the model can say, and a vendor-chosen one cannot.
  const mindTooSmall = createMemo(() =>
    briefTooBigForTier({ brief: personalityValue() || agent()?.system, personality: personalityValue(), tier: boundTier() }),
  )
  const dirty = () =>
    renamed() !== undefined ||
    title() !== undefined ||
    personality() !== undefined ||
    memory() !== undefined ||
    archive() !== undefined ||
    model() !== undefined

  const [busy, setBusy] = createSignal<"clone" | "clear" | "retire" | undefined>()

  const sdk = () => ctx()?.sdk.client.v2

  /** Hire a copy: same brief, new identity (`apps/agent-clone.ts`). */
  const clone = async () => {
    const source = agent()
    if (source === undefined) return
    setBusy("clone")
    try {
      const roster = agents() ?? []
      const plan = planClone({
        source,
        // Ids AND display names, both — a second colleague READING as "Theron" is the collision that
        // matters, not a key clash.
        taken: roster.flatMap((row) => [row.id, row.name ?? ""]),
        random: Math.random,
      })
      await sync().updateConfig({ agents: { [plan.id]: plan.fragment } } as never)
      showToast({ variant: "success", title: language.t("agentConfig.clonedTitle", { name: plan.name }) })
      props.onDismiss()
    } catch (error) {
      showToast({ variant: "error", title: language.t("agentConfig.cloneFailed"), description: String(error) })
    } finally {
      setBusy(undefined)
    }
  }

  /** Clear this colleague's chat: the conversation is archived and the NEXT one starts empty. The
   *  colleague, its brief and its memory all survive — this is a new session, not a retirement. */
  const clearChat = async () => {
    const id = props.agentID
    const client = sdk()
    if (id === undefined || client === undefined) return
    setBusy("clear")
    try {
      const sessions = await listSessions(client)
      const chat = chatFor(sessions, id)
      if (chat === undefined) {
        showToast({ variant: "default", title: language.t("agentConfig.clearNothing") })
        return
      }
      await (client as never as { session: { update: (input: unknown) => Promise<unknown> } }).session.update({
        sessionID: chat.id,
        archived: Date.now(),
      })
      showToast({ variant: "success", title: language.t("agentConfig.clearedTitle") })
      props.onDismiss()
    } catch (error) {
      showToast({ variant: "error", title: language.t("agentConfig.clearFailed"), description: String(error) })
    } finally {
      setBusy(undefined)
    }
  }

  /** Retire the colleague. Refused by the API for the governing agent, which is why the control is
   *  not rendered for it — the roster must not offer what the endpoint will decline. */
  const retire = async () => {
    const id = props.agentID
    const client = sdk()
    if (id === undefined || client === undefined || governing()) return
    setBusy("retire")
    try {
      await (client as never as { agent: { remove: (input: unknown) => Promise<{ error?: unknown }> } }).agent
        .remove({ agentID: id })
        .then((response) => {
          if (response.error) throw response.error
        })
      showToast({ variant: "success", title: language.t("agentConfig.retiredTitle", { name: name() }) })
      props.onDismiss()
    } catch (error) {
      showToast({ variant: "error", title: language.t("agentConfig.retireFailed"), description: String(error) })
    } finally {
      setBusy(undefined)
    }
  }

  const save = async () => {
    const id = props.agentID
    if (id === undefined || governing()) return
    setSaving(true)
    try {
      // The ordinary config merge — one agent's fragment, layered like any other config write.
      // The id is NOT in this patch and never will be: it keys `agent:<id>`, so renaming it would
      // orphan the colleague from everything it remembers. A rename moves the NAME only.
      await sync().updateConfig({
        agents: {
          [id]: {
            name: nameValue(),
            title: titleValue(),
            personality: personalityValue(),
            memory: memoryValue(),
            archiveChats: archiveValue(),
            // An empty choice means INHERIT. Writing "" would store an unparseable ref, so the key
            // is simply not sent — `undefined` is how this config says "ask the chain above me".
            ...(modelValue() === "" ? {} : { model: modelValue() }),
          },
        },
      } as never)
      setRenamed(undefined)
      setTitle(undefined)
      setPersonality(undefined)
      setMemory(undefined)
      setArchive(undefined)
      setModel(undefined)
      props.onDismiss()
    } catch (error) {
      // A failed save is SAID, never swallowed: the fields still hold the user's words, and telling
      // them it worked when it did not is how a person loses a brief they spent ten minutes writing.
      showToast({ variant: "error", title: language.t("agentConfig.saveFailed"), description: String(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="flex max-h-[80vh] w-[min(560px,92vw)] flex-col overflow-hidden rounded-xl bg-v2-background-bg-base text-v2-text-text-base">
      <div class="flex items-center gap-3 border-b border-v2-border-border-base px-4 py-3">
        <span class="flex size-9 items-center justify-center rounded-full bg-v2-background-bg-layer-02 text-base">
          {agent()?.avatar ?? name().charAt(0)}
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-semibold">{name()}</span>
          <span class="block truncate text-xs text-v2-text-text-muted">
            {agent()?.title ?? language.t("agentConfig.noTitle")}
          </span>
        </span>
        <button type="button" class="text-xs text-v2-text-text-muted hover:underline" onClick={props.onDismiss}>
          {language.t("agentConfig.close")}
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <section>
          <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
            {language.t("agentConfig.who")}
          </h3>
          <Show
            when={!governing()}
            fallback={<p class="mt-2 text-xs text-v2-text-text-faint">{language.t("agentConfig.governingLocked")}</p>}
          >
            <label class="mt-2 block text-xs text-v2-text-text-muted">
              {language.t("agentConfig.name")}
              <TextInputV2
                class="mt-1"
                value={nameValue()}
                onInput={(event) => setRenamed(event.currentTarget.value)}
              />
            </label>
            {/* Why a rename is safe, said once where someone is about to do it. */}
            <p class="mt-1 text-[11px] text-v2-text-text-faint">{language.t("agentConfig.nameHint")}</p>
            <label class="mt-3 block text-xs text-v2-text-text-muted">
              {language.t("agentConfig.jobTitle")}
              <TextInputV2
                class="mt-1"
                value={titleValue()}
                onInput={(event) => setTitle(event.currentTarget.value)}
                placeholder={language.t("agentConfig.jobTitlePlaceholder")}
              />
            </label>
            <label class="mt-3 block text-xs text-v2-text-text-muted">
              {language.t("agentConfig.personality")}
              <textarea
                class="mt-1 min-h-20 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
                value={personalityValue()}
                onInput={(event) => setPersonality(event.currentTarget.value)}
                placeholder={language.t("agentConfig.personalityPlaceholder")}
              />
            </label>
            {/* Why this is a profile field and not something you type into the chat. */}
            <p class="mt-1 text-[11px] text-v2-text-text-faint">{language.t("agentConfig.personalityHint")}</p>
          </Show>
        </section>

        <section class="mt-5">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
            {language.t("agentConfig.memory")}
          </h3>
          <div class="mt-2 flex flex-col gap-1.5">
            {/* Both halves, again — this is the surface where someone decides what a colleague keeps,
                so it is the last place that should describe only the private half. */}
            <label class="flex items-start gap-2 text-xs">
              <input
                type="radio"
                class="mt-0.5"
                checked={memoryValue() === "own"}
                disabled={governing()}
                onChange={() => setMemory("own")}
              />
              <span>{language.t(memoryDisclosure("own").privateKey)}</span>
            </label>
            <label class="flex items-start gap-2 text-xs">
              <input
                type="radio"
                class="mt-0.5"
                checked={memoryValue() === "none"}
                disabled={governing()}
                onChange={() => setMemory("none")}
              />
              <span>{language.t(memoryDisclosure("none").privateKey)}</span>
            </label>
            <p class="text-[11px] text-v2-text-text-faint">{language.t(memoryDisclosure("own").sharedKey)}</p>
          </div>
        </section>

        <section class="mt-5">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
            {language.t("agentConfig.mind")}
          </h3>
          {/* 🔴 The model belongs to the COLLEAGUE, not to the chat. A chat-scoped model made the
              same colleague clever in one conversation and poor in the next, for reasons the user
              could not see. A colleague has one mind. */}
          <select
            class="mt-2 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
            value={modelValue()}
            disabled={governing()}
            onChange={(event) => setModel(event.currentTarget.value)}
          >
            <option value="">{language.t("agentConfig.modelInherit")}</option>
            <For each={models.list()}>
              {(item) => (
                <option value={modelRef({ providerID: item.provider.id, modelID: item.id })}>
                  {item.name ?? item.id}
                </option>
              )}
            </For>
          </select>
          {/* WARNS, never refuses: a small model doing a big job badly is the user's call, and
              sometimes the right one. */}
          <Show when={mindTooSmall()}>
            <p class="mt-1 text-[11px] text-v2-state-fg-warning">{language.t("agentConfig.modelTooSmall")}</p>
          </Show>
        </section>

        <section class="mt-5">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
            {language.t("agentConfig.archive")}
          </h3>
          <div class="mt-2 flex flex-col gap-1.5">
            {/* A chat that never ends gets compacted; this decides whether the compressed-away half
                stays searchable or is gone but for a summary. */}
            <label class="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                class="mt-0.5"
                checked={archiveValue()}
                disabled={governing() || memoryValue() === "none"}
                onChange={(event) => setArchive(event.currentTarget.checked)}
              />
              <span>{language.t("agentConfig.archiveKeep")}</span>
            </label>
            <Show when={memoryValue() === "none"}>
              {/* Said rather than silently ignored: a throwaway keeps nothing, so the control above
                  would be a promise this colleague cannot make. */}
              <p class="text-[11px] text-v2-text-text-faint">{language.t("agentConfig.archiveThrowaway")}</p>
            </Show>
          </div>
        </section>

        <Show when={props.tuning}>
          {(tuning) => (
            <section class="mt-5 border-t border-v2-border-border-faint pt-4">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
                {language.t("agentConfig.thisChat")}
              </h3>
              {/* The distinction the two sections exist to teach: above is who this colleague IS
                  everywhere, below is how this one conversation runs. */}
              <p class="mt-1 text-[11px] text-v2-text-text-faint">{language.t("agentConfig.thisChatHint")}</p>
              <div class="mt-2">{tuning()()}</div>
            </section>
          )}
        </Show>
      </div>

      {/* Lifecycle, kept apart from the profile fields: these do something the moment they are
          pressed, while everything above waits for Save. */}
      <div class="flex flex-wrap items-center gap-2 border-t border-v2-border-border-faint px-4 py-2.5">
        <button
          type="button"
          class="rounded-md px-2.5 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 disabled:opacity-40"
          disabled={busy() !== undefined || props.agentID === undefined}
          onClick={() => void clearChat()}
        >
          {busy() === "clear" ? language.t("agentConfig.clearing") : language.t("agentConfig.clearChat")}
        </button>
        <button
          type="button"
          class="rounded-md px-2.5 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 disabled:opacity-40"
          disabled={busy() !== undefined || agent() === undefined}
          onClick={() => void clone()}
        >
          {busy() === "clone" ? language.t("agentConfig.cloning") : language.t("agentConfig.clone")}
        </button>
        <Show when={!governing()}>
          <button
            type="button"
            class="ml-auto rounded-md px-2.5 py-1.5 text-xs text-v2-state-fg-danger hover:bg-v2-background-bg-layer-02 disabled:opacity-40"
            disabled={busy() !== undefined || props.agentID === undefined}
            onClick={() => void retire()}
          >
            {busy() === "retire" ? language.t("agentConfig.retiring") : language.t("agentConfig.retire")}
          </button>
        </Show>
      </div>
      <Show when={!governing()}>
        <div class="flex items-center justify-end gap-2 border-t border-v2-border-border-base px-4 py-2.5">
          <button
            type="button"
            class="rounded-md px-3 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02"
            onClick={props.onDismiss}
          >
            {language.t("agentConfig.cancel")}
          </button>
          <button
            type="button"
            class="rounded-md bg-v2-background-bg-layer-03 px-3 py-1.5 text-xs font-medium disabled:opacity-40"
            disabled={!dirty() || saving() || props.agentID === undefined}
            onClick={() => void save()}
          >
            {saving() ? language.t("agentConfig.saving") : language.t("agentConfig.save")}
          </button>
        </div>
      </Show>
    </div>
  )
}
