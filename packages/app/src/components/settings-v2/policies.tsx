import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { authorText } from "@/apps/skills"
import { useGlobal } from "@/context/global"
import { useLanguage, type TranslationKey } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { policyState, type InstalledPolicy } from "@/utils/policy-api"
import { reportedWrite } from "@/utils/config-write"
import { showToast } from "@/utils/toast"
import { projectState, projectWrite, type ProjectState, type ProjectWriteResult } from "@/utils/project-api"
import type { ServerConnection } from "@/context/server"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { governedHere } from "./project-permissions"
import { WriteReceipt } from "./project-permissions-section"
import {
  folderPolicyStatus,
  type FolderPolicyStatus,
  planProjectPolicies,
  policyAddOptions,
  policyIDIsAddable,
  projectPoliciesPayload,
} from "./project-policies"
import { SettingsExplainV2 } from "./explain"
import { scopedDirectory } from "@/utils/routing-directory"

/**
 * **Which checks run before a tool call, which of them you have switched off, and what this folder
 * asks for.**
 *
 * The gap: *"policies have no management surface … Settings cannot list or toggle them;
 * only built-ins install."* — and then *"A folder's policy list is READ-ONLY in the app — wants the
 * section-scoped write Permissions got."* A pre-action policy can refuse a tool call, rewrite its
 * arguments or hold it for approval; this section is where all three of those become visible and
 * changeable. It sits directly under Project because it answers the third form of the same question
 * those sections raise: what is deciding what the agent may do here.
 *
 * 🔴 **The in-force line comes BEFORE any control** (AGENTS.md principle 12d), and the copy CHANGES
 * with the switches — "all of them run" and "{{off}} switched off" are different sentences, because
 * a fixed line above a control that has moved is the trap principle 12 records from its first sweep.
 * The same rule is why an always-on row now says it runs everywhere AND that a folder can never
 * switch one off: the list below offers that policy like any other, and what a person needs to know
 * before ticking it is exactly which half of the decision is theirs.
 *
 * ⚠️ **A policy's description is the POLICY's sentence, not ours.** Only NovaClaw's built-ins
 * register today, but `ToolPolicy.Provider` is the interface a plugin implements — so every string
 * that came from one goes through `authorText`, and the copy quotes rather than asserts.
 *
 * ⚠️ **Two different writes live in this section and they must not be confused.** The per-row switch
 * writes `config.tool_policy.<id>.enabled` — an INSTANCE decision, the user's own. The list at the
 * bottom writes the `policies` section of this folder's `novaclaw.json` — a FOLDER decision, which
 * may only ever add. Nothing in the folder's list can move the instance switch, and that asymmetry
 * is the whole security property (`project-policies.ts`).
 */

const Value: Component<{ children: string }> = (props) => (
  <span class="text-[13px] text-v2-text-text-muted">{props.children}</span>
)

/** The muted detail slot the folder editor uses, matching Settings → Project's own sections. */
const Muted: Component<{ children: unknown }> = (props) => (
  <span class="text-[12px] leading-4 text-v2-text-text-faint">{props.children as never}</span>
)

/** The joined id list, sanitized, for the sentences that name several at once. */
const idList = (ids: readonly string[]) => ids.map((id) => authorText(id, 64) || "?").join(", ")

