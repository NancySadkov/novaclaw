import { Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import type { SessionV2Info as Session } from "@novaclaw/sdk/v2/client"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Icon } from "@novaclaw/ui/v2/icon"
import { RequiresLevel } from "@/context/expertise"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { subtreeRows, tokenTotals } from "@/pages/home-session-meta"
import { sessionTitle } from "@/utils/session-title"
import { adhocDiscard, adhocList, adhocPromote, switchPromptOverride, type AdhocRecipe } from "@/utils/fs-api"
import { ProjectDetail, useProjectSummary } from "@/components/project-indicator"
import { PROJECT_DETAIL_LABELS } from "@/components/project-summary"
import {
  classifyReceipt,
  toPanel,
  type InterventionView,
  type PolicyDecisionInfo,
  type ReceiptRead,
} from "@/apps/session-policies"
import { policyState } from "@/utils/policy-api"

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
  // (the same durable event the agent-side `session` tool publishes) — it applies from the
  // session's next turn, and children/forks inherit through the config walk.
  const recordOverride = () => (props.session as Session & { systemPromptOverride?: string }).systemPromptOverride ?? ""
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
  // What governs this chat's folder (`todo/projects.md`). The sheet is where a user goes to find out
  // what a chat actually is, and "which novaclaw.json is narrowing my permissions" is exactly that
  // kind of question — the one a person asks after a tool call was refused. ⚠️ Reports only; the Tune
  // panel and Settings own the editing, and a third editor is a third answer about one file.
  const projectSource = createMemo(() => {
    const http = server.current?.http
    const directory = props.session.location.directory
    return http && directory ? { http, directory } : undefined
  })
  const project = useProjectSummary(projectSource, "chat")

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
  const when = createMemo(() => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" }))

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

  /**
   * ─── WHAT A PRE-ACTION POLICY DID TO THIS CHAT'S TOOL CALLS ────────────────────────────────
   *
   * `todo/projects.md`: *"bind every intervention to a receipt"* — and until 2026-08-19 the binding
   * existed only in a database row and in the sentence handed to the MODEL. A policy could rewrite a
   * `bash` command and the person whose computer ran it had nowhere to find out. This sheet is where
   * that belongs: it is already the place a user comes to ask what a chat actually is, and it
   * already answers the neighbouring question ("which novaclaw.json is narrowing my permissions")
   * for exactly the same reason — it is what a person opens after a tool call behaved oddly.
   *
   * ⚠️ Both reads DEGRADE rather than throw. A throw inside a `createResource` read reaches the root
   * ErrorBoundary and replaces the whole application; a receipt that failed to load must never cost
   * someone their chats.
   *
   * 🔴 But degrading is not the same as going quiet. The read has THREE outcomes and `classifyReceipt`
   * keeps them apart: a receipt (rows, possibly none), a chat with no attempt yet (404 — nothing has
   * run, so nothing can have intervened), and a read that FAILED. Collapsing the last into the middle
   * would delete the whole section from a chat that does have interventions — this feature's own
   * failure mode, one layer up.
   *
   * ⚠️ The installed list is fetched too, and only so a policy id that no longer resolves can be
   * NAMED as such. Failing to fetch it is not the same claim as "not installed" — `toIntervention`
   * keeps those apart, and this passes `undefined` rather than `[]` so it can.
   */
  const [receipt] = createResource(
    () => (server.current ? { conn: server.current } : undefined),
    async ({ conn }): Promise<ReceiptRead> => {
      try {
        // ⚠️ `throwOnError: false` for THIS call, and it is load-bearing rather than a style choice.
        // The shared client is built with `throwOnError: true` (`context/server-sdk.tsx`), which
        // turns a 404 into a thrown value carrying the error BODY and no status — so the three
        // states above would collapse back to two and a chat that never ran would read as "we could
        // not look". Asking for the envelope keeps `response.status` in hand.
        const answer = await serverSDK().client.v2.session.receipt(
          { sessionID: props.session.id },
          { throwOnError: false },
        )
        const typed = answer as {
          response?: { status?: number }
          data?: { data?: { policies?: readonly PolicyDecisionInfo[] } }
        }
        return classifyReceipt(typed.response?.status, typed.data?.data?.policies)
      } catch {
        // The request never produced a status at all, which is exactly the `unreadable` case.
        return classifyReceipt(undefined, undefined)
      }
    },
  )
  const [installedPolicies] = createResource(
    () => (server.current ? { conn: server.current, dir: props.session.location.directory } : undefined),
    async ({ conn, dir }) => {
      try {
        return (await policyState(conn.http, dir)).installed.map((entry) => ({
          id: entry.id,
          describe: entry.describe,
        }))
      } catch {
        return undefined
      }
    },
  )
  const policyPanel = createMemo(() => {
    const read = receipt.latest
    if (!read) return undefined
    return toPanel(read, installedPolicies.latest)
  })
  /** The rows to render. Empty for every arm that has no rows, so the JSX asks one question. */
  const policyViews = createMemo((): readonly InterventionView[] => {
    const panel = policyPanel()
    return panel?.state === "list" ? panel.views : []
  })
  // ⚠️ Every key is a LITERAL, spelled out per union member rather than assembled from a template.
  // `i18n/key-typing.test.ts` is a shrink-only ledger of the sites that hand the translator a
  // computed key, and a new one would have to be added to it — the whole point being that a key
  // built by string concatenation cannot be checked against the catalogue at all.
  const outcomeLabel = (view: InterventionView) => {
    switch (view.outcome) {
      case "deny":
        return language.t("policies.session.outcome.deny")
      case "halt":
        return language.t("policies.session.outcome.halt")
      case "patch":
        return language.t("policies.session.outcome.patch")
      case "approve":
        return language.t("policies.session.outcome.approve")
      case "context":
        return language.t("policies.session.outcome.context")
      case "allow":
        return language.t("policies.session.outcome.allow")
      case "unknown":
        return language.t("policies.session.outcome.unknown", { decision: view.rawDecision })
    }
  }
  const ranLabel = (view: InterventionView) =>
    view.ran === undefined
      ? language.t("policies.session.unknownRan")
      : view.ran
        ? language.t("policies.session.ran")
        : language.t("policies.session.prevented")

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
          <Icon name="info" size="normal" class="text-v2-icon-icon-muted" />
          <span class="grow truncate text-[15px] font-semibold text-v2-text-text-base">
            {sessionTitle(props.session.title) || props.session.id}
          </span>
        </div>
        <div class="flex flex-col pt-1">
          <Row label={language.t("session.info.folder")} value={props.session.location.directory} mono />
          <Show when={project()}>
            {(summary) => (
              <div data-component="session-info-project" class="flex items-baseline gap-3 py-1.5">
                <span class="w-28 shrink-0 text-[12px] text-v2-text-text-faint [font-weight:470]">
                  {language.t(PROJECT_DETAIL_LABELS.section)}
                </span>
                <div class="min-w-0 flex-1">
                  <ProjectDetail summary={summary()} />
                </div>
              </div>
            )}
          </Show>
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
          {/* 🔴 Rendered whenever the receipt could be read AT ALL — including when nothing
              intervened, because "every check allowed every tool call, in time" is a positive
              statement and the only one this feature can make. Hiding the section when the list is
              empty would trade that claim for silence, which is what the whole thing exists to
              stop. The ONE case that renders nothing is a chat with no attempt yet: nothing has run,
              so no intervention can have been suppressed. A read that FAILED says so instead — see
              `classifyReceipt`. */}
          <Show when={policyPanel() !== undefined && policyPanel()!.state !== "absent"}>
            <div class="mt-2 border-t border-v2-border-border-base pt-2" data-slot="session-info-policies">
              <div class="flex items-baseline justify-between py-1.5">
                <span class="text-[12px] text-v2-text-text-faint [font-weight:470]">
                  {language.t("policies.session.title")}
                </span>
                <Show when={policyViews().length > 0}>
                  <span class="text-[12px] text-v2-text-text-muted">
                    {policyViews().length === 1
                      ? language.t("policies.session.summary.one")
                      : language.t("policies.session.summary.many", { count: policyViews().length })}
                  </span>
                </Show>
              </div>
              {/* 🔴 The read FAILED: we know nothing about this chat's interventions, and the copy
                  says exactly that instead of the reassuring sentence below it. Spelling this the
                  same way as "nothing stepped in" would be the product asserting a clean bill of
                  health it never obtained. */}
              <Show when={policyPanel()!.state === "unreadable"}>
                <p class="pb-1 text-[12px] leading-snug text-v2-text-text-faint">
                  {language.t("policies.session.unavailable")}
                </p>
              </Show>
              <Show
                when={policyViews().length > 0}
                fallback={
                  <Show when={policyPanel()!.state === "list"}>
                    <p class="pb-1 text-[12px] leading-snug text-v2-text-text-faint">
                      {language.t("policies.session.none")}
                    </p>
                  </Show>
                }
              >
                <For each={policyViews()}>
                    {(view) => (
                      <div class="flex flex-col gap-0.5 py-1.5" data-slot="session-info-policy">
                        <div class="flex items-center gap-2">
                          <span class="text-[13px] text-v2-text-text-base [font-weight:470]">
                            {outcomeLabel(view)}
                          </span>
                          <span class="font-mono text-[12px] text-v2-text-text-muted">{view.tool}</span>
                          <span class="min-w-0 flex-1 truncate text-right text-[12px] text-v2-text-text-faint">
                            {ranLabel(view)}
                          </span>
                        </div>
                        {/* The policy's OWN sentence — the same words the model was given, so the
                            two readers of one event cannot be told different things. */}
                        <p class="text-[12px] leading-snug text-v2-text-text-muted">{view.detail}</p>
                        <Show when={view.patched.length > 0}>
                          <div class="pt-0.5">
                            <div class="text-[11px] text-v2-text-text-faint">
                              {language.t("policies.session.patched.title")}
                            </div>
                            <For each={view.patched}>
                              {(field) => (
                                <pre
                                  data-slot="session-info-policy-patch"
                                  class="mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-v2-text-text-base"
                                >
                                  {field.field}: {field.value}
                                </pre>
                              )}
                            </For>
                          </div>
                        </Show>
                        <Show when={view.actedBy.length > 0}>
                          <div class="text-[11px] text-v2-text-text-faint">
                            {language.t("policies.session.acted", { ids: view.actedBy.join(", ") })}
                          </div>
                        </Show>
                        {/* 🔴 The policies that said NOTHING are listed too. A panel naming only the
                            one that acted cannot answer "was the other guard even running?", which
                            is the question a person asks after something got through. */}
                        <Show when={view.silent.length > 0}>
                          <div class="text-[11px] text-v2-text-text-faint">
                            {language.t("policies.session.silent", { ids: view.silent.join(", ") })}
                          </div>
                        </Show>
                        <Show when={view.unavailable.length > 0}>
                          <div class="text-[11px] text-v2-text-text-faint">
                            {language.t("policies.session.unavailableProviders", {
                              ids: view.unavailable.join(", "),
                            })}
                          </div>
                        </Show>
                        <Show when={view.unresolved.length > 0}>
                          <div class="text-[11px] text-v2-text-text-faint">
                            {language.t("policies.session.unresolved", { ids: view.unresolved.join(", ") })}
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
              </Show>
            </div>
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
                    <ButtonV2
                      variant="ghost"
                      type="button"
                      data-action="session-info-prompt-clear"
                      onClick={() => savePromptOverride(null)}
                    >
                      {language.t("common.clear")}
                    </ButtonV2>
                  </Show>
                  <Show when={promptDirty()}>
                    <ButtonV2
                      variant="gold"
                      type="button"
                      data-action="session-info-prompt-save"
                      onClick={() => savePromptOverride(promptValue().trim() === "" ? null : promptValue())}
                    >
                      {language.t("common.save")}
                    </ButtonV2>
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
                        <span class="font-mono text-[12px] text-v2-text-text-base [font-weight:470]">
                          {recipe.name}
                        </span>
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
                          <ButtonV2
                            variant="ghost"
                            type="button"
                            data-action="session-info-adhoc-promote"
                            onClick={() => promoteRecipe(recipe.name)}
                          >
                            {language.t("session.info.adhoc.promote")}
                          </ButtonV2>
                        </Show>
                        <ButtonV2
                          variant="ghost"
                          type="button"
                          data-action="session-info-adhoc-discard"
                          onClick={() => discardRecipe(recipe.name)}
                        >
                          {language.t("session.info.adhoc.discard")}
                        </ButtonV2>
                      </div>
                      <details class="text-[12px] text-v2-text-text-faint">
                        <summary class="cursor-pointer select-none">{language.t("session.info.adhoc.manual")}</summary>
                        <pre class="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-v2-text-text-base">
                          {recipe.manual}
                        </pre>
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
