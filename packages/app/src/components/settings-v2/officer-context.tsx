import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { For, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { reportedWrite } from "@/utils/config-write"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsNumberFieldV2 } from "./parts/number-field"
import { SettingsRowV2 } from "./parts/row"
import {
  ALLOCATION_CATEGORIES,
  ALLOCATION_PROFILES,
  allocationRecord,
  allocationShares,
  type AllocationCategory,
  type AllocationProfile,
} from "./parts/context-allocation"
import { ContextAllocationBar } from "./parts/context-allocation-bar"

type TodoReminder = {
  enabled?: boolean
  cadence?: number
  max_tokens?: number
}
interface ContextConfig {
  enabled?: boolean
  profiles?: Partial<Record<AllocationProfile, Partial<Record<AllocationCategory, number>>>>
  todo_reminder?: TodoReminder
}
interface CompactionConfig {
  threshold?: number
}
const DEFAULT_COMPACTION_THRESHOLD = 80
const THRESHOLD_MIN = 50
const THRESHOLD_MAX = 95

export const OfficerContext: Component<{
  agentID: string
  config: () => Record<string, unknown> | undefined
  onChanged?: () => void
}> = (props) => {
  const language = useLanguage()
  const serverSync = useServerSync()

  const stored = () => props.config() as { context?: ContextConfig; compaction?: CompactionConfig; contextBudget?: boolean } | undefined
  const context = (): ContextConfig => stored()?.context ?? {}
  const guardOn = () => stored()?.["contextBudget"] !== false && context().enabled !== false

  const persistContext = (next: ContextConfig) =>
    reportedWrite(
      () => serverSync().updateConfig({ agents: { [props.agentID]: { context: next, ...(next.enabled === undefined ? {} : { contextBudget: next.enabled }) } } } as never).then(() => props.onChanged?.()),
      (error) => showToast({ variant: "error", title: language.t("officer.context.toast.failed"), description: error }),
    )
  const persistCompaction = (threshold: number) =>
    reportedWrite(
      () => serverSync().updateConfig({ agents: { [props.agentID]: { compaction: { ...(stored()?.compaction ?? {}), threshold } } } } as never).then(() => props.onChanged?.()),
      (error) => showToast({ variant: "error", title: language.t("officer.context.toast.failed"), description: error }),
    )

  const setShares = (profile: AllocationProfile, shares: readonly number[]) =>
    void persistContext({
      ...context(),
      profiles: { ...context().profiles, [profile]: allocationRecord(shares) },
    })

  const setReminder = (patch: TodoReminder) =>
    void persistContext({ ...context(), todo_reminder: { ...context().todo_reminder, ...patch } })

  const categoryName = (category: AllocationCategory) => language.t(`officer.context.category.${category}`)
  const profileName = (profile: AllocationProfile) => language.t(`officer.context.profile.${profile}`)
  const reminderCadence = () => context().todo_reminder?.cadence ?? 6
  const reminderBudget = () => context().todo_reminder?.max_tokens ?? 256
  const compactionThreshold = () => stored()?.compaction?.threshold ?? DEFAULT_COMPACTION_THRESHOLD

  return (
    <>
      <div class="settings-v2-tab-body">
        <section class="settings-v2-context-guard" data-section="context-guard">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("officer.context.guard.enabled.title")}
              info={language.t("officer.context.guard.enabled.description.more")}
            >
              <Switch
                checked={guardOn()}
                onChange={(checked) => void persistContext({ ...context(), enabled: checked })}
                hideLabel
              >
                {language.t("officer.context.guard.enabled.title")}
              </Switch>
            </SettingsRowV2>
          </SettingsListV2>

          <div class="settings-v2-allocation-block">
            <h3 class="settings-v2-section-title">{language.t("officer.context.profiles.title")}</h3>
            <ul class="settings-v2-allocation-legend">
              <For each={ALLOCATION_CATEGORIES}>
                {(category) => (
                  <li title={language.t(`officer.context.category.${category}.description`)}>
                    <span class="settings-v2-allocation-chip" data-category={category} />
                    {categoryName(category)}
                  </li>
                )}
              </For>
            </ul>
            <For each={ALLOCATION_PROFILES}>
              {(profile) => (
                <div class="settings-v2-allocation-profile" data-context-profile={profile}>
                  <div class="settings-v2-allocation-profile-header">
                    <span class="settings-v2-allocation-profile-title">{profileName(profile)}</span>
                    <span class="settings-v2-allocation-profile-total">
                      {language.t("officer.context.profile.total", {
                        total: allocationShares(profile, context().profiles?.[profile]).reduce((sum, share) => sum + share, 0),
                      })}
                    </span>
                  </div>
                  <ContextAllocationBar
                    value={() => allocationShares(profile, context().profiles?.[profile])}
                    onChange={(next) => setShares(profile, next)}
                    categories={ALLOCATION_CATEGORIES}
                    labels={ALLOCATION_CATEGORIES.map(categoryName)}
                    disabled={!guardOn()}
                    boundaryLabel={(index) =>
                      language.t("officer.context.boundary.aria", {
                        left: categoryName(ALLOCATION_CATEGORIES[index]!),
                        right: categoryName(ALLOCATION_CATEGORIES[index + 1]!),
                      })
                    }
                  />
                </div>
              )}
            </For>
            <Show when={!guardOn()}>
              <p class="settings-v2-allocation-off" role="status">
                {language.t("officer.context.guard.off")}
              </p>
            </Show>
          </div>
        </section>

        <section class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("officer.context.compaction.title")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("officer.context.compaction.threshold.title")}
              info={language.t("officer.context.compaction.threshold.description.more")}
            >
              <SettingsNumberFieldV2
                class="settings-v2-context-input"
                value={compactionThreshold}
                onCommit={(threshold) => void persistCompaction(threshold)}
                min={THRESHOLD_MIN}
                max={THRESHOLD_MAX}
                unit="%"
                ariaLabel={language.t("officer.context.compaction.threshold.title")}
              />
            </SettingsRowV2>
          </SettingsListV2>
        </section>

        <section class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("officer.context.todo.title")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("officer.context.todo.enabled.title")}
            >
              <Switch
                checked={context().todo_reminder?.enabled !== false}
                onChange={(checked) => setReminder({ enabled: checked })}
                hideLabel
              >
                {language.t("officer.context.todo.enabled.title")}
              </Switch>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("officer.context.todo.cadence.title")}
            >
              <SettingsNumberFieldV2
                class="settings-v2-context-input"
                value={() => reminderCadence()}
                onCommit={(cadence) => setReminder({ cadence })}
                min={1}
                max={1000}
                unit="msg"
                ariaLabel={language.t("officer.context.todo.cadence.title")}
              />
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("officer.context.todo.budget.title")}
            >
              <SettingsNumberFieldV2
                class="settings-v2-context-input"
                value={() => reminderBudget()}
                onCommit={(max_tokens) => setReminder({ max_tokens })}
                min={64}
                max={4096}
                step={16}
                unit="tok"
                ariaLabel={language.t("officer.context.todo.budget.title")}
              />
            </SettingsRowV2>
          </SettingsListV2>
        </section>
      </div>
    </>
  )
}
