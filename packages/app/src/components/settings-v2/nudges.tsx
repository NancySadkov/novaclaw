import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { TextareaV2 } from "@novaclaw/ui/v2/textarea-v2"
import { NudgeDefinition as Nudge } from "@novaclaw/core/nudge-definition"
import type { ConfigNudge } from "@novaclaw/core/config/nudge"
import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { useLanguage, type TranslationKey } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { roster } from "@/apps/contacts"
import { useConfirm } from "@/components/dialog-confirm"
import { reportedWrite } from "@/utils/config-write"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { planNudgeSave, type Refusal } from "./nudges-draft"

type HookType = ConfigNudge.Hook["type"]

const CORE_TOOLS = ["read", "grep", "glob", "write", "edit", "apply_patch", "bash", "task", "webfetch"] as const

const REFUSAL_KEY: Record<Refusal, TranslationKey> = {
  name: "settings.nudges.error.name",
  text: "settings.nudges.error.text",
  pattern: "settings.nudges.error.pattern",
  hook: "settings.nudges.error.hook",
  duplicate: "settings.nudges.error.duplicate",
}

const HOOK_KEY: Record<HookType, TranslationKey> = {
  "text-match": "settings.nudges.hook.text-match",
  "tool-call": "settings.nudges.hook.tool-call",
  "mcp-call": "settings.nudges.hook.mcp-call",
  "file-read": "settings.nudges.hook.file-read",
  "file-write": "settings.nudges.hook.file-write",
  "after-compaction": "settings.nudges.hook.after-compaction",
  "resource-pressure": "settings.nudges.hook.resource-pressure",
  "time-of-day": "settings.nudges.hook.time-of-day",
  "new-day": "settings.nudges.hook.new-day",
  script: "settings.nudges.hook.script",
}

const RESOURCE_KEY = {
  either: "settings.nudges.resource.either",
  warning: "settings.nudges.resource.warning",
  floor: "settings.nudges.resource.floor",
} satisfies Record<"either" | "warning" | "floor", TranslationKey>

const hookFor = (type: HookType): ConfigNudge.Hook => {
  switch (type) {
    case "text-match":
      return { type, pattern: "" }
    case "tool-call":
      return { type, tool: "" }
    case "mcp-call":
      return { type, server: "" }
    case "file-read":
      return { type, extension: "ts" }
    case "file-write":
      return { type, extension: "ts" }
    case "after-compaction":
      return { type }
    case "resource-pressure":
      return { type, level: "either" }
    case "time-of-day":
      return { type, after: "18:00", before: "06:00" }
    case "new-day":
      return { type }
    case "script":
      return { type, command: "" }
  }
}

const blank = (): ConfigNudge.Info => ({
  id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  name: "",
  enabled: true,
  hook: hookFor("text-match"),
  text: "",
})

