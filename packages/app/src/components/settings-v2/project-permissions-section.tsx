import { For, Show, Switch, Match, createMemo, createSignal, type Accessor, type Component } from "solid-js"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { ACTION_LABEL_KEY } from "@/i18n/permission-action-labels"
import { PermissionActions } from "@novaclaw/core/permission-actions"
import { useLanguage, type TranslationKey } from "@/context/language"
import { SettingsExplainV2 } from "./explain"
import type { ServerConnection } from "@/context/server"
import type { ProjectPermissionRule, ProjectState, ProjectWriteResult } from "@/utils/project-api"
import { projectWrite } from "@/utils/project-api"
import {
  gitignoreImport,
  governedHere,
  normalizeRule,
  planProjectPermissions,
  projectExcludePayload,
  pathKey,
  projectPermissionsPayload,
  PROJECT_RULE_EFFECTS,
  ruleIsComplete,
  type ProjectRuleEffect,
} from "./project-permissions"

/**
 * **Settings → Project → the rules this folder adds, beside the two other places rules come from.**
 *
 * The brief: *"make Permissions expose the Project defaults loaded from `novaclaw.json`,
 * distinguish them from personal and session rules, and save Project-default edits back to only the
 * Permissions section."*
 *
 * 🔴 **The question this screen answers is "who refused me", and it has three possible answers that
 * are fixed in three different places.** Before this, a project file could narrow a session's
 * permissions and the only thing anywhere on screen was a COUNT. A user whose tool call was refused
 * could see that four rules governed their folder and never which one, nor whether it was the folder
 * at all rather than their own saved answer or the chat's Mode. So the three origins are three
 * labelled blocks, never one merged list — a merged list would send two thirds of its readers to a
 * screen that cannot help them.
 *
 * ⚠️ **The chat's own rules are NAMED here and not RENDERED here.** They come from the session's
 * Mode overlay and Tuning switches, which the kernel composes in `permission.ts`; rebuilding that
 * list in the renderer would be a second place for the two to disagree about what is in force —
 * exactly the rule the Settings panel already follows about the project's rules and the reason
 * `project-summary.ts` refuses to claim which Tune switches a file supplied. So this block says what
 * the chat contributes and where it is changed, which is what a person needs, and asserts nothing it
 * cannot read.
 *
 * ⚠️ Structure copied from `composer/features-control.tsx`'s `MakeDefaultSection` on purpose: state
 * what governs the folder right now BEFORE the control (principle 12d), preview exactly what will be
 * written, name what will not be written and why, and render a local receipt naming the file.
 */

/** The right-hand value slot, matching the fact rows above it. */
const Muted: Component<{ children: unknown }> = (props) => (
  <span class="text-[12px] leading-4 text-v2-text-text-faint">{props.children as never}</span>
)

const describeRule = (rule: ProjectPermissionRule) => `${rule.action} · ${rule.resource} → ${rule.effect}`

/**
 * The heading each gate group gets in the picker. Named here rather than in `core` because these are
 * SENTENCES for a reader, and every sentence this product shows a person lives in `i18n/en.ts` where
 * a translator can find it. `core` owns which actions exist; this owns what to call them.
 */
const GROUP_LABEL: Record<PermissionActions.Group, TranslationKey> = {
  read: "settings.permissions.project.actionGroup.read",
  mutate: "settings.permissions.project.actionGroup.mutate",
  execute: "settings.permissions.project.actionGroup.execute",
  external: "settings.permissions.project.actionGroup.external",
  network: "settings.permissions.project.actionGroup.network",
  session: "settings.permissions.project.actionGroup.session",
  capability: "settings.permissions.project.actionGroup.capability",
  delegation: "settings.permissions.project.actionGroup.delegation",
  social: "settings.permissions.project.actionGroup.social",
  legacy: "settings.permissions.project.actionGroup.legacy",
}

