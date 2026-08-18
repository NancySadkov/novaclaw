import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { GoldGlyph } from "@/components/gold-glyph"
import { useLanguage, type TranslationKey, type Translator } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { AppPage } from "@/components/app-page"
import {
  filterViews,
  sortViews,
  toView,
  type AgentLike,
  type Enablement,
  type MentionTopic,
  type Origin,
  type SkillContext,
  type SkillInfo,
  type SkillView,
} from "@/apps/skills"

// The Skills app — the browsable half of the Skills programme (`todo/skills.md`).
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
export function SkillDetail(props: { view: SkillView; t: Translator }) {
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
            <span class={`${CHIP} bg-v2-background-bg-layer-02 text-v2-text-text-muted`}>{t("skills.badge.slash")}</span>
          </Show>
        </div>
      </div>

      {/* ── 1. Our voice, first and in plain words. The one paragraph a non-expert must read. ── */}
      <section class="rounded-lg border border-v2-border-border-focus bg-v2-background-bg-layer-02 p-3">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-accent">
          {t("skills.what.title")}
        </h2>
        <p class="mt-1.5 text-sm text-v2-text-text-base">{t("skills.what.mechanism")}</p>
        <p class="mt-1.5 text-sm text-v2-text-text-base">{t("skills.what.powers")}</p>
        <p class="mt-1.5 text-sm text-v2-text-text-muted" data-slot="skill-authorship-warning">
          {t("skills.what.authorship")}
        </p>
      </section>

      {/* ── 2. Where it came from — the ONLY section that is our observation. ── */}
      <section class={CARD} data-slot="skill-origin">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-faint">{t("skills.origin.title")}</h2>
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
              fallback={<p class="mt-1 text-xs text-v2-text-text-muted">{t("skills.origin.downloaded.noCandidates")}</p>}
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
  const sources = createMemo(() => ((sync().data.config as { skills?: string[] } | undefined)?.skills ?? []) as string[])
  const context = createMemo<SkillContext>(() => ({ paths: paths(), sources: sources() }))

  const [skills, { refetch }] = createResource(
    () => sdk(),
    async (client) => {
      const response = await client.client.v2.skill.list()
      return (response.data?.data ?? []) as SkillInfo[]
    },
    { initialValue: [] as SkillInfo[] },
  )

  // Enablement is the `skill` permission action evaluated per AGENT (core/src/skill.ts →
  // `available`). Failure is answered with `undefined`, which `describeEnablement` reports as
  // "unknown" — a guess here would be a guess about a safety gate.
  const [agents] = createResource(
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

  const views = createMemo(() => sortViews(skills().map((skill) => toView(skill, context(), agents()))))
  const shown = createMemo(() => filterViews(views(), query()))
  const current = createMemo(() => views().find((view) => view.key === selected()))

  return (
    <AppPage class="flex flex-col overflow-hidden">
      <div class="flex items-center gap-3 border-b border-v2-border-border-base px-4 py-2.5">
        <GoldGlyph name="generic_app" class="size-6" />
        <span class="text-[15px] font-semibold">{t("skills.title")}</span>
        <span class="min-w-0 flex-1 truncate text-xs text-v2-text-text-faint">{t("skills.tagline")}</span>
        <button
          class="rounded-md border border-v2-border-border-strong bg-v2-background-bg-layer-02 px-3 py-1.5 text-sm font-medium hover:bg-v2-background-bg-layer-03"
          onClick={() => void refetch()}
        >
          {t("skills.action.refresh")}
        </button>
      </div>

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
            <Show
              when={shown().length}
              fallback={
                <div class="p-2 text-sm text-v2-text-text-muted" data-slot="skills-empty">
                  {skills().length === 0 ? t("skills.empty.none") : t("skills.empty.filtered")}
                </div>
              }
            >
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
            </Show>
          </div>
          <div class="border-t border-v2-border-border-base p-2">
            <div class="text-[11px] font-semibold uppercase tracking-wide text-v2-text-text-faint">
              {t("skills.sources.title")}
            </div>
            <Show
              when={sources().length}
              fallback={<div class="mt-0.5 text-[11px] text-v2-text-text-muted">{t("skills.sources.none")}</div>}
            >
              <ul class="mt-0.5 flex flex-col gap-0.5 text-[11px] break-all text-v2-text-text-muted">
                <For each={sources()}>{(source) => <li>{source}</li>}</For>
              </ul>
            </Show>
            <div class="mt-1 text-[11px] text-v2-text-text-faint">{t("skills.sources.note")}</div>
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
                <SkillDetail view={view()} t={t} />
              </div>
            )}
          </Show>
        </div>
      </div>
    </AppPage>
  )
}
