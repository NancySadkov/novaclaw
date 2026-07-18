import { Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import type { SessionV2Info as Session } from "@novaclaw/sdk/v2/client"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { Button } from "@novaclaw/ui/button"
import { Icon } from "@novaclaw/ui/icon"
import { RequiresLevel } from "@/context/expertise"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { subtreeRows, tokenTotals } from "@/pages/home-session-meta"
import { sessionTitle } from "@/utils/session-title"
import { adhocDiscard, adhocList, adhocPromote, switchPromptOverride, type AdhocRecipe } from "@/utils/fs-api"

// Chat details sheet (uix-improvement slice 5): everything a user may want to KNOW about a chat —
// its working folder, agent + model, live status, file changes, timestamps, and token usage (this
// chat AND the rollup across its sub-agent threads) — with a one-line explainer so tokens teach
// rather than gatekeep. All values are already on the client Session record; zero new fetches.

const Row: Component<{ label: string; value: string; mono?: boolean }> = (props) => (
  <div class="flex items-baseline gap-3 py-1.5">
    <span class="w-28 shrink-0 text-[12px] text-v2-text-text-faint [font-weight:470]">{props.label}</span>
    <span
      class="min-w-0 flex-1 break-all text-[13px] text-v2-text-text-base [font-weight:470]"
      classList={{ "font-mono text-[12px]": props.mono }}
    >
      {props.value}
    </span>
  </div>
)

export const DialogSessionInfo: Component<{ session: Session; projectName?: string }> = (props) => {
  const language = useLanguage()
  const server = useServer()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()

  // B4/T2: the per-session system-prompt OVERRIDE layer (advanced+). The record value is the
  // load-time truth; the draft signal is what the user is editing. Saving posts the switch route
  // (the same durable event the agent-side `reconfigure` tool publishes) — it applies from the
  // session's next turn, and children/forks inherit through the config walk.
  const recordOverride = () =>
    (props.session as Session & { systemPromptOverride?: string }).systemPromptOverride ?? ""
  const [promptDraft, setPromptDraft] = createSignal<string | undefined>(undefined)
  const [promptSaved, setPromptSaved] = createSignal(recordOverride())
  const promptValue = () => promptDraft() ?? promptSaved()
  const promptDirty = () => promptDraft() !== undefined && promptDraft() !== promptSaved()
  const savePromptOverride = (next: string | null) => {
    const conn = server.current
    if (!conn) return
    setPromptSaved(next ?? "")
    setPromptDraft(undefined)
    void switchPromptOverride(conn.http, {
      directory: props.session.location.directory,
      sessionID: props.session.id,
      override: next,
    }).catch((error) => console.error("switchPromptOverride failed", error))
  }

  // Tags component (notes/entities.md T0): edit the chat's tag set inline. Writes replace the full
  // set (idempotent PUT); the store updates reactively via the `session.tags.updated` event.
  const tags = createMemo(() => serverSync().session.data.tag[props.session.id] ?? [])
  const [draft, setDraft] = createSignal("")
  const saveTags = (next: string[]) => {
    void serverSDK()
      .client.v2.session.tags.set({ sessionID: props.session.id, tags: next })
      .catch(() => undefined)
  }
  const addTag = () => {
    const value = draft().trim()
    if (!value) return
    setDraft("")
    if (tags().includes(value)) return
    saveTags([...tags(), value])
  }
  const removeTag = (tag: string) => saveTags(tags().filter((item) => item !== tag))
  const number = createMemo(() => new Intl.NumberFormat(language.intl()))
  const when = createMemo(
    () => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" }),
  )

  const threads = createMemo(() => {
    const [childStore] = serverSync().child(props.session.location.directory, { bootstrap: false })
    return subtreeRows(childStore.session, props.session.id)
  })
  const own = createMemo(() => tokenTotals([props.session]))
  const rollup = createMemo(() => tokenTotals([props.session, ...threads().map((row) => row.session)]))

  const status = createMemo(() => {
    const data = serverSync().session.data
    const waiting =
      (data.permission[props.session.id]?.length ?? 0) > 0 || (data.question[props.session.id]?.length ?? 0) > 0
    if (waiting) return language.t("home.sessions.attention.waiting")
    if (data.session_working(props.session.id)) return language.t("home.sessions.attention.working")
    return language.t("session.info.status.ready")
  })

  // 4E (small-tails T5): the review surface for tools this chat's agent defined for itself
  // (define_tool). Promote copies one into the instance-wide adhoc_tools config; Discard drops
  // it from the session. Hidden entirely while the session has none.
  const [recipes, { refetch: refetchRecipes }] = createResource(
    () => (server.current ? { conn: server.current } : undefined),
    ({ conn }) =>
      adhocList(conn.http, { directory: props.session.location.directory, sessionID: props.session.id }).catch(
        () => [] as AdhocRecipe[],
      ),
  )
  const [promoted, setPromoted] = createSignal<string[]>([])
  const promoteRecipe = (name: string) => {
    const conn = server.current
    if (!conn) return
    void adhocPromote(conn.http, { directory: props.session.location.directory, sessionID: props.session.id, name })
      .then(() => setPromoted((list) => (list.includes(name) ? list : [...list, name])))
      .catch((error) => console.error("adhocPromote failed", error))
  }
  const discardRecipe = (name: string) => {
    const conn = server.current
    if (!conn) return
    void adhocDiscard(conn.http, { directory: props.session.location.directory, sessionID: props.session.id, name })
      .then(() => refetchRecipes())
      .catch((error) => console.error("adhocDiscard failed", error))
  }

  const changes = createMemo(() => {
    const summary = props.session.summary
    if (!summary || (summary.files ?? 0) <= 0) return undefined
    return language.t("session.info.changes.value", {
      files: summary.files ?? 0,
      additions: summary.additions ?? 0,
      deletions: summary.deletions ?? 0,
    })
  })

  return (
    <Dialog size="normal">
      <div class="flex w-full min-w-[22rem] max-w-[34rem] flex-col gap-1 p-4">
        <div class="flex items-center gap-2 border-b border-v2-border-border-base pb-2">
          <Icon name="info" size="small" class="text-v2-icon-icon-muted" />
          <span class="grow truncate text-[15px] font-semibold text-v2-text-text-base">
            {sessionTitle(props.session.title) || props.session.id}
          </span>
        </div>
        <div class="flex flex-col pt-1">
          <Row label={language.t("session.info.folder")} value={props.session.location.directory} mono />
          <div class="flex items-baseline gap-3 py-1.5">
            <span class="w-28 shrink-0 text-[12px] text-v2-text-text-faint [font-weight:470]">
              {language.t("session.info.tags")}
            </span>
            <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              <For each={tags()}>
                {(tag) => (
                  <span
                    data-slot="session-info-tag"
                    class="flex items-center gap-1 rounded-full bg-v2-background-bg-layer-01 px-2 py-0.5 text-[12px] leading-none text-v2-text-text-base [font-weight:470]"
                  >
                    {tag}
                    <button
                      type="button"
                      class="text-v2-text-text-faint hover:text-v2-text-text-base"
                      aria-label={`${language.t("common.remove")} ${tag}`}
                      onClick={() => removeTag(tag)}
                    >
                      ×
                    </button>
                  </span>
                )}
              </For>
              <input
                data-slot="session-info-tag-input"
                type="text"
                class="min-w-[10ch] flex-1 bg-transparent text-[12px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                placeholder={language.t("session.info.tags.placeholder")}
                value={draft()}
                onInput={(event) => setDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  addTag()
                }}
              />
            </div>
          </div>
          <Show when={props.session.agent}>
            <Row label={language.t("session.info.agent")} value={props.session.agent!} />
          </Show>
          <Show when={props.session.model?.id}>
            <Row label={language.t("session.info.model")} value={props.session.model!.id} mono />
          </Show>
          <Row label={language.t("session.info.status")} value={status()} />
          <Show when={changes()}>{(value) => <Row label={language.t("session.info.changes")} value={value()} />}</Show>
          <Show when={(props.session.cost ?? 0) > 0}>
            <Row label={language.t("session.info.cost")} value={`$${props.session.cost!.toFixed(4)}`} />
          </Show>
          <Row label={language.t("session.info.created")} value={when().format(props.session.time.created)} />
          <Show when={props.session.time.updated}>
            <Row label={language.t("session.info.updated")} value={when().format(props.session.time.updated)} />
          </Show>
          <div class="mt-2 border-t border-v2-border-border-base pt-2">
            <Row
              label={language.t("session.info.tokens.thisChat")}
              value={language.t("session.info.tokens.value", {
                total: number().format(own().total),
                input: number().format(own().input),
                output: number().format(own().output + own().reasoning),
              })}
            />
            <Show when={threads().length > 0}>
              <Row
                label={language.t("session.info.tokens.withThreads")}
                value={language.t("session.info.tokens.rollup", {
                  total: number().format(rollup().total),
                  threads: threads().length,
                })}
              />
            </Show>
            <p class="pt-1 text-[12px] leading-snug text-v2-text-text-faint">
              {language.t("session.info.tokens.hint")}
            </p>
          </div>
          <RequiresLevel min="advanced">
            <div class="mt-2 border-t border-v2-border-border-base pt-2" data-slot="session-info-prompt-override">
              <div class="flex items-center justify-between py-1.5">
                <span class="text-[12px] text-v2-text-text-faint [font-weight:470]">
                  {language.t("session.info.prompt.title")}
                </span>
                <div class="flex items-center gap-2">
                  <Show when={promptSaved().length > 0 || promptDirty()}>
                    <Button
                      variant="ghost"
                      type="button"
                      data-action="session-info-prompt-clear"
                      onClick={() => savePromptOverride(null)}
                    >
                      {language.t("common.clear")}
                    </Button>
                  </Show>
                  <Show when={promptDirty()}>
                    <Button
                      variant="primary"
                      type="button"
                      data-action="session-info-prompt-save"
                      onClick={() => savePromptOverride(promptValue().trim() === "" ? null : promptValue())}
                    >
                      {language.t("common.save")}
                    </Button>
                  </Show>
                </div>
              </div>
              <textarea
                data-slot="session-info-prompt-input"
                class="min-h-[72px] w-full resize-y rounded-md border border-v2-border-border-base bg-transparent p-2 font-mono text-[12px] leading-snug text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                placeholder={language.t("session.info.prompt.placeholder")}
                value={promptValue()}
                onInput={(event) => setPromptDraft(event.currentTarget.value)}
              />
              <p class="pt-1 text-[12px] leading-snug text-v2-text-text-faint">
                {language.t("session.info.prompt.hint")}
              </p>
            </div>
            <Show when={(recipes.latest ?? []).length > 0}>
              <div class="mt-2 border-t border-v2-border-border-base pt-2" data-slot="session-info-adhoc">
                <div class="py-1.5 text-[12px] text-v2-text-text-faint [font-weight:470]">
                  {language.t("session.info.adhoc.title")}
                </div>
                <For each={recipes.latest ?? []}>
                  {(recipe) => (
                    <div class="flex flex-col gap-1 py-1.5" data-slot="session-info-adhoc-recipe">
                      <div class="flex items-center gap-2">
                        <span class="font-mono text-[12px] text-v2-text-text-base [font-weight:470]">{recipe.name}</span>
                        <span class="min-w-0 flex-1 truncate text-[12px] text-v2-text-text-faint">
                          {recipe.description}
                        </span>
                        <Show
                          when={!promoted().includes(recipe.name)}
                          fallback={
                            <span class="text-[12px] text-v2-text-text-faint">
                              {language.t("session.info.adhoc.promoted")}
                            </span>
                          }
                        >
                          <Button
                            variant="ghost"
                            type="button"
                            data-action="session-info-adhoc-promote"
                            onClick={() => promoteRecipe(recipe.name)}
                          >
                            {language.t("session.info.adhoc.promote")}
                          </Button>
                        </Show>
                        <Button
                          variant="ghost"
                          type="button"
                          data-action="session-info-adhoc-discard"
                          onClick={() => discardRecipe(recipe.name)}
                        >
                          {language.t("session.info.adhoc.discard")}
                        </Button>
                      </div>
                      <details class="text-[12px] text-v2-text-text-faint">
                        <summary class="cursor-pointer select-none">{language.t("session.info.adhoc.manual")}</summary>
                        <pre class="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-v2-text-text-base">{recipe.manual}</pre>
                      </details>
                    </div>
                  )}
                </For>
                <p class="pt-1 text-[12px] leading-snug text-v2-text-text-faint">
                  {language.t("session.info.adhoc.hint")}
                </p>
              </div>
            </Show>
          </RequiresLevel>
        </div>
      </div>
    </Dialog>
  )
}