export interface ProjectPermissionsProps {
  readonly state: Accessor<ProjectState | undefined>
  readonly connection: Accessor<ServerConnection.HttpBase | undefined>
  readonly directory: Accessor<string>
  /** Saved answers this instance holds, already fetched by the panel that owns the SDK. */
  readonly saved: Accessor<readonly ProjectPermissionRule[] | undefined>
  /** Re-read the project after a write, so the list on screen is the file on disk. */
  readonly refresh: () => void
}

export const ProjectPermissionsSection: Component<ProjectPermissionsProps> = (props) => {
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  const [receipt, setReceipt] = createSignal<ProjectWriteResult | { readonly failed: string } | undefined>(undefined)
  /**
   * The edited list, or `undefined` while it still mirrors the file.
   *
   * ⚠️ `undefined` rather than seeding from the file at mount: the resource can arrive late or
   * refresh after a write, and a signal seeded once would silently show a stale list as if it were
   * the file. While nothing has been edited the file IS the answer.
   */
  const [draft, setDraft] = createSignal<readonly ProjectPermissionRule[] | undefined>(undefined)
  const [action, setAction] = createSignal("")
  const [resource, setResource] = createSignal("*")
  const [effect, setEffect] = createSignal<ProjectRuleEffect>("deny")

  const fromFile = createMemo<readonly ProjectPermissionRule[]>(() => {
    const value = props.state()
    return value?.kind === "project" ? value.permissions : []
  })
  /**
   * The action a rule names, in words. `register-app`, `todowrite` and `external_directory_write`
   * are the strings the EVALUATOR matches; they are not what a control should put in front of a
   * person, and this list exists to be read by whoever is deciding what a folder may do.
   *
   * 🔴 The strings were already here — `settings.permissions.tool.*`, a title and a description per
   * action, translated into eighteen locales — and **nothing in the tree rendered any of them**.
   * Meanwhile this picker shipped `label={(value) => value}`, so the same screen whose comment below
   * complains that "`kb`, `js` and `provision` in a row teach nobody what they gate" rendered
   * exactly that row. Principle 8 and 12(c) were answered in the bundles and thrown away here.
   *
   * ⚠️ Falls back to the RAW action, and must: the free-text box beside this list accepts an MCP
   * tool's own action name, and nothing can label those from here. It cannot fire for a built-in —
   * `ACTION_LABEL_KEY` is exhaustive over the action union by construction.
   */
  const actionLabel = (value: string) => {
    const key = (ACTION_LABEL_KEY as Partial<Record<string, TranslationKey>>)[value]
    return key ? language.t(key) : value
  }

  const current = createMemo(() => draft() ?? fromFile())
  const plan = createMemo(() => planProjectPermissions(current()))
  const dirty = createMemo(() => draft() !== undefined)

  /** Principle 12(d): what governs this folder TODAY, said before any control. */
  const inForce = createMemo(() => {
    const value = props.state()
    if (!value || value.kind === "none") return language.t("settings.permissions.project.inForce.none")
    if (value.kind === "invalid") return language.t("settings.project.invalid")
    return pathKey(value.root) === pathKey(props.directory())
      ? language.t("settings.permissions.project.inForce.here", { file: value.file })
      : language.t("settings.permissions.project.inForce.ancestor", { file: value.file })
  })

  /**
   * The second half of the ancestor sentence, and it is the half that is easy to get wrong.
   *
   * 🔴 A new file in this folder does not ADD to the one above — `ProjectFileResolve.walk` stops at
   * the nearest valid file, so the ancestor stops applying here entirely: its exclusions and its Tune
   * as well as its permissions. Saying only "the one above is left alone" is true about the FILE and
   * misleading about the EFFECT, which is the shape of understatement this product treats as a lie.
   */
  const ancestorWarning = createMemo(() => {
    const value = props.state()
    if (!value || value.kind !== "project") return undefined
    if (governedHere(value, props.directory())) return undefined
    return language.t("settings.permissions.project.inForce.ancestorEdit", { file: value.file })
  })

  const addRule = () => {
    const candidate = normalizeRule({ action: action(), resource: resource(), effect: effect() })
    if (!ruleIsComplete(candidate)) return
    setDraft([...current(), candidate])
    setAction("")
    setResource("*")
  }

  const removeAt = (index: number) => setDraft(current().filter((_, i) => i !== index))

  const save = () => {
    const http = props.connection()
    const dir = props.directory()
    if (busy() || !http || !dir) return
    setBusy(true)
    setReceipt(undefined)
    void projectWrite(http, dir, projectPermissionsPayload(plan()))
      .then((result) => {
        setReceipt(result)
        if (result.ok) {
          // The file is the truth again — drop the draft so the list re-reads from the refresh.
          setDraft(undefined)
          props.refresh()
        }
      })
      .catch((error: unknown) => setReceipt({ failed: error instanceof Error ? error.message : String(error) }))
      .finally(() => setBusy(false))
  }

  return (
    <div class="flex flex-col gap-2 pt-3" data-component="settings-project-permissions">
      <span class="text-[13px] font-[560] text-v2-text-text-base">
        {language.t("settings.permissions.project.title")}
      </span>
      <Muted>{language.t("settings.permissions.project.description")}</Muted>
      <span class="text-[11px] leading-4 break-all text-v2-text-text-faint" data-project-permissions-inforce>
        {inForce()}
      </span>
      <Show when={ancestorWarning()}>
        {(text) => (
          <span class="text-[11px] leading-4 break-all text-v2-text-text-faint" data-project-permissions-ancestor>
            {text()}
          </span>
        )}
      </Show>

      {/* ── THE THREE ORIGINS ────────────────────────────────────────────────────────────────── */}
      <div class="flex flex-col gap-3 rounded-md border border-border-base px-3 py-2" data-project-permissions-origins>
        <div class="flex flex-col gap-1" data-origin="project">
          <span class="text-[12px] font-[560] text-v2-text-text-base">
            {language.t("settings.permissions.project.origin.project")}
          </span>
          <Muted>{language.t("settings.permissions.project.origin.projectDetail")}</Muted>
          <Show
            when={current().length > 0}
            fallback={<Muted>{language.t("settings.permissions.project.empty")}</Muted>}
          >
            <For each={current()}>
              {(rule, index) => (
                <div class="flex items-center gap-2" data-origin-rule="project">
                  <span class="flex-1 text-[12px] leading-4 break-all text-v2-text-text-base">
                    {describeRule(rule)}
                  </span>
                  <ButtonV2
                    variant="ghost"
                    size="small"
                    data-action="project-permission-remove"
                    onClick={() => removeAt(index())}
                  >
                    {language.t("settings.permissions.project.remove")}
                  </ButtonV2>
                </div>
              )}
            </For>
          </Show>
        </div>

        <div class="flex flex-col gap-1" data-origin="personal">
          <span class="text-[12px] font-[560] text-v2-text-text-base">
            {language.t("settings.permissions.project.origin.personal")}
          </span>
          <Muted>{language.t("settings.permissions.project.origin.personalDetail")}</Muted>
          {/* ⚠️ `undefined` (not answered yet) renders NOTHING rather than "you have none" — a claim
              this block has not earned yet. Same discipline `projectSummary` takes on a state still
              in flight. */}
          <Show when={props.saved()}>
            {(rules) => (
              <Show
                when={rules().length > 0}
                fallback={<Muted>{language.t("settings.permissions.project.personalEmpty")}</Muted>}
              >
                <For each={rules()}>
                  {(rule) => (
                    <span class="text-[12px] leading-4 break-all text-v2-text-text-base" data-origin-rule="personal">
                      {describeRule(rule)}
                    </span>
                  )}
                </For>
              </Show>
            )}
          </Show>
        </div>

        <div class="flex flex-col gap-1" data-origin="session">
          <span class="text-[12px] font-[560] text-v2-text-text-base">
            {language.t("settings.permissions.project.origin.session")}
          </span>
          <Muted>{language.t("settings.permissions.project.origin.sessionDetail")}</Muted>
        </div>
      </div>

      {/* THE LAW, before the editor rather than after a surprise. */}
      <Muted>{language.t("settings.permissions.project.narrowing")}</Muted>

      {/* ── THE EDITOR ───────────────────────────────────────────────────────────────────────── */}
      {/* 🔴 Principle 12(b) — the list is OFFERED, because it exists. This field used to be free text
          whose only guidance was the placeholder "What the agent wants to do", while the vocabulary
          it wanted sat compiled into `core` and was shown nowhere. A user had to already know the
          word is `external_directory_write` and not "write outside", and a near miss saved silently,
          matched nothing and reported success — a control gatekeeping on knowledge it was holding.
          Grouped rather than one alphabetical run of thirty-odd verbs, because `kb`, `js` and
          `provision` in a row teach nobody what they gate (principle 8). */}
      <div class="flex flex-wrap items-center gap-2" data-project-permissions-add>
        <SelectV2
          options={[...PermissionActions.ALL]}
          current={PermissionActions.ALL.includes(action()) ? action() : undefined}
          placeholder={language.t("settings.permissions.project.actionPick")}
          aria-label={language.t("settings.permissions.project.actionPick")}
          label={actionLabel}
          groupBy={(value) => language.t(GROUP_LABEL[PermissionActions.groupOf(value) ?? "legacy"])}
          data-action="project-permission-action-pick"
          class="min-w-[10rem] flex-1"
          onSelect={(value) => value && setAction(value)}
        />
        {/* 12(b)’s own fallback, and the sentence below says it IS the fallback. An MCP tool’s action
            is the remote tool’s own name and the set is per-server; a tool a model defines names
            itself at runtime. Neither is knowable from here, so free text stays — beside the list
            rather than instead of it. */}
        <TextInputV2
          value={action()}
          placeholder={language.t("settings.permissions.project.addAction")}
          aria-label={language.t("settings.permissions.project.addAction")}
          data-action="project-permission-action"
          class="min-w-[10rem] flex-1"
          onInput={(event) => setAction(event.currentTarget.value)}
        />
        <TextInputV2
          value={resource()}
          placeholder={language.t("settings.permissions.project.addResource")}
          aria-label={language.t("settings.permissions.project.addResource")}
          data-action="project-permission-resource"
          class="min-w-[10rem] flex-1"
          onInput={(event) => setResource(event.currentTarget.value)}
        />
        {/* 🔴 `allow` is deliberately NOT offered. A project ruleset is a narrowing constraint, so an
            `allow` can never change a verdict — offering it would be a control that reports success
            and does nothing. Principle 12(b): the list offers what exists, and `allow` does not. */}
        <SelectV2
          options={[...PROJECT_RULE_EFFECTS]}
          current={effect()}
          label={(value) => value}
          data-action="project-permission-effect"
          onSelect={(value) => value && setEffect(value)}
        />
        <ButtonV2
          variant="outline"
          size="small"
          data-action="project-permission-add"
          disabled={!ruleIsComplete({ action: action(), resource: resource() })}
          onClick={addRule}
        >
          {language.t("settings.permissions.project.add")}
        </ButtonV2>
      </div>
      <Muted>{language.t("settings.permissions.project.actionFallback")}</Muted>

      <Show when={plan().omitted.length > 0}>
        <span class="text-[11px] leading-4 text-v2-text-text-faint" data-project-permissions-omitted>
          {language.t("settings.permissions.project.omitted", {
            list: plan().omitted.map(describeRule).join(", "),
          })}
        </span>
      </Show>

      <Show when={dirty()}>
        <span class="text-[11px] leading-4 text-v2-text-text-faint" data-project-permissions-preview>
          {plan().declared.length === 0
            ? language.t("settings.permissions.project.previewClear")
            : language.t("settings.permissions.project.preview", {
                list: plan().persisted.map(describeRule).join(", "),
              })}
        </span>
      </Show>

      <ButtonV2
        variant="outline"
        size="small"
        class="self-start"
        data-action="project-permissions-save"
        disabled={busy() || !dirty()}
        onClick={save}
      >
        {language.t(busy() ? "settings.permissions.project.saving" : "settings.permissions.project.save")}
      </ButtonV2>

      <Show when={receipt()}>
        {(result) => (
          <WriteReceipt
            result={result()}
            extra={(written) => (
              <>
                <Show when={written.cleared.includes("permissions")}>
                  <Muted>{language.t("settings.permissions.project.receipt.cleared")}</Muted>
                </Show>
                {/* 🔴 The one line that makes the narrowing law visible instead of surprising: the
                    SERVER says which rules it dropped, and this says so out loud rather than letting
                    a cheerful receipt imply they landed. */}
                <Show when={written.refusedPermissions.length > 0}>
                  <span class="text-[11px] leading-4 text-v2-text-text-faint" data-receipt-refused>
                    {language.t("settings.permissions.project.receipt.refused", {
                      list: written.refusedPermissions.map(describeRule).join(", "),
                    })}
                  </span>
                </Show>
              </>
            )}
          />
        )}
      </Show>
    </div>
  )
}

