import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { TextareaV2 } from "@novaclaw/ui/v2/textarea-v2"
import { type Component, For, Show, createSignal } from "solid-js"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useConfirm } from "@/components/dialog-confirm"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// P4 (4E) — the Tools settings tab: define/edit/enable/disable GLOBAL ad-hoc tool recipes
// (`adhoc_tools` config — an array, so updateConfig replaces it wholesale; deletion works,
// unlike record patch-merges). An ad-hoc tool is just {name, description, manual}: the system
// prompt lists name+description, the model pulls the manual on demand (tool_manual) and runs
// it via bash/curl. Session-scoped recipes a model defines via define_tool are per-session
// files, not config — surfacing them here needs an HTTP endpoint (remaining).
//
// Caps mirror core/adhoc-tools.ts validation so errors surface at edit time, not at use time.

interface Recipe {
  name: string
  description: string
  manual: string
  enabled?: boolean
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/
const MAX_DESCRIPTION_CHARS = 300
const MAX_MANUAL_CHARS = 8_192

export const SettingsToolsV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()
  const confirm = useConfirm()

  const recipes = (): Recipe[] =>
    ((serverSync().data.config as { adhoc_tools?: Recipe[] }).adhoc_tools ?? []) as Recipe[]

  // Editor state: undefined = closed; "" = adding new; a name = editing that recipe.
  const [editing, setEditing] = createSignal<string | undefined>(undefined)
  const [draftName, setDraftName] = createSignal("")
  const [draftDescription, setDraftDescription] = createSignal("")
  const [draftManual, setDraftManual] = createSignal("")
  const [draftError, setDraftError] = createSignal<string | undefined>(undefined)

  function openEditor(recipe?: Recipe) {
    setDraftName(recipe?.name ?? "")
    setDraftDescription(recipe?.description ?? "")
    setDraftManual(recipe?.manual ?? "")
    setDraftError(undefined)
    setEditing(recipe?.name ?? "")
  }

  async function persist(next: Recipe[]) {
    await serverSync()
      .updateConfig({ adhoc_tools: next } as never)
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: language.t("settings.tools.toast.failed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  async function saveDraft() {
    const name = draftName().trim()
    const description = draftDescription().trim()
    const manual = draftManual().trim()
    if (!NAME_PATTERN.test(name)) return setDraftError(language.t("settings.tools.error.name"))
    if (!description || description.length > MAX_DESCRIPTION_CHARS)
      return setDraftError(language.t("settings.tools.error.description"))
    if (!manual || manual.length > MAX_MANUAL_CHARS) return setDraftError(language.t("settings.tools.error.manual"))
    const original = editing()
    const others = recipes().filter((recipe) => recipe.name !== original && recipe.name !== name)
    if (original === "" && recipes().some((recipe) => recipe.name === name))
      return setDraftError(language.t("settings.tools.error.duplicate"))
    const kept = recipes().find((recipe) => recipe.name === original)
    await persist([...others, { name, description, manual, ...(kept?.enabled === false ? { enabled: false } : {}) }])
    setEditing(undefined)
  }

  async function remove(name: string) {
    const ok = await confirm({
      title: language.t("settings.tools.confirm.title"),
      description: language.t("settings.tools.confirm.description", { name }),
      confirmLabel: language.t("common.delete"),
      destructive: true,
    })
    if (!ok) return
    await persist(recipes().filter((recipe) => recipe.name !== name))
  }

  async function toggle(name: string, enabled: boolean) {
    await persist(recipes().map((recipe) => (recipe.name === name ? { ...recipe, enabled } : recipe)))
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.tools.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.tools.description")}</p>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <Show
            when={recipes().length > 0}
            fallback={<div class="settings-v2-models-status">{language.t("settings.tools.empty")}</div>}
          >
            <SettingsListV2>
              <For each={recipes()}>
                {(recipe) => (
                  <SettingsRowV2 title={recipe.name} description={recipe.description}>
                    <div class="settings-v2-models-row-actions">
                      <ButtonV2 size="small" variant="neutral" onClick={() => openEditor(recipe)}>
                        {language.t("settings.tools.edit")}
                      </ButtonV2>
                      <ButtonV2 size="small" variant="neutral" onClick={() => void remove(recipe.name)}>
                        {language.t("settings.tools.delete")}
                      </ButtonV2>
                      <Switch
                        checked={recipe.enabled !== false}
                        onChange={(checked) => void toggle(recipe.name, checked)}
                        hideLabel
                      >
                        {recipe.name}
                      </Switch>
                    </div>
                  </SettingsRowV2>
                )}
              </For>
            </SettingsListV2>
          </Show>
          <Show when={editing() === undefined}>
            <div>
              <ButtonV2 size="small" variant="neutral" onClick={() => openEditor()}>
                {language.t("settings.tools.add")}
              </ButtonV2>
            </div>
          </Show>
        </div>

        <Show when={editing() !== undefined}>
          <div class="settings-v2-section" data-component="settings-tools-editor">
            <h3 class="settings-v2-section-title">
              {editing() === "" ? language.t("settings.tools.add") : language.t("settings.tools.edit")}
            </h3>
            <div class="w-full sm:w-[260px]">
              <TextInputV2
                type="text"
                appearance="base"
                value={draftName()}
                placeholder={language.t("settings.tools.field.name")}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                onInput={(event) => setDraftName(event.currentTarget.value)}
                aria-label={language.t("settings.tools.field.name")}
              />
            </div>
            <div class="w-full">
              <TextInputV2
                type="text"
                appearance="base"
                value={draftDescription()}
                placeholder={language.t("settings.tools.field.description")}
                spellcheck={false}
                onInput={(event) => setDraftDescription(event.currentTarget.value)}
                aria-label={language.t("settings.tools.field.description")}
              />
            </div>
            <TextareaV2
              class="settings-v2-textarea"
              rows={6}
              value={draftManual()}
              placeholder={language.t("settings.tools.field.manual")}
              spellcheck={false}
              onInput={(event) => setDraftManual(event.currentTarget.value)}
              aria-label={language.t("settings.tools.field.manual")}
            />
            <Show when={draftError()}>
              <p class="settings-v2-field-description" style={{ color: "var(--v2-state-danger-text, #ef4444)" }}>
                {draftError()}
              </p>
            </Show>
            <div class="settings-v2-models-row-actions">
              <ButtonV2 size="small" variant="neutral" onClick={() => void saveDraft()}>
                {language.t("settings.tools.save")}
              </ButtonV2>
              <ButtonV2 size="small" variant="ghost-muted" onClick={() => setEditing(undefined)}>
                {language.t("settings.tools.cancel")}
              </ButtonV2>
            </div>
          </div>
        </Show>
      </div>
    </>
  )
}