export const SettingsPoliciesSection: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const sync = useServerSync()

  const connection = createMemo(() => server.current ?? global.servers.list()[0])
  const directory = createMemo(() => scopedDirectory(sync().data.path))
  const source = createMemo(() => {
    const http = connection()?.http
    const dir = directory()
    return http && dir ? { http, dir } : undefined
  })

  /**
   * ⚠️ Degrades to `undefined` rather than throwing, exactly as Settings → Project's saved-rules
   * read does. A throw inside a `createResource` read reaches the ROOT ErrorBoundary and replaces
   * the whole application, and a policy list that failed to load must never cost someone their
   * chats. `undefined` renders nothing here, which is honest: this block has not been told, so it
   * claims nothing.
   */
  const [state, { refetch }] = createResource(source, async (value) => {
    try {
      return await policyState(value.http, value.dir)
    } catch {
      return undefined
    }
  })

  /**
   * The resolved project file — read here as WELL as in Settings → Project, deliberately.
   *
   * 🔴 `GET /api/policy` answers which file the requests came from and NOT where its root is, and
   * the root is what decides whether this folder's declaration is its own. Editing an INHERITED list
   * would create a second file that takes the ancestor's whole declaration out of force for this
   * folder (`governedHere` records the argument), so a control that could not tell the two apart
   * would be a control that silently detaches a folder from its parent project. The alternative —
   * putting `root` on the policy route — would be a second answer to a question `GET /api/project`
   * already answers.
   */
  const [project, { refetch: refetchProject }] = createResource(source, async (value) => {
    try {
      return await projectState(value.http, value.dir)
    } catch {
      return undefined
    }
  })

  const [toggleError, setToggleError] = createSignal<string | undefined>(undefined)
  const installed = createMemo(() => state()?.installed ?? [])
  const off = createMemo(() => installed().filter((entry) => !entry.enabled).length)
  const requested = createMemo(() => new Set(state()?.requested ?? []))

  const inForce = createMemo(() => {
    if (installed().length === 0) return language.t("policies.inForce.none")
    if (off() === 0) return language.t("policies.inForce.all", { count: installed().length })
    return language.t("policies.inForce.some", { count: installed().length, off: off() })
  })

  /**
   * The switch write.
   *
   * ⚠️ Only the one id travels. `PATCH /config` merge-patches a settings key, so sending the whole
   * map would make this screen the author of every OTHER policy's row — including ones a future
   * build installed and this one has never heard of.
   *
   * ⚠️ `enabled: true` is written explicitly rather than clearing the row, because `PATCH /config`
   * treats `null` as a value and not as a tombstone (deleting is `POST /api/config/remove`). An
   * explicit `true` and an absent key mean the same thing to the gate.
   *
   * 🔴 **A failed toggle is SAID, not logged.** It used to end
   * `.catch((error) => console.error(…))`: the switch is controlled by the stored value, so the
   * thumb sprang back to where it was and the only account of why lived in a devtools console a
   * normal person never opens. On the one surface that decides which checks run before a tool call,
   * a control that appears to refuse its own input without a word is the obscurantism this section
   * exists to end.
   */
  const toggle = async (id: string, enabled: boolean) => {
    const saved = await reportedWrite(
      () => sync().updateConfig({ tool_policy: { [id]: { enabled } } } as never),
      (error) => {
        setToggleError(`${language.t("policies.toggle.failed", { id: authorText(id, 64) || id })} ${error}`)
        showToast({
          variant: "error",
          title: language.t("policies.toggle.failed", { id: authorText(id, 64) || id }),
          description: error,
        })
      },
    )
    if (!saved.ok) return
    setToggleError(undefined)
    void refetch()
  }

  /**
   * What this row SAYS — the policy's own sentence plus anything true of this row alone.
   *
   * ⚠️ The row's own copy states the switch position too. A description that read the same whether
   * the policy was running or not is the "fixed copy beside a moved control" defect.
   */
  const describe = (entry: InstalledPolicy) => {
    const sentence = authorText(entry.describe, 240)
    const parts = [
      sentence === "" ? "" : language.t("policies.row.describes", { describe: sentence }),
      entry.enabled ? "" : language.t("policies.row.off"),
      requested().has(entry.id) ? language.t("policies.row.requestedHere") : "",
    ]
    return parts.filter((part) => part !== "").join(" ")
  }

  /**
   * The part that is the same on every row of its class — scope, and what happens if the check stops
   * answering. Owner, 2026-08-24: joined onto the description it made each row a ~280-character
   * paragraph, and a list where every entry repeats the same two sentences is a list nobody reads.
   *
   * 🔴 `everywhere` moved here rather than being dropped: it is what tells a reader why an always-on
   * check has no entry in the folder list below, and without it that list reads as incomplete. The
   * section's own hint already states the rule, so this is the second place it is said, not the only.
   */
  const scopeMore = (entry: InstalledPolicy) =>
    [
      entry.alwaysOn ? language.t("policies.row.everywhere") : language.t("policies.row.optIn"),
      entry.safetyCritical ? language.t("policies.row.safetyCritical") : language.t("policies.row.advisory"),
    ].join(" ")

  return (
    <Show when={state()}>
      {(resolved) => (
        <div class="settings-v2-section" data-component="settings-policies">
          <h3 class="settings-v2-section-title">{language.t("policies.section")}</h3>

          <SettingsListV2>
            {/* 🔴 The fact FIRST, before any switch — principle 12(d). */}
            <SettingsRowV2
              title={language.t("policies.inForce.title")}
              description={
                <>
                  {inForce()}
                  <SettingsExplainV2 label={language.t("policies.inForce.title")}>
                    {language.t("policies.hint")}
                  </SettingsExplainV2>
                </>
              }
            >
              <Value>{String(resolved().installed.length)}</Value>
            </SettingsRowV2>

            <For each={resolved().installed}>
              {(entry) => (
                <SettingsRowV2
                  title={authorText(entry.id, 64) || entry.id}
                  description={
                    <>
                      {describe(entry)}
                      <SettingsExplainV2 label={authorText(entry.id, 64) || entry.id}>
                        {scopeMore(entry)}
                      </SettingsExplainV2>
                    </>
                  }
                >
                  <div data-action="settings-policy-toggle" data-policy={entry.id}>
                    <Switch checked={entry.enabled} onChange={(checked) => void toggle(entry.id, checked)} />
                  </div>
                </SettingsRowV2>
              )}
            </For>

            {/* What the FOLDER asks for is shown even when it asks for nothing — the same reason the
                "Never read" row above it is: a capability that only appears once you already use it
                teaches nobody that it exists. This row is the FACT; the control is below it. */}
            <SettingsRowV2
              title={language.t("policies.folder.title")}
              description={
                resolved().requested.length === 0
                  ? language.t("policies.folder.none")
                  : language.t("policies.folder.requested", {
                      file: resolved().file ?? "novaclaw.json",
                      ids: idList(resolved().requested),
                    })
              }
            >
              <span />
            </SettingsRowV2>

            {/* 🔴 Both refusal states get their own row, and they are separate rows because the fix
                is the opposite one in each case: install the thing, or switch it back on. */}
            <Show when={resolved().missing.length > 0}>
              <SettingsRowV2
                title={language.t("policies.folder.missing.title")}
                description={language.t("policies.folder.missing", {
                  file: resolved().file ?? "novaclaw.json",
                  ids: idList(resolved().missing),
                })}
              >
                <span data-slot="settings-policy-missing" />
              </SettingsRowV2>
            </Show>
            <Show when={resolved().disabledButRequested.length > 0}>
              <SettingsRowV2
                title={language.t("policies.folder.disabled.title")}
                description={language.t("policies.folder.disabled", {
                  file: resolved().file ?? "novaclaw.json",
                  ids: idList(resolved().disabledButRequested),
                })}
              >
                <span data-slot="settings-policy-disabled" />
              </SettingsRowV2>
            </Show>
          </SettingsListV2>

          {/* 🔴 The switch's own failure, on screen and next to the switch. A control that springs
              back is a control that refused, and a refusal with no sentence is indistinguishable
              from a dead one. */}
          <Show when={toggleError()}>
            <span
              class="text-[12px] leading-4 break-all"
              style={{ color: "var(--v2-state-danger-text, #ef4444)" }}
              data-slot="settings-policy-toggle-error"
            >
              {toggleError()}
            </span>
          </Show>

          <FolderPoliciesEditor
            installed={installed}
            requested={() => resolved().requested}
            project={project}
            connection={() => connection()?.http}
            directory={directory}
            refresh={() => {
              void refetch()
              void refetchProject()
            }}
          />
        </div>
      )}
    </Show>
  )
}