/**
 * The receipt a project-file write leaves behind, shared by every control that writes one.
 *
 * ⚠️ ONE renderer, not one per section. The three outcomes each carry a sentence a user acts on —
 * "your file is from a newer NovaClaw" (upgrade), "your file is broken" (fix it), "the request never
 * reached the instance" (retry) — and three copies of that mapping is three chances for two of them
 * to disagree about the same file. `extra` is where a section adds what only it can say.
 */
/**
 * The sections one write reports having touched — replaced and removed alike, in the server's order.
 *
 * ⚠️ Read off the RECEIPT rather than off what the caller sent. The server is the authority on what
 * landed (it drops an `allow` rule, a `show:true`, an always-on policy id), and a sentence built
 * from the request would claim a section changed when the whole of it was refused.
 */
const sectionsTouched = (written: Extract<ProjectWriteResult, { ok: true }>): readonly string[] => [
  ...written.sections,
  ...written.cleared,
]

// ⚠️ EXPORTED for the folder-policy control in `policies.tsx` — a fourth writer of the same file,
// living in a different Settings section. A fourth copy of this mapping was the alternative, and the
// paragraph above is the argument against it.
export const WriteReceipt: Component<{
  result: ProjectWriteResult | { readonly failed: string }
  extra?: (written: Extract<ProjectWriteResult, { ok: true }>) => unknown
}> = (props) => {
  const language = useLanguage()
  const failed = () => ("failed" in props.result ? props.result : undefined)
  const written = () =>
    !("failed" in props.result) && props.result.ok
      ? (props.result as Extract<ProjectWriteResult, { ok: true }>)
      : undefined
  const refused = () =>
    !("failed" in props.result) && !props.result.ok
      ? (props.result as Extract<ProjectWriteResult, { ok: false }>)
      : undefined
  return (
    <div class="flex flex-col gap-0.5 rounded-md border border-border-base px-2.5 py-1.5" data-project-write-receipt>
      <Switch>
        <Match when={failed()}>
          {(value) => (
            <span class="text-[12px] leading-4 text-v2-text-text-base">
              {language.t("settings.permissions.project.receipt.failed", { detail: value().failed })}
            </span>
          )}
        </Match>
        <Match when={written()}>
          {(value) => (
            <>
              <span class="text-[12px] leading-4 break-all text-v2-text-text-base">
                {language.t(
                  value().created
                    ? "settings.permissions.project.receipt.created"
                    : "settings.permissions.project.receipt.updated",
                  { file: value().file },
                )}
              </span>
              {props.extra?.(value()) as never}
              {/* 🔴 The sections this write actually touched, replaced and removed alike. This line
                  used to say "Only the permissions section changed" for EVERY writer of this file,
                  which was a falsehood on three of the four — found by saving a folder's check list
                  and reading the receipt it produced. */}
              <Muted>
                {sectionsTouched(value()).length === 0
                  ? language.t("settings.permissions.project.receipt.preservedNone")
                  : language.t("settings.permissions.project.receipt.preserved", {
                      sections: sectionsTouched(value()).join(", "),
                    })}
              </Muted>
            </>
          )}
        </Match>
        <Match when={refused()}>
          {(value) => (
            <>
              {/* Two reasons, two opposite actions — "update NovaClaw" and "fix your file" — so they
                  never share a sentence. Same split every other surface makes. */}
              <span class="text-[12px] leading-4 break-all text-v2-text-text-base">
                {language.t(
                  value().reason === "future-version"
                    ? "settings.permissions.project.receipt.refusedFuture"
                    : "settings.permissions.project.receipt.refusedBroken",
                  { file: value().file, detail: value().detail },
                )}
              </span>
              <Muted>{language.t("settings.permissions.project.receipt.untouched")}</Muted>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}

/**
 * **Settings → Project → editing "Never read".**
 *
 * *"`.gitignore` import and writing the exclusion section back"* — this is the
 * write-back half, and it is separate from the import because an import-only control is a ONE-WAY
 * DOOR. Someone who imported a `.gitignore` and then found Nova unable to read a file it should could
 * only fix it by hand-editing JSON, which is the "poke memory bytes" this product refuses
 * (principle 12). Adding and removing live on the same control.
 *
 * ⚠️ Order is preserved and never sorted. `ProjectExclusion.evaluate` resolves by LAST match, so the
 * order of this list is its meaning: a `!` line re-includes only what stands above it.
 */
export const ProjectExcludeSection: Component<ProjectPermissionsProps> = (props) => {
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  const [receipt, setReceipt] = createSignal<ProjectWriteResult | { readonly failed: string } | undefined>(undefined)
  const [draft, setDraft] = createSignal<readonly string[] | undefined>(undefined)
  const [pattern, setPattern] = createSignal("")

  const fromFile = createMemo<readonly string[]>(() => {
    const value = props.state()
    return value?.kind === "project" ? value.exclude : []
  })
  const current = createMemo(() => draft() ?? fromFile())
  const dirty = createMemo(() => draft() !== undefined)
  /**
   * 🔴 An inherited list is READ-ONLY here, and the refusal is the correctness point rather than
   * caution. `POST /api/project` writes THIS folder's file; the nearest file wins on read; so
   * "adding two patterns" to an ancestor's list would in fact replace that ancestor's whole
   * declaration — Tune and permissions included — for this folder. Nobody would predict that from a
   * control that says "Add".
   *
   * An absent project file is still editable: writing one here is exactly what the user asked for.
   */
  const inherited = createMemo(() => {
    const value = props.state()
    if (!value || value.kind !== "project") return undefined
    return governedHere(value, props.directory()) ? undefined : value.file
  })

  const add = () => {
    const value = pattern().trim()
    if (value.length === 0) return
    setDraft([...current(), value])
    setPattern("")
  }

  const save = () => {
    const http = props.connection()
    const dir = props.directory()
    if (busy() || !http || !dir) return
    setBusy(true)
    setReceipt(undefined)
    void projectWrite(http, dir, projectExcludePayload(current()))
      .then((result) => {
        setReceipt(result)
        if (result.ok) {
          setDraft(undefined)
          props.refresh()
        }
      })
      .catch((error: unknown) => setReceipt({ failed: error instanceof Error ? error.message : String(error) }))
      .finally(() => setBusy(false))
  }

  return (
    <div class="flex flex-col gap-2 pt-3" data-component="settings-project-exclude">
      <span class="text-[13px] font-[560] text-v2-text-text-base">
        {language.t("settings.project.exclude.editTitle")}
      </span>
      <Muted>{language.t("settings.project.exclude.editDescription")}</Muted>
      <Show when={inherited()}>
        {(file) => (
          <span class="text-[11px] leading-4 break-all text-v2-text-text-faint" data-exclude-elsewhere>
            {language.t("settings.project.exclude.elsewhere", { file: file() })}
            {/* uix.md §1.4 — the line names the FILE, which is the actionable half; why a local edit
                would REPLACE rather than extend it is one gesture away. */}
            <SettingsExplainV2 label={language.t("settings.project.excludeLabel")}>
              {language.t("settings.project.exclude.elsewhere.more")}
            </SettingsExplainV2>
          </span>
        )}
      </Show>
      <For each={current()}>
        {(entry, index) => (
          <div class="flex items-center gap-2" data-exclude-row>
            <span class="flex-1 text-[12px] leading-4 break-all text-v2-text-text-base">{entry}</span>
            <ButtonV2
              variant="ghost"
              size="small"
              data-action="project-exclude-remove"
              disabled={inherited() !== undefined}
              onClick={() => setDraft(current().filter((_, i) => i !== index()))}
            >
              {language.t("settings.project.exclude.remove")}
            </ButtonV2>
          </div>
        )}
      </For>
      <div class="flex flex-wrap items-center gap-2">
        <TextInputV2
          value={pattern()}
          placeholder={language.t("settings.project.exclude.addPattern")}
          aria-label={language.t("settings.project.exclude.addPattern")}
          data-action="project-exclude-pattern"
          class="min-w-[12rem] flex-1"
          onInput={(event) => setPattern(event.currentTarget.value)}
        />
        <ButtonV2
          variant="outline"
          size="small"
          data-action="project-exclude-add"
          disabled={inherited() !== undefined || pattern().trim().length === 0}
          onClick={add}
        >
          {language.t("settings.project.exclude.add")}
        </ButtonV2>
      </div>
      <Show when={dirty()}>
        <span class="text-[11px] leading-4 break-all text-v2-text-text-faint" data-exclude-preview>
          {current().length === 0
            ? language.t("settings.project.exclude.previewClear")
            : language.t("settings.project.exclude.preview", { list: current().join(", ") })}
        </span>
      </Show>
      <ButtonV2
        variant="outline"
        size="small"
        class="self-start"
        data-action="project-exclude-save"
        disabled={busy() || !dirty() || inherited() !== undefined}
        onClick={save}
      >
        {language.t(busy() ? "settings.project.exclude.saving" : "settings.project.exclude.save")}
      </ButtonV2>
      <Show when={receipt()}>{(result) => <WriteReceipt result={result()} />}</Show>
    </div>
  )
}

/**
 * **Settings → Project → "Never read" ← `.gitignore`.**
 *
 * *"`.gitignore` import and writing the exclusion section back"*, plus *"read
 * eligibility stays distinct from watcher/build ignores."*
 *
 * 🔴 **A suggestion, never a sync, and the copy says why rather than assuming.** A `.gitignore`
 * answers *"what should not be committed"*; this list answers *"what must never reach the model"*.
 * They agree about `.env` and disagree about `dist/`, and a committed secrets folder appears in
 * neither. So the control shows exactly what would be added, names the lines it cannot honour, warns
 * about `!` lines that would put files BACK in reach, and does nothing until a person presses it.
 */
export const ProjectGitignoreImport: Component<ProjectPermissionsProps> = (props) => {
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  const [receipt, setReceipt] = createSignal<string | undefined>(undefined)
  const proposal = createMemo(() => gitignoreImport(props.state(), props.directory()))

  const run = () => {
    const value = proposal()
    const http = props.connection()
    const dir = props.directory()
    if (busy() || value.kind !== "ready" || !http || !dir) return
    setBusy(true)
    setReceipt(undefined)
    void projectWrite(http, dir, { exclude: value.exclude })
      .then((result) => {
        setReceipt(
          result.ok
            ? language.t("settings.project.exclude.import.done", {
                count: value.add.length,
                file: result.file,
              })
            : language.t("settings.permissions.project.receipt.refusedBroken", {
                file: result.file,
                detail: result.detail,
              }),
        )
        if (result.ok) props.refresh()
      })
      .catch((error: unknown) =>
        setReceipt(
          language.t("settings.permissions.project.receipt.failed", {
            detail: error instanceof Error ? error.message : String(error),
          }),
        ),
      )
      .finally(() => setBusy(false))
  }

  return (
    <Show when={proposal().kind !== "no-project"}>
      <div class="flex flex-col gap-2 pt-3" data-component="settings-project-gitignore">
        <span class="text-[13px] font-[560] text-v2-text-text-base">
          {language.t("settings.project.exclude.import.title")}
        </span>
        <Muted>{language.t("settings.project.exclude.import.distinct")}</Muted>
        <Switch>
          <Match
            when={
              proposal().kind === "elsewhere"
                ? (proposal() as Extract<ReturnType<typeof gitignoreImport>, { kind: "elsewhere" }>)
                : undefined
            }
          >
            {(other) => (
              <Muted>{language.t("settings.project.exclude.import.elsewhere", { file: other().file })}</Muted>
            )}
          </Match>
          <Match when={proposal().kind === "no-file"}>
            {/* Stated rather than hidden: a control that only appears once it has something to do
                teaches nobody that it exists (principle 12d). */}
            <Muted>{language.t("settings.project.exclude.import.noFile")}</Muted>
          </Match>
          <Match
            when={
              proposal().kind === "nothing-new"
                ? (proposal() as Extract<ReturnType<typeof gitignoreImport>, { kind: "nothing-new" }>)
                : undefined
            }
          >
            {(nothing) => (
              <Muted>
                {language.t("settings.project.exclude.import.nothingNew", {
                  file: nothing().file,
                  count: nothing().already,
                })}
              </Muted>
            )}
          </Match>
          <Match
            when={
              proposal().kind === "ready"
                ? (proposal() as Extract<ReturnType<typeof gitignoreImport>, { kind: "ready" }>)
                : undefined
            }
          >
            {(ready) => (
              <>
                <span class="text-[11px] leading-4 break-all text-v2-text-text-faint" data-gitignore-preview>
                  {language.t("settings.project.exclude.import.preview", {
                    count: ready().add.length,
                    file: ready().file,
                    list: ready().add.join(", "),
                  })}
                </span>
                <Show when={ready().already.length > 0}>
                  <Muted>
                    {language.t("settings.project.exclude.import.already", { list: ready().already.join(", ") })}
                  </Muted>
                </Show>
                <Show when={ready().dropped.length > 0}>
                  <span class="text-[11px] leading-4 break-all text-v2-text-text-faint" data-gitignore-dropped>
                    {language.t("settings.project.exclude.import.dropped", {
                      list: ready()
                        .dropped.map((item) => item.source)
                        .join(", "),
                    })}
                  </span>
                </Show>
                <Show when={ready().reincludes.length > 0}>
                  <span class="text-[11px] leading-4 break-all text-v2-text-text-faint" data-gitignore-reincludes>
                    {language.t("settings.project.exclude.import.reincludes", {
                      list: ready().reincludes.join(", "),
                    })}
                  </span>
                </Show>
                <ButtonV2
                  variant="outline"
                  size="small"
                  class="self-start"
                  data-action="project-gitignore-import"
                  disabled={busy()}
                  onClick={run}
                >
                  {language.t(
                    busy() ? "settings.project.exclude.import.saving" : "settings.project.exclude.import.action",
                  )}
                </ButtonV2>
              </>
            )}
          </Match>
        </Switch>
        <Show when={receipt()}>
          {(text) => (
            <span
              class="text-[12px] leading-4 break-all text-v2-text-text-base rounded-md border border-border-base px-2.5 py-1.5"
              data-gitignore-receipt
            >
              {text()}
            </span>
          )}
        </Show>
      </div>
    </Show>
  )
}
