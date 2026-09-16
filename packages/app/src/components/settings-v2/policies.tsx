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
import type { ServerConnection } from "@/context/server"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
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

          {/* 🗑️ `<FolderPoliciesEditor>` stood here: the folder's own policy list, made writable
              through `POST /api/project` touching only its `policies` section, with a preview and a
              receipt naming the file. The law it kept in front of the control was that a folder may
              only ever ADD a guard, never remove one. Both the route and the declaration are retired
              (owner, 2026-09-16), so the installed list above is the whole answer: a policy runs
              because it is installed and switched on, and nothing else can ask for one. */}
        </div>
      )}
    </Show>
  )
}

/**
 * 🗑️ `FolderPoliciesEditor` lived here: the folder's policy list as a CONTROL, writing only the
 * `policies` section of its own `novaclaw.json`. It went with the mechanism (owner, 2026-09-16).
 * What it protected — a folder may only ever ADD a guard, never remove one — is now vacuous rather
 * than enforced elsewhere, because no folder can express a policy at all.
 */
