// ⚠️ `Switch as SolidSwitch`: this file's `Switch` is the UI toggle control, imported below. Solid's
// control-flow component has to be renamed rather than the other way round — the toggle is used in
// JSX throughout the page, and renaming it would touch code this change has no business in.
import { createMemo, createResource, createSignal, For, Match, Show, Switch as SolidSwitch } from "solid-js"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { useLanguage, type TranslationKey, type Translator } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { AppPage, AppPageHeader } from "@/components/app-page"
import { SettingsExplainV2 } from "@/components/settings-v2/explain"
import { createSettledResource } from "@/utils/settled-resource"
import { createListState } from "@/utils/list-state"
import {
  authorText,
  filterViews,
  sortViews,
  toView,
  type AgentLike,
  type PermissionRule,
  type Enablement,
  type MentionTopic,
  type Origin,
  type SkillContext,
  type SkillInfo,
  type SkillView,
} from "@/apps/skills"
import {
  forgetPath,
  invocationOf,
  invocationWrite,
  ONLY_WHEN_I_CHOOSE,
  orphanedChoices,
  type InvocationView,
} from "@/apps/skill-invocation"
import { SkillInvocation } from "@novaclaw/core/skill/invocation"
import { scopedDirectory } from "@/utils/routing-directory"

// The Skills app — the browsable half of the Skills programme.
//
// A skill is code-shaped input from somewhere else that changes what your agent will do, so the
// question this page has to answer for a NON-EXPERT, before anything technical, is the one they
// actually have: *what does turning this on let it do, and who wrote it?* (AGENTS.md → "Teach,
// don't gatekeep"; a raw manifest dump is the thing we are not.)
//
// ⚠️ **Capability disclosure here is a SAFETY surface, not a spec sheet.** Two rules run through
// every section below and must survive any edit:
//   1. **Our observations and the author's claims are visually and verbally separated.** "Where it
//      came from" is something NovaClaw looked at. Everything else on the page is the skill
//      describing itself, and the page says so in words rather than implying it by layout.
//   2. **An empty declaration is never rendered as a clean bill of health.** The skill format has
//      no capability field and no compatibility field at all (`packages/schema/src/skill.ts`), so
//      those sections say *the format cannot express this* — because a blank "Capabilities: none"
//      panel reads as "harmless", which is the exact lie this surface must not tell.
//
// The presentation logic lives in `@/apps/skills` so every state — enabled, denied, undescribed,
// unplaceable, hostile — is unit-testable without mounting anything.

const CARD = "rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3"
const CHIP = "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"

/** The topics `scanMentions` groups words under, in the order they are shown. */
const TOPICS: readonly MentionTopic[] = ["run", "modify", "install", "network", "secrets"]

// ⚠️ Every key below is a LITERAL, spelled out per union member rather than assembled from a
// template. `i18n/key-typing.test.ts` is a shrink-only ledger of every site that hands the
// translator a key the compiler cannot check, and a `skills.origin.${kind}.badge` template is
// exactly such a site. Narrowing the source is the sanctioned remedy (it closed 17 of the original
// 19 casts), so these four tables are the narrowing: a missing or misspelled key is a compile error.
const ORIGIN_BADGE = {
  downloaded: "skills.origin.downloaded.badge",
  instance: "skills.origin.instance.badge",
  configured: "skills.origin.configured.badge",
  local: "skills.origin.local.badge",
} as const satisfies Record<Origin["kind"], TranslationKey>

const ORIGIN_TEXT = {
  downloaded: "skills.origin.downloaded.text",
  instance: "skills.origin.instance.text",
  configured: "skills.origin.configured.text",
  local: "skills.origin.local.text",
} as const satisfies Record<Origin["kind"], TranslationKey>

const TOPIC_LABEL = {
  run: "skills.mentions.topic.run",
  modify: "skills.mentions.topic.modify",
  install: "skills.mentions.topic.install",
  network: "skills.mentions.topic.network",
  secrets: "skills.mentions.topic.secrets",
} as const satisfies Record<MentionTopic, TranslationKey>