/**
 * **The folder's own list, as something a person can change.**
 *
 * The gap: *"a folder's policy list is READ-ONLY in the app — wants the section-scoped
 * write Permissions got."* So it got exactly that one: `POST /api/project` touching only the
 * `policies` section, a preview of what will be written, and the shared `WriteReceipt` naming the
 * file. Nothing here is a new pattern — the differences from `ProjectPermissionsSection` are the
 * three the domain forces, and each is written down in `project-policies.ts`.
 *
 * 🔴 **The one law the copy keeps in front of the control: a folder may only ever ADD.** There is no
 * spelling in a `novaclaw.json` for *"do not run that check here"*, and there must not be — a folder
 * able to remove a guard the instance installed is a cloned repository disarming the user's rails.
 * So an always-on policy has no row here at all (its Settings row above says why), and one already
 * sitting in the file is shown as an entry the save will drop.
 */
const FolderPoliciesEditor: Component<{
  readonly installed: () => readonly InstalledPolicy[]
  readonly requested: () => readonly string[]
  readonly project: () => ProjectState | undefined
  readonly connection: () => ServerConnection.HttpBase | undefined
  readonly directory: () => string
  readonly refresh: () => void
}> = (props) => {
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  const [receipt, setReceipt] = createSignal<ProjectWriteResult | { readonly failed: string } | undefined>(undefined)
  /**
   * The edited list, or `undefined` while it still mirrors the file.
   *
   * ⚠️ `undefined` rather than seeding from the file at mount, for `ProjectPermissionsSection`'s
   * reason: the resource can arrive late or refresh after a write, and a signal seeded once would
   * show a stale list as if it were the file.
   */
  const [draft, setDraft] = createSignal<readonly string[] | undefined>(undefined)
  const [typed, setTyped] = createSignal("")

  const current = createMemo(() => draft() ?? props.requested())
  const dirty = createMemo(() => draft() !== undefined)
  const plan = createMemo(() => planProjectPolicies(current()))
  const options = createMemo(() => policyAddOptions(props.installed(), current()))

  /**
   * 🔴 An inherited list is READ-ONLY here, and the refusal is the correctness point rather than
   * caution — the same one `ProjectExcludeSection` states. `POST /api/project` writes THIS folder's
   * file and `walk` stops at the nearest one, so "adding one id" to an ancestor's list would in fact
   * replace that ancestor's whole declaration — its Tune, permissions and never-read list included —
   * for this folder. Nobody would predict that from a button saying "Ask for it".
   *
   * A folder with no project file at all is still editable: writing one is what the user asked for.
   */
  const inherited = createMemo(() => {
    const value = props.project()
    if (!value || value.kind !== "project") return undefined
    return governedHere(value, props.directory()) ? undefined : value.file
  })

  const add = (id: string) => {
    const value = id.trim()
    if (!policyIDIsAddable(value, current())) return
    setDraft([...current(), value])
    setTyped("")
  }

  const save = () => {
    const http = props.connection()
    const dir = props.directory()
    if (busy() || !http || !dir) return
    setBusy(true)
    setReceipt(undefined)
    void projectWrite(http, dir, projectPoliciesPayload(plan()))
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

  /**
   * One row's sentence about itself.
   *
   * ⚠️ A total RECORD rather than a `switch`, so a fifth `FolderPolicyStatus` is a type error naming
   * the missing arm — where a switch would just fall out of the bottom and render nothing.
   */
  const STATUS_KEY: Record<FolderPolicyStatus, TranslationKey> = {
    running: "policies.folder.edit.status.running",
    "switched-off": "policies.folder.edit.status.switchedOff",
    "always-on": "policies.folder.edit.status.alwaysOn",
    missing: "policies.folder.edit.status.missing",
  }
  const statusOf = (id: string) => language.t(STATUS_KEY[folderPolicyStatus(id, props.installed())])

  return (
    <div class="flex flex-col gap-2 pt-3" data-component="settings-folder-policies">
      <span class="text-[13px] font-[560] text-v2-text-text-base">{language.t("policies.folder.edit.title")}</span>
      <Muted>{language.t("policies.folder.edit.description")}</Muted>
      {/* THE LAW, before the editor rather than after a surprise. */}
      <Muted>{language.t("policies.folder.edit.narrowing")}</Muted>
      <Show when={inherited()}>
        {(file) => (
          <span class="text-[11px] leading-4 break-all text-v2-text-text-faint" data-folder-policies-elsewhere>
            {language.t("policies.folder.edit.elsewhere", { file: file() })}
          </span>
        )}
      </Show>

      <Show when={current().length > 0} fallback={<Muted>{language.t("policies.folder.edit.empty")}</Muted>}>
        <For each={current()}>
          {(id, index) => (
            <div class="flex items-start gap-2" data-folder-policy-row data-policy={id}>
              <div class="flex flex-1 flex-col">
                <span class="text-[12px] leading-4 break-all text-v2-text-text-base">{authorText(id, 64) || id}</span>
                <Muted>{statusOf(id)}</Muted>
              </div>
              <ButtonV2
                variant="ghost"
                size="small"
                data-action="folder-policy-remove"
                disabled={inherited() !== undefined}
                onClick={() => setDraft(current().filter((_, i) => i !== index()))}
              >
                {language.t("policies.folder.edit.remove")}
              </ButtonV2>
            </div>
          )}
        </For>
      </Show>

      {/* 🔴 Principle 12(b) — offer what EXISTS, which is every installed check not already listed.
          Always-on ones are offered too: asking for one is a legitimate opt-in, and filtering them
          out emptied this picker completely (always-on is the DEFAULT, and neither shipped policy
          opts out). What it costs is the sentence below, stated before the control rather than
          discovered later by having every tool call refused. */}
      <Show
        when={options().length > 0}
        fallback={
          <span class="text-[11px] leading-4 text-v2-text-text-faint" data-folder-policies-nothing>
            {language.t("policies.folder.edit.nothingToOffer")}
          </span>
        }
      >
        <div class="flex flex-wrap items-center gap-2" data-folder-policies-offer>
          <For each={options()}>
            {(entry) => (
              <ButtonV2
                variant="outline"
                size="small"
                data-action="folder-policy-offer"
                data-policy={entry.id}
                disabled={inherited() !== undefined}
                onClick={() => add(entry.id)}
              >
                {authorText(entry.id, 64) || entry.id}
              </ButtonV2>
            )}
          </For>
        </div>
      </Show>

      {/* 12(b)'s own fallback: "free text is the fallback for what discovery missed, and it says so."
          A check installed on a colleague's machine is exactly what discovery here cannot see, and
          the sentence beneath states the consequence BEFORE the button rather than in a receipt. */}
      <div class="flex flex-wrap items-center gap-2">
        <TextInputV2
          value={typed()}
          placeholder={language.t("policies.folder.edit.addPlaceholder")}
          aria-label={language.t("policies.folder.edit.addPlaceholder")}
          data-action="folder-policy-id"
          class="min-w-[12rem] flex-1"
          onInput={(event) => setTyped(event.currentTarget.value)}
        />
        <ButtonV2
          variant="outline"
          size="small"
          data-action="folder-policy-add"
          disabled={inherited() !== undefined || !policyIDIsAddable(typed(), current())}
          onClick={() => add(typed())}
        >
          {language.t("policies.folder.edit.add")}
        </ButtonV2>
      </div>
      <Muted>{language.t("policies.folder.edit.addFallback")}</Muted>
      <span class="text-[11px] leading-4 text-v2-text-text-faint" data-folder-policies-alwayson-cost>
        {language.t("policies.folder.edit.alwaysOnCost")}
      </span>

      <Show when={dirty()}>
        <span class="text-[11px] leading-4 break-all text-v2-text-text-faint" data-folder-policies-preview>
          {plan().declared.length === 0
            ? language.t("policies.folder.edit.previewClear")
            : language.t("policies.folder.edit.preview", { list: idList(plan().persisted) })}
        </span>
      </Show>

      <ButtonV2
        variant="outline"
        size="small"
        class="self-start"
        data-action="folder-policies-save"
        disabled={busy() || !dirty() || inherited() !== undefined}
        onClick={save}
      >
        {language.t(busy() ? "policies.folder.edit.saving" : "policies.folder.edit.save")}
      </ButtonV2>

      <Show when={receipt()}>
        {(result) => (
          <WriteReceipt
            result={result()}
            extra={(written) => (
              <Show when={written.refusedPolicies.length > 0}>
                {/* 🔴 The line that makes the law visible instead of surprising: the SERVER says what
                    it dropped, and this says so out loud rather than letting a cheerful receipt
                    imply it landed. */}
                <span class="text-[11px] leading-4 break-all text-v2-text-text-faint" data-receipt-refused-policies>
                  {language.t("policies.folder.edit.receipt.refused", { list: idList(written.refusedPolicies) })}
                </span>
              </Show>
            )}
          />
        )}
      </Show>
    </div>
  )
}