export const SettingsNudgesV2: Component<{ fixedAgentID?: string }> = (props) => {
  const language = useLanguage()
  const sync = useServerSync()
  const global = useGlobal()
  const server = useServer()
  const confirm = useConfirm()
  const [scope, setScope] = createSignal(props.fixedAgentID ?? "global")
  const connection = () => server.current ?? global.servers.list()[0]
  const colleagues = createMemo(() => {
    const current = connection()
    return current ? roster(global.ensureServerCtx(current).agents.list() ?? []) : []
  })
  const agentRows = createMemo(() => {
    const current = connection()
    return current ? (global.ensureServerCtx(current).agents.list() ?? []) : []
  })
  const selectedAgent = () => agentRows().find((agent) => agent.id === scope())
  const selectedAgentConfig = () => sync().data.config?.agents?.[scope()] ?? selectedAgent()?.config
  const nudges = () =>
    scope() === "global"
      ? [...Nudge.resolved(sync().data.config?.nudges)]
      : [...((selectedAgentConfig()?.nudges as ConfigNudge.Info[] | undefined) ?? [])]
  const toolChoices = createMemo(() => {
    const configured = sync().data.config?.adhoc_tools ?? []
    return [...new Set([...CORE_TOOLS, ...configured.flatMap((tool) => (tool.name ? [tool.name] : []))])].sort(
      (left, right) => left.localeCompare(right),
    )
  })
  const mcpChoices = createMemo(() => {
    const configured = sync().data.config?.mcp ?? {}
    return Object.keys(configured).sort((left, right) => left.localeCompare(right))
  })

  const [editingID, setEditingID] = createSignal<string | undefined>()
  const [draft, setDraft] = createSignal<ConfigNudge.Info>(blank())
  const [error, setError] = createSignal<string>()

  const hookOptions = createMemo(() =>
    (
      [
        "text-match",
        "tool-call",
        "mcp-call",
        "file-read",
        "file-write",
        "after-compaction",
        "resource-pressure",
        "time-of-day",
        "new-day",
        "script",
      ] as const
    ).map((value) => ({ value, label: language.t(HOOK_KEY[value]) })),
  )

  const persist = (next: readonly ConfigNudge.Info[]) =>
    reportedWrite(
      () =>
        scope() === "global"
          ? sync().updateConfig({ nudges: [...next] } as never)
          : sync().updateConfig({ agents: { [scope()]: { nudges: [...next] } } } as never),
      (description) => showToast({ variant: "error", title: language.t("settings.nudges.toast.failed"), description }),
    )

  const open = (item?: ConfigNudge.Info) => {
    const value = item ? structuredClone(item) : blank()
    setDraft(value)
    setEditingID(item?.id ?? "")
    setError(undefined)
  }

  const save = async () => {
    const result = planNudgeSave({ nudges: nudges(), editingID: editingID() || undefined, draft: draft() })
    if (!result.ok) return setError(language.t(REFUSAL_KEY[result.reason]))
    const written = await persist(result.next)
    if (!written.ok) return setError(written.error)
    setEditingID(undefined)
  }

  const remove = async (item: ConfigNudge.Info) => {
    if (
      !(await confirm({
        title: language.t("settings.nudges.confirm.title"),
        description: language.t("settings.nudges.confirm.description", { name: item.name }),
        confirmLabel: language.t("common.delete"),
        destructive: true,
      }))
    )
      return
    await persist(nudges().filter((entry) => entry.id !== item.id))
  }

  const patchHook = (patch: Record<string, string>) =>
    setDraft((item) => ({ ...item, hook: { ...item.hook, ...patch } as ConfigNudge.Hook }))
  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.nudges.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.nudges.description")}</p>
      </div>
      <div class="settings-v2-tab-body">
        <Show when={props.fixedAgentID === undefined}>
          <div class="settings-v2-section">
            <SelectV2
              appearance="inline"
              options={[
                { value: "global", label: language.t("settings.nudges.scope.global") },
                ...colleagues().map((agent) => ({ value: agent.id, label: agent.name })),
              ]}
              current={[
                { value: "global", label: language.t("settings.nudges.scope.global") },
                ...colleagues().map((agent) => ({ value: agent.id, label: agent.name })),
              ].find((option) => option.value === scope())}
              value={(option) => option.value}
              label={(option) => option.label}
              onSelect={(option) => {
                if (!option) return
                setEditingID(undefined)
                setScope(option.value)
              }}
            />
            <Show when={scope() !== "global"}>
              <SettingsRowV2
                title={language.t("settings.nudges.global.enabled")}
                description={language.t("settings.nudges.global.description")}
              >
                <Switch
                  checked={selectedAgentConfig()?.globalNudges !== false}
                  onChange={(enabled) =>
                    void reportedWrite(
                      () => sync().updateConfig({ agents: { [scope()]: { globalNudges: enabled } } } as never),
                      (description) =>
                        showToast({ variant: "error", title: language.t("settings.nudges.toast.failed"), description }),
                    )
                  }
                  hideLabel
                >
                  {language.t("settings.nudges.global.enabled")}
                </Switch>
              </SettingsRowV2>
            </Show>
          </div>
        </Show>
        <Show when={props.fixedAgentID !== undefined}>
          <div class="settings-v2-section">
            <SettingsRowV2
              title={language.t("settings.nudges.global.enabled")}
              description={language.t("settings.nudges.global.description")}
            >
              <Switch
                checked={selectedAgentConfig()?.globalNudges !== false}
                onChange={(enabled) =>
                  void reportedWrite(
                    () => sync().updateConfig({ agents: { [scope()]: { globalNudges: enabled } } } as never),
                    (description) =>
                      showToast({ variant: "error", title: language.t("settings.nudges.toast.failed"), description }),
                  )
                }
                hideLabel
              >
                {language.t("settings.nudges.global.enabled")}
              </Switch>
            </SettingsRowV2>
          </div>
        </Show>
        <div class="settings-v2-section">
          <SettingsListV2>
            <For each={nudges()}>
              {(item) => (
                <SettingsRowV2 title={item.name} description={language.t(HOOK_KEY[item.hook.type])}>
                  <div class="settings-v2-models-row-actions">
                    <ButtonV2 size="small" variant="neutral" onClick={() => open(item)}>
                      {language.t("common.edit")}
                    </ButtonV2>
                    <ButtonV2 size="small" variant="neutral" onClick={() => void remove(item)}>
                      {language.t("common.delete")}
                    </ButtonV2>
                    <Switch
                      checked={item.enabled !== false}
                      onChange={(enabled) =>
                        void persist(nudges().map((entry) => (entry.id === item.id ? { ...entry, enabled } : entry)))
                      }
                      hideLabel
                    >
                      {item.name}
                    </Switch>
                  </div>
                </SettingsRowV2>
              )}
            </For>
          </SettingsListV2>
          <Show when={editingID() === undefined}>
            <ButtonV2 size="small" variant="neutral" onClick={() => open()}>
              {language.t("settings.nudges.add")}
            </ButtonV2>
          </Show>
        </div>

        <Show when={editingID() !== undefined}>
          <div class="settings-v2-section" data-component="settings-nudges-editor">
            <h3 class="settings-v2-section-title">
              {editingID() ? language.t("settings.nudges.edit") : language.t("settings.nudges.add")}
            </h3>
            <TextInputV2
              appearance="base"
              value={draft().name}
              placeholder={language.t("settings.nudges.field.name")}
              onInput={(event) => setDraft((item) => ({ ...item, name: event.currentTarget.value }))}
            />
            <SelectV2
              appearance="inline"
              options={hookOptions()}
              current={hookOptions().find((option) => option.value === draft().hook.type)}
              value={(option) => option.value}
              label={(option) => option.label}
              onSelect={(option) => option && setDraft((item) => ({ ...item, hook: hookFor(option.value) }))}
            />
            <Show when={draft().hook.type === "text-match"}>
              <TextInputV2
                appearance="base"
                value={(draft().hook as { pattern: string }).pattern}
                placeholder={language.t("settings.nudges.field.pattern")}
                spellcheck={false}
                onInput={(event) => patchHook({ pattern: event.currentTarget.value })}
              />
            </Show>
            <Show when={draft().hook.type === "tool-call"}>
              <TextInputV2
                appearance="base"
                value={(draft().hook as { tool: string }).tool}
                placeholder={language.t("settings.nudges.field.tool")}
                spellcheck={false}
                onInput={(event) => patchHook({ tool: event.currentTarget.value })}
              />
              <div class="settings-v2-models-row-actions">
                <For each={toolChoices()}>
                  {(tool) => (
                    <ButtonV2
                      size="small"
                      variant={(draft().hook as { tool: string }).tool === tool ? "gold" : "neutral"}
                      onClick={() => patchHook({ tool })}
                    >
                      {tool}
                    </ButtonV2>
                  )}
                </For>
              </div>
            </Show>
            <Show when={draft().hook.type === "mcp-call"}>
              <TextInputV2
                appearance="base"
                value={(draft().hook as { server: string }).server}
                placeholder={language.t("settings.nudges.field.mcp")}
                spellcheck={false}
                onInput={(event) => patchHook({ server: event.currentTarget.value })}
              />
              <Show when={mcpChoices().length > 0}>
                <div class="settings-v2-models-row-actions">
                  <For each={mcpChoices()}>
                    {(server) => (
                      <ButtonV2
                        size="small"
                        variant={(draft().hook as { server: string }).server === server ? "gold" : "neutral"}
                        onClick={() => patchHook({ server })}
                      >
                        {server}
                      </ButtonV2>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
            <Show when={draft().hook.type === "file-read" || draft().hook.type === "file-write"}>
              <TextInputV2
                appearance="base"
                value={(draft().hook as { extension: string }).extension}
                placeholder={language.t("settings.nudges.field.extension")}
                spellcheck={false}
                onInput={(event) => patchHook({ extension: event.currentTarget.value })}
              />
            </Show>
            <Show when={draft().hook.type === "resource-pressure"}>
              <SelectV2
                appearance="inline"
                options={(["either", "warning", "floor"] as const).map((value) => ({
                  value,
                  label: language.t(RESOURCE_KEY[value]),
                }))}
                current={(["either", "warning", "floor"] as const)
                  .map((value) => ({ value, label: language.t(RESOURCE_KEY[value]) }))
                  .find((option) => option.value === (draft().hook as { level: string }).level)}
                value={(option) => option.value}
                label={(option) => option.label}
                onSelect={(option) => option && patchHook({ level: option.value })}
              />
            </Show>
            <Show when={draft().hook.type === "time-of-day"}>
              <div class="settings-v2-models-row-actions">
                <TextInputV2
                  type="time"
                  appearance="base"
                  value={(draft().hook as { after: string }).after}
                  onInput={(event) => patchHook({ after: event.currentTarget.value })}
                />
                <TextInputV2
                  type="time"
                  appearance="base"
                  value={(draft().hook as { before: string }).before}
                  onInput={(event) => patchHook({ before: event.currentTarget.value })}
                />
              </div>
            </Show>
            <Show when={draft().hook.type === "script"}>
              <TextInputV2
                appearance="base"
                value={(draft().hook as { command: string }).command}
                placeholder={language.t("settings.nudges.field.hookScript")}
                spellcheck={false}
                onInput={(event) => patchHook({ command: event.currentTarget.value })}
              />
            </Show>
            <TextareaV2
              class="settings-v2-textarea"
              rows={5}
              value={draft().text}
              placeholder={language.t("settings.nudges.field.text")}
              onInput={(event) => setDraft((item) => ({ ...item, text: event.currentTarget.value }))}
            />
            <TextInputV2
              appearance="base"
              value={draft().script ?? ""}
              placeholder={language.t("settings.nudges.field.script")}
              spellcheck={false}
              onInput={(event) => setDraft((item) => ({ ...item, script: event.currentTarget.value }))}
            />
            <Show when={error()}>
              {(message) => (
                <p class="settings-v2-field-description" style={{ color: "var(--v2-state-danger-text, #ef4444)" }}>
                  {message()}
                </p>
              )}
            </Show>
            <div class="settings-v2-models-row-actions">
              <ButtonV2 size="small" variant="neutral" onClick={() => void save()}>
                {language.t("common.save")}
              </ButtonV2>
              <ButtonV2 size="small" variant="ghost-muted" onClick={() => setEditingID(undefined)}>
                {language.t("common.cancel")}
              </ButtonV2>
            </div>
          </div>
        </Show>
      </div>
    </>
  )
}