// Same narrowing discipline as the four tables above: a literal per union member, so a missing or
// misspelled key is a compile error rather than a runtime blank.
const IN_FORCE_TEXT = {
  everywhere: "skills.invocation.inForce.everywhere",
  "only-when-i-choose": "skills.invocation.inForce.onlyWhenIChoose",
  "only-nova": "skills.invocation.inForce.onlyNova",
  nowhere: "skills.invocation.inForce.nowhere",
} as const satisfies Record<SkillInvocation.Preset, TranslationKey>

const LOCKED_TEXT = {
  empty: "skills.invocation.locked.empty",
  "too-long": "skills.invocation.locked.tooLong",
  invisible: "skills.invocation.locked.invisible",
  wildcard: "skills.invocation.locked.wildcard",
  unnormalized: "skills.invocation.locked.unnormalized",
} as const satisfies Record<SkillInvocation.UnaddressableReason, TranslationKey>

const ENABLEMENT_TEXT = {
  unknown: "skills.enablement.unknown",
  open: "skills.enablement.open",
  asks: "skills.enablement.asks",
  mixed: "skills.enablement.mixed",
  blocked: "skills.enablement.blocked",
} as const satisfies Record<Enablement["state"], TranslationKey>

// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The detail pane. Deliberately CONTEXT-FREE — it takes a finished `SkillView` and a translator, so
 * `skills.test.ts` can render it under happy-dom and assert that a skill named `<img onerror=…>`
 * reaches the DOM as text. Every string that came from the skill arrives here already flattened by
 * `authorText`/`authorBody`; Solid escapes it, and this component never builds markup from it.
 */
