import { AppPage } from "@/components/app-page"
import { SettingsModelsV2 } from "@/components/settings-v2/models"

// The Models app — its own home screen (owner, 2026-09-16), exactly like the roster at `/tasks`.
//
// ⚠️ It renders the SAME component as Settings → Models rather than a second copy. The two surfaces
// are one screen reached two ways; a fork would drift the moment either gained a control.
//
// No `AppPageHeader` here on purpose: `SettingsModelsV2` already draws its own title row with the
// New-model and Export/Import actions, and that row is sticky. A second header would say "Models"
// twice and push the list down.
export function ModelsPage() {
  return (
    <AppPage class="flex flex-col overflow-hidden">
      <div class="min-h-0 flex-1 overflow-y-auto">
        <SettingsModelsV2 />
      </div>
    </AppPage>
  )
}
