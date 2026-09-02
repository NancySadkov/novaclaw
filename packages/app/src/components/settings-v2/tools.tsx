import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { TextareaV2 } from "@novaclaw/ui/v2/textarea-v2"
import { type Component, For, Show, createSignal } from "solid-js"
import { showToast } from "@/utils/toast"
import { reportedWrite } from "@/utils/config-write"
import { useLanguage, type TranslationKey } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useConfirm } from "@/components/dialog-confirm"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { planRecipeSave, type Recipe, type RecipeRefusal } from "./tools-draft"

// P4 (4E) — the Tools settings tab: define/edit/enable/disable GLOBAL ad-hoc tool recipes
// (`adhoc_tools` config — an array, so updateConfig replaces it wholesale; deletion works,
// unlike record patch-merges). An ad-hoc tool is just {name, description, manual}: the system
// prompt lists name+description, the model pulls the manual on demand (tool_manual) and runs
// it via bash/curl. Session-scoped recipes a model defines via define_tool are per-session
// files, not config — surfacing them here needs an HTTP endpoint (remaining).
//
// What a save is ALLOWED to write — the caps, the name pattern and the collision refusal — lives in
// `tools-draft.ts`, which is where the rename-onto-an-existing-name deletion was closed. This file
// renders and persists; it does not re-derive the rules.

/** One arm per refusal, so a fifth `RecipeRefusal` is a type error naming the missing sentence. */
const REFUSAL_KEY: Record<RecipeRefusal, TranslationKey> = {
  name: "settings.tools.error.name",
  description: "settings.tools.error.description",
  manual: "settings.tools.error.manual",
  duplicate: "settings.tools.error.duplicate",
}

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

  // Returns the VERDICT rather than swallowing it: everything below decides what to do with a
  // failure, and none of it may treat one as a save.
  const persist = (next: readonly Recipe[]) =>
    reportedWrite(
      () => serverSync().updateConfig({ adhoc_tools: next } as never),
      (error) => showToast({ variant: "error", title: language.t("settings.tools.toast.failed"), description: error }),
    )

  async function saveDraft() {
    const plan = planRecipeSave({
      recipes: recipes(),
      editing: editing() ?? "",
      name: draftName(),
      description: draftDescription(),
      manual: draftManual(),
    })
    if (!plan.ok) return setDraftError(language.t(REFUSAL_KEY[plan.reason]))
    setDraftError(undefined)
    const saved = await persist(plan.next)
    // 🔴 The editor closes ONLY on a landed write. It used to close unconditionally, which threw
    // away an 8 KB manual the moment the instance was momentarily unreachable — a toast said so and
    // the only copy of the text went with the unmount. The draft is the user's, so the failure is
    // named where the draft still is rather than only in a toast.
    if (!saved.ok) return setDraftError(`${language.t("settings.tools.error.saveFailed")} ${saved.error}`)
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