export function SkillDetail(props: {
  view: SkillView
  t: Translator
  /** Absent while the config has not loaded — the section is then not drawn at all rather than
   *  drawn with a guessed position, because a switch showing the wrong state is worse than none. */
  invocation?: InvocationView
  onInvocation?: (next: { nova: boolean; me: boolean }) => void
  saveFailed?: boolean
  // 🗑️ `projectFile`, `folderWrite`, `onFolderHide`, `folderRefused` and `folderSaveFailed` stood here:
  // the props of the folder-hide control, and the file it named. They went with the `novaclaw.json`
  // mechanism (owner, 2026-09-16), so this component takes nothing about a folder.
}) {
  const t: Translator = (key, params) => props.t(key, params)
  const view = () => props.view

  return (
    <div class="flex flex-col gap-4" data-component="skill-detail">
      <div>
        <h1 class="text-lg font-semibold break-words" data-slot="skill-name">
          {view().name}
        </h1>
        <div class="mt-1 flex flex-wrap items-center gap-1.5">
          <span
            class={`${CHIP} ${view().remote ? "bg-v2-background-bg-layer-03 text-v2-text-text-accent" : "bg-v2-background-bg-layer-02 text-v2-text-text-muted"}`}
            data-slot="skill-origin-badge"
          >
            {t(ORIGIN_BADGE[view().origin.kind])}
          </span>
          <Show when={view().slash}>
            <span class={`${CHIP} bg-v2-background-bg-layer-02 text-v2-text-text-muted`}>
              {t("skills.badge.slash")}
            </span>
          </Show>
        </div>
      </div>

      {/* ── 1. Our voice, first and in plain words. The one paragraph a non-expert must read. ── */}
      <section class="rounded-lg border border-v2-border-border-focus bg-v2-background-bg-layer-02 p-3">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-accent">{t("skills.what.title")}</h2>
        <p class="mt-1.5 text-sm text-v2-text-text-base">{t("skills.what.mechanism")}</p>
        <p class="mt-1.5 text-sm text-v2-text-text-base">{t("skills.what.powers")}</p>
        <p class="mt-1.5 text-sm text-v2-text-text-muted" data-slot="skill-authorship-warning">
          {t("skills.what.authorship")}
        </p>
      </section>

      {/* ── 2. Where it came from — the ONLY section that is our observation. ── */}
      <section class={CARD} data-slot="skill-origin">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-faint">
          {t("skills.origin.title")}
        </h2>
        <p class="mt-1.5 text-sm text-v2-text-text-base">{t(ORIGIN_TEXT[view().origin.kind])}</p>
        <Show when={view().origin.kind === "configured" && view().origin}>
          {(origin) => (
            <p class="mt-1 text-xs break-all text-v2-text-text-muted">
              {t("skills.origin.configured.source", { source: (origin() as { source: string }).source })}
            </p>
          )}
        </Show>
        <Show when={view().origin.kind === "downloaded" && (view().origin as { candidates: readonly string[] })}>
          {(origin) => (
            <Show
              when={origin().candidates.length > 0}
              fallback={
                <p class="mt-1 text-xs text-v2-text-text-muted">{t("skills.origin.downloaded.noCandidates")}</p>
              }
            >
              <p class="mt-1 text-xs text-v2-text-text-muted">{t("skills.origin.downloaded.candidates")}</p>
              <ul class="mt-0.5 list-disc pl-4 text-xs break-all text-v2-text-text-muted">
                <For each={origin().candidates}>{(url) => <li>{url}</li>}</For>
              </ul>
            </Show>
          )}
        </Show>
        <p class="mt-2 text-xs text-v2-text-text-faint">{t("skills.origin.folder")}</p>
        <p class="text-xs break-all select-all text-v2-text-text-muted" data-slot="skill-folder">
          {view().folder}
        </p>
        <p class="mt-1 text-[11px] text-v2-text-text-faint">{t("skills.origin.folderNote")}</p>
      </section>

      {/* ── 3. The author's own words, labelled as such. ── */}
      <section class={CARD} data-slot="skill-selfdescription">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-faint">
          {t("skills.description.title")}
        </h2>
        <Show
          when={view().hasDescription}
          fallback={
            <p class="mt-1.5 text-sm text-v2-text-text-muted" data-slot="skill-no-description">
              {t("skills.description.none")}
            </p>
          }
        >
          <p class="mt-1.5 text-sm break-words text-v2-text-text-base" data-slot="skill-description">
            {view().description}
          </p>
        </Show>
        <p class="mt-1.5 text-[11px] text-v2-text-text-faint">{t("skills.description.note")}</p>
      </section>

      {/* ── 4. Capabilities: the format has no field, and saying so IS the disclosure. ── */}
      <section class={CARD} data-slot="skill-capabilities">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-faint">
          {t("skills.capabilities.title")}
        </h2>
        <p class="mt-1.5 text-sm text-v2-text-text-base" data-slot="skill-capabilities-undeclared">
          {t("skills.capabilities.undeclared")}
        </p>

        <div class="mt-3">
          <h3 class="text-[11px] font-semibold uppercase tracking-wide text-v2-text-text-faint">
            {t("skills.mentions.title")}
          </h3>
          <Show
            when={view().mentions.length > 0}
            fallback={
              <p class="mt-1 text-sm text-v2-text-text-muted" data-slot="skill-mentions-none">
                {t("skills.mentions.none")}
              </p>
            }
          >
            <ul class="mt-1 flex flex-col gap-1.5" data-slot="skill-mentions">
              <For each={TOPICS.filter((topic) => view().mentions.some((m) => m.topic === topic))}>
                {(topic) => {
                  const mention = () => view().mentions.find((m) => m.topic === topic)!
                  return (
                    <li class="text-sm">
                      {/* The separator is real TEXT, not margin: copied or read aloud, a bare
                          margin made this "Running programssudo (1)". */}
                      <span class="text-v2-text-text-base">{t(TOPIC_LABEL[topic])}</span>
                      <span class="text-v2-text-text-base">{": "}</span>
                      <span class="text-xs text-v2-text-text-muted">
                        {mention()
                          .terms.map((hit) => `${hit.term} (${hit.count})`)
                          .join(" · ")}
                      </span>
                    </li>
                  )
                }}
              </For>
            </ul>
          </Show>
          <p class="mt-1.5 text-[11px] text-v2-text-text-faint" data-slot="skill-mentions-caveat">
            {t("skills.mentions.caveat")}
          </p>
        </div>
      </section>

      {/* ── 5. Compatibility: also unexpressible in this format. ── */}
      <section class={CARD} data-slot="skill-compatibility">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-faint">
          {t("skills.compatibility.title")}
        </h2>
        <p class="mt-1.5 text-sm text-v2-text-text-base">{t("skills.compatibility.undeclared")}</p>
      </section>

      {/* ── 6. Who may open it — the engine's ONE gate, reported read-only. ── */}
      <section class={CARD} data-slot="skill-enablement">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-faint">
          {t("skills.enablement.title")}
        </h2>
        <p class="mt-1.5 text-sm text-v2-text-text-base" data-slot="skill-enablement-state">
          {view().enablement.state === "unknown"
            ? t("skills.enablement.unknown")
            : t(ENABLEMENT_TEXT[view().enablement.state], {
                allow: (view().enablement as { allow: number }).allow,
                ask: (view().enablement as { ask: number }).ask,
                deny: (view().enablement as { deny: number }).deny,
              })}
        </p>
        <p class="mt-1.5 text-xs text-v2-text-text-muted">{t("skills.enablement.noSwitch")}</p>
      </section>

      {/* ── 6b. The two switches. AFTER provenance, self-description, capabilities and permission,
              deliberately: the question "when should this be offered?" is only answerable once the
              reader knows where it came from and what NovaClaw cannot tell them about it, and
              `skills.invocation.unknowns` restates that at the bottom of the section rather than
              letting a pair of switches imply the page has vetted anything. ── */}
      <Show when={props.invocation}>
        {(invocation) => (
          <section
            class="rounded-lg border border-v2-border-border-focus bg-v2-background-bg-layer-02 p-3"
            data-slot="skill-invocation"
          >
            <h2 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-accent">
              {t("skills.invocation.title")}
            </h2>

            {/* Principle 12(d): what is in force RIGHT NOW, before any control. */}
            <p class="mt-1.5 text-sm text-v2-text-text-base" data-slot="skill-invocation-inforce">
              {t(IN_FORCE_TEXT[invocation().inForce])}
            </p>

            {/* 🗑️ A THIRD sentence stood here, naming the folder's `novaclaw.json` as the layer that
                keeps this skill out of the slash menu — separate from the two switches above because
                neither switch can reach it, and separate from the fault line because a user told only
                "it is not in your slash menu" goes looking for the switch that did it, finds it
                reading "on", and has nowhere left to look. It went with the mechanism
                (owner, 2026-09-16): nothing between the user's switch and the menu exists now. */}
            <Show when={invocation().blockedElsewhere}>
              <p class="mt-1.5 text-sm text-v2-text-text-accent" data-slot="skill-invocation-blocked-elsewhere">
                {t("skills.invocation.blockedElsewhere")}
              </p>
            </Show>

            <Show
              when={invocation().locked === undefined}
              fallback={
                <div
                  class="mt-2 rounded-md border border-v2-border-border-base p-2"
                  data-slot="skill-invocation-locked"
                >
                  <p class="text-xs font-semibold text-v2-text-text-base">{t("skills.invocation.locked.title")}</p>
                  <p class="mt-1 text-sm text-v2-text-text-muted" data-slot="skill-invocation-locked-reason">
                    {t(LOCKED_TEXT[invocation().locked!], { max: SkillInvocation.MAX_ID_LENGTH })}
                  </p>
                </div>
              }
            >
              <div class="mt-3 flex flex-col gap-3">
                <div data-slot="skill-invocation-nova">
                  <Switch
                    checked={invocation().nova}
                    onChange={(checked) => props.onInvocation?.({ nova: checked, me: invocation().me })}
                  >
                    {t("skills.invocation.nova.label")}
                  </Switch>
                  <p class="mt-1 text-xs text-v2-text-text-muted">{t("skills.invocation.nova.help")}</p>
                </div>

                <div data-slot="skill-invocation-me">
                  <Switch
                    checked={invocation().me}
                    onChange={(checked) => props.onInvocation?.({ nova: invocation().nova, me: checked })}
                  >
                    {t("skills.invocation.me.label")}
                  </Switch>
                  <p class="mt-1 text-xs text-v2-text-text-muted">{t("skills.invocation.me.help")}</p>
                </div>

                {/* The preset is a WRITE of both switches. It is a button rather than a third
                    radio option precisely so the pair above stays the state of record. */}
                <div>
                  <button
                    class="rounded-md border border-v2-border-border-strong bg-v2-background-bg-layer-01 px-3 py-1.5 text-sm font-medium hover:bg-v2-background-bg-layer-03 disabled:opacity-50"
                    data-slot="skill-invocation-preset"
                    disabled={invocation().isOnlyWhenIChoose}
                    onClick={() => props.onInvocation?.({ ...ONLY_WHEN_I_CHOOSE })}
                  >
                    {t("skills.invocation.preset.onlyWhenIChoose")}
                  </button>
                  <p class="mt-1 text-xs text-v2-text-text-muted">
                    {invocation().isOnlyWhenIChoose
                      ? t("skills.invocation.preset.applied")
                      : t("skills.invocation.preset.help")}
                  </p>
                </div>

                {/* 🗑️ THE THIRD LAYER stood here: one switch, one direction of force, writing
                    `{"<id>":{"show":false}}` into the folder's `novaclaw.json` (on) or deleting that
                    line (off, meaning inherit), with the withheld case and the "a folder may hide and
                    may never un-hide" law stated at the control. It went with the mechanism
                    (owner, 2026-09-16), and with it the sentence that said a folder can never
                    ``show it here'': there is no folder layer left to say anything. */}
                <p class="text-xs text-v2-text-text-faint" data-slot="skill-invocation-independent">
                  {t("skills.invocation.independent")}
                </p>
              </div>
            </Show>

            <Show when={props.saveFailed}>
              <p class="mt-2 text-sm text-v2-text-text-accent" data-slot="skill-invocation-error">
                {t("skills.invocation.error")}
              </p>
            </Show>

            {/* One line, with the caveat on demand (uix.md §1.4). The sentence still refuses to let a
                pair of switches imply the page has vetted anything — which is what this paragraph was
                always for — while the four-clause account of what NovaClaw cannot know is a tap away. */}
            <p class="mt-3 text-[11px] text-v2-text-text-faint" data-slot="skill-invocation-unknowns">
              {t("skills.invocation.unknowns")}
              <SettingsExplainV2 label={t("skills.invocation.title")}>
                {t("skills.invocation.unknowns.detail")}
              </SettingsExplainV2>
            </p>
          </section>
        )}
      </Show>

      {/* ── 7. The instructions themselves. Last because it is the long thing, not the least. ── */}
      <section class={CARD} data-slot="skill-instructions">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-faint">
          {t("skills.instructions.title")}
        </h2>
        <p class="mt-1 text-[11px] text-v2-text-text-faint">{t("skills.instructions.note")}</p>
        <pre
          class="mt-1.5 max-h-[420px] overflow-auto rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-02 p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-v2-text-text-muted"
          data-slot="skill-body"
        >
          {view().body || t("skills.instructions.empty")}
        </pre>
      </section>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function SkillsPage() {
  const language = useLanguage()
  const t: Translator = (key, params) => language.t(key, params)
  const sdk = useServerSDK()
  const sync = useServerSync()

  // `/path` carries `cache` and `config`; the generated `Path` type lags the fields the server
  // actually sends, so the same cast Settings → Storage uses applies here.
  const paths = createMemo(() => (sync().data.path ?? {}) as { cache?: string; config?: string })
  const sources = createMemo(
    () => ((sync().data.config as { skills?: string[] } | undefined)?.skills ?? []) as string[],
  )
  const context = createMemo<SkillContext>(() => ({ paths: paths(), sources: sources() }))

  /**
   * 🔴 This read had BOTH halves of the failure wrong at once, and the correct treatment was
   * already in this file — the `agents` read below and the `project` read further down each name
   * their own fault, with a comment explaining why.
   *
   * ⚠️ The generated SDK does not throw on a non-2xx: it returns `{ data: undefined, error }` unless
   * the caller asked for `throwOnError`. So `response.data?.data ?? []` turned every server-side
   * failure into an empty skill list and the page said *"No skills yet"* over skills that are
   * installed — while a TRANSPORT failure took the other route and threw from the accessor, because
   * `initialValue: []` does not make a read safe.
   */
  const [skillRows, { refetch }] = createSettledResource(
    () => sdk(),
    async (client) => {
      const response = await client.client.v2.skill.list()
      if (response.error) throw response.error
      return (response.data?.data ?? []) as SkillInfo[]
    },
  )
  const skills = (): SkillInfo[] => skillRows() ?? []
  const skillListing = createListState<SkillInfo>(skillRows)

  // Enablement is the `skill` permission action evaluated per AGENT (core/src/skill.ts →
  // `available`). Failure is answered with `undefined`, which `describeEnablement` reports as
  // "unknown" — a guess here would be a guess about a safety gate.
  const [agents, { refetch: refetchAgents }] = createResource(
    () => sdk(),
    async (client) => {
      try {
        const response = await client.client.v2.agent.list()
        return (response.data?.data ?? []) as AgentLike[]
      } catch {
        return undefined
      }
    },
  )

  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<string | undefined>()
  const [saveFailed, setSaveFailed] = createSignal(false)

  // The two halves of the invocation state, read from the SAME config document the write patches.
  // The generated `Config` type lags both fields, so the same cast the rest of this page uses
  // applies. `permissions` is the instance ruleset `config/plugin/agent.ts` folds into every agent.
  const config = createMemo(
    () =>
      (sync().data.config ?? {}) as {
        permissions?: PermissionRule[]
        skill_invocation?: SkillInvocation.Store
      },
  )
  const rules = createMemo(() => config().permissions ?? [])
  const choices = createMemo(() => config().skill_invocation)

  /**
   * The THIRD layer: the `novaclaw.json` governing the folder this instance is pointed at.
   *
   * ⚠️ Fetched from `GET /api/project`, which already applies the narrowing — a folder may HIDE a
   * skill and may never un-hide one you hid, so `skills` is a list of what the folder hides. This
   * page must not re-derive that law; one derivation of a security rule is the right number.
   *
   * ⚠️ Failure degrades to `undefined`, never a throw. A throw inside a `createResource` read reaches
   * the ROOT ErrorBoundary and replaces the whole application (the same rule Settings → Project
   * records), and a project lookup that failed must not cost someone the Skills page. `undefined`
   * renders no third sentence, which is honest: this page has not been told, so it claims nothing.
   */
  const server = useServer()
  // 🗑️ `projectSource`, the `project` resource over `GET /api/project`, `projectHidden`, `projectFile`,
  // `folderWrite`, `folderRefused`, `folderSaveFailed` and `applyFolderHide` all stood here: the page's
  // read of the folder's declaration, what it hides, and the one write that could change it. The
  // mechanism is retired (owner, 2026-09-16), so the page reads nothing about a folder and the two
  // switches below are the whole surface.
  const views = createMemo(() => sortViews(skills().map((skill) => toView(skill, context(), agents()))))
  const shown = createMemo(() => filterViews(views(), query()))
  const current = createMemo(() => views().find((view) => view.key === selected()))

  const invocation = createMemo(() => {
    const view = current()
    if (!view) return undefined
    return invocationOf({
      name: view.rawName,
      rules: rules(),
      store: choices(),
      enablement: view.enablement,
    })
  })

  // Saved choices naming a skill this instance no longer has. Computed over the RAW names, because
  // that is what an id is — see `@novaclaw/core/skill/invocation`.
  const orphans = createMemo(() =>
    orphanedChoices(
      choices(),
      views().map((view) => view.rawName),
    ),
  )

  // `POST /api/config/remove` — the deletion verb. `PATCH /config` merges and can never delete
  // (v0.2.0 item 4.3), so clearing a saved choice cannot ride the patch.
  const removeConfig = async (paths: readonly (readonly string[])[]) => {
    const client = sdk()
    if (!client) throw new Error("no server connection")
    await client.client.v2.config.remove({ configRemoveRequest: { paths: paths as string[][] } })
  }

  // ⚠️ Both switches ride ONE patch. A clear needs the second verb, and it is sent AFTER — so a
  // failure there leaves the permission half applied and the menu half where it was, which the
  // banner reports and the re-read shows. There is no way to make the pair atomic across two
  // routes; what is avoidable is a SILENT half-application, and that is what the banner covers.
  const write = (patch: Record<string, unknown>, remove: readonly (readonly string[])[] = []) => {
    setSaveFailed(false)
    void (async () => {
      await (sync().updateConfig(patch as never) as Promise<unknown>)
      // ⚠️ "Who can use it" is computed from `/api/agent`, and the instance ruleset is folded into
      // every agent at materialisation time — so a `permissions` write changes that answer and
      // nothing here was re-reading it. Measured live 2026-08-18: turning "Nova may choose this"
      // back ON left the section still reading "Every one of your agents refuses this skill", which
      // is ruling 2's *a fault is never described falsely* on the very sentence the switch moves.
      void refetchAgents()
      if (remove.length === 0) return
      await removeConfig(remove)
      // ⚠️ `updateConfig` refetches on success; the REMOVE verb is a different route and nothing
      // watches it. Without this the switch stays where it was while the server has already moved —
      // measured live 2026-08-18: the preset cleared the row, `/config` agreed, and the page still
      // read "Right now: neither". `refetchConfig` exists for exactly this ("something OTHER than
      // updateConfig wrote it").
      await (sync().refetchConfig() as Promise<unknown>)
    })().catch(() => setSaveFailed(true))
  }

  const applyInvocation = (next: { nova: boolean; me: boolean }) => {
    const view = current()
    if (!view) return
    const plan = invocationWrite({ name: view.rawName, rules: rules(), store: choices(), next })
    // `undefined` means the name has no stable id. The switches are not drawn in that case, so this
    // is unreachable from the UI — it is here because "silently do nothing" is the one outcome a
    // control may never have.
    if (!plan) {
      setSaveFailed(true)
      return
    }
    write(plan.patch, plan.remove)
  }

  /**
   * The FOLDER half — a different file, a different route, and deliberately a different handler.
   *
   * ⚠️ `POST /api/project` is section-scoped: it replaces `skills` WHOLE and leaves every other
   * section of the file untouched, which is why the payload is rebuilt from what the read reported
   * rather than patched. `apps/project-skills.ts` owns that reconstruction and the law it obeys.
   *
   * ⚠️ A refusal arrives as a 200 body (`ok:false`), never as a thrown error — the same posture
   * `projectState` takes — so the two are handled separately: `ok:false` is the file's problem and
   * shows the banner, a throw is ours.
   */
  // 🗑️ `applyFolderHide` stood here: the one write this page could make, `POST /api/project` with a
  // `skills` section that hid a skill for this folder (or cleared the line, meaning inherit), plus the
  // refusal banner and the refetch that kept the switch agreeing with the file on disk. It went with the
  // mechanism (owner, 2026-09-16). The two switches above are the whole surface now: the user's own
  // `skill_invocation` store, and nothing beneath it.

  return (
    <AppPage class="flex flex-col overflow-hidden">
      <AppPageHeader glyph="generic_app" title={t("skills.title")} hint={t("skills.tagline")}>
        <button
          class="rounded-md border border-v2-border-border-strong bg-v2-background-bg-layer-02 px-3 py-1.5 text-sm font-medium hover:bg-v2-background-bg-layer-03"
          onClick={() => void refetch()}
        >
          {t("skills.action.refresh")}
        </button>
      </AppPageHeader>

      <div class="flex min-h-0 flex-1 overflow-hidden">
        <div class="flex w-80 shrink-0 flex-col border-r border-v2-border-border-base">
          <div class="p-2">
            <TextInputV2
              type="text"
              class="w-full"
              placeholder={t("skills.search.placeholder")}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <div class="min-h-0 flex-1 overflow-auto px-2 pb-2">
            <SolidSwitch>
              <Match when={skillListing().kind === "failed"}>
                <div class="p-2 text-sm text-v2-state-fg-danger" data-slot="skills-failed">
                  {t("skills.loadFailed")}
                </div>
              </Match>
              <Match when={skillListing().kind === "idle" || skillListing().kind === "loading"}>
                <div class="p-2 text-sm text-v2-text-text-muted">{t("skills.loading")}</div>
              </Match>
              <Match when={shown().length === 0}>
                {/* Two empties: none installed, and none matching the search. A failed read is
                    neither, and it is checked first so it can never wear either sentence. */}
                <div class="p-2 text-sm text-v2-text-text-muted" data-slot="skills-empty">
                  {skills().length === 0 ? t("skills.empty.none") : t("skills.empty.filtered")}
                </div>
              </Match>
              <Match when={shown().length}>
                <For each={shown()}>
                  {(view) => (
                    <button
                      class="mb-1.5 block w-full rounded-md border px-2.5 py-2 text-left transition-colors"
                      classList={{
                        "border-v2-border-border-focus bg-v2-background-bg-layer-02": selected() === view.key,
                        "border-transparent hover:bg-v2-background-bg-layer-01": selected() !== view.key,
                      }}
                      data-slot="skill-row"
                      onClick={() => setSelected(view.key)}
                    >
                      <div class="flex items-center gap-1.5">
                        <span class="min-w-0 flex-1 truncate text-sm font-medium">{view.name}</span>
                        <span
                          class={`${CHIP} shrink-0 ${view.remote ? "bg-v2-background-bg-layer-03 text-v2-text-text-accent" : "bg-v2-background-bg-layer-02 text-v2-text-text-faint"}`}
                        >
                          {t(ORIGIN_BADGE[view.origin.kind])}
                        </span>
                      </div>
                      <div class="mt-0.5 line-clamp-2 text-xs text-v2-text-text-muted">
                        {view.hasDescription ? view.description : t("skills.description.none.short")}
                      </div>
                    </button>
                  )}
                </For>
              </Match>
            </SolidSwitch>
          </div>
          <div class="border-t border-v2-border-border-base p-2">
            {/* ⚠️ "Where NovaClaw looks" USED to stand here as a permanent block: a heading, the list
                of extra source folders, and a two-sentence note — visible on every visit, to every
                user. Removed 2026-08-20 (owner): adding a search path is not a thing a person does.
                The agent installs skills; the person imports or exports a skill file and edits its
                fields. So the list is now a DETAIL, shown only when the user has actually added
                sources, with the explanation on demand rather than under the heading. The sources
                themselves are unchanged — this is what the panel spends its space on, not what the
                product supports. */}
            <Show when={sources().length}>
              <details class="group" data-slot="skill-sources">
                <summary class="cursor-pointer list-none text-[11px] font-semibold uppercase tracking-wide text-v2-text-text-faint hover:text-v2-text-text-muted">
                  {t("skills.sources.title")} ({sources().length})
                </summary>
                <ul class="mt-0.5 flex flex-col gap-0.5 text-[11px] break-all text-v2-text-text-muted">
                  <For each={sources()}>{(source) => <li>{source}</li>}</For>
                </ul>
                <div class="mt-1 text-[11px] text-v2-text-text-faint">{t("skills.sources.note")}</div>
              </details>
            </Show>

            {/* A saved choice whose skill is gone. Shown here rather than on a detail pane because
                there is no skill to open — and KEPT rather than swept, since a source being offline
                is the worst moment to forget what the user decided. */}
            <Show when={orphans().length}>
              <div class="mt-2 border-t border-v2-border-border-base pt-2" data-slot="skill-invocation-orphans">
                <div class="text-[11px] font-semibold uppercase tracking-wide text-v2-text-text-faint">
                  {t("skills.invocation.orphans.title")}
                </div>
                <div class="mt-0.5 text-[11px] text-v2-text-text-muted">{t("skills.invocation.orphans.text")}</div>
                <ul class="mt-1 flex flex-col gap-1">
                  <For each={orphans()}>
                    {(id) => (
                      <li class="flex items-center gap-2">
                        {/* The id came out of a config file, so it reaches the screen through the
                            same flattening every other author-controlled string does. */}
                        <span class="min-w-0 flex-1 truncate text-[11px] text-v2-text-text-muted">
                          {authorText(id, 80) || id}
                        </span>
                        <button
                          class="shrink-0 rounded border border-v2-border-border-base px-1.5 py-0.5 text-[11px] hover:bg-v2-background-bg-layer-03"
                          data-slot="skill-invocation-orphan-forget"
                          onClick={() => write({}, [forgetPath(id)])}
                        >
                          {t("skills.invocation.orphans.forget")}
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>
          </div>
        </div>

        <div class="min-w-0 flex-1 overflow-auto p-4">
          <Show
            when={current()}
            fallback={
              <div class="max-w-2xl text-sm text-v2-text-text-muted" data-slot="skills-intro">
                <p>{t("skills.intro.pick")}</p>
                <p class="mt-2">{t("skills.what.mechanism")}</p>
                <p class="mt-2">{t("skills.what.powers")}</p>
              </div>
            }
          >
            {(view) => (
              <div class="max-w-2xl">
                <SkillDetail
                  view={view()}
                  t={t}
                  invocation={invocation()}
                  onInvocation={applyInvocation}
                  saveFailed={saveFailed()}
                />
              </div>
            )}
          </Show>
        </div>
      </div>
    </AppPage>
  )
}
