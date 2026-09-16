import { useNavigate } from "@solidjs/router"
import { AppPage } from "@/components/app-page"
import { SettingsModelsV2 } from "@/components/settings-v2/models"

// The Models app — its own home screen (owner, 2026-09-16), exactly like the roster at `/tasks`.
//
// ⚠️ It renders the SAME manager component the (retired) Settings tab used; a fork would drift the
// moment either gained a control. The PAGE owns routing, so Configure is handed in as a callback
// rather than the manager calling `useNavigate()`: the manager then stays mountable in a harness with
// no Router.
//
// No `AppPageHeader` here on purpose: the manager already draws its own title row with the New-model
// and Export/Import actions, and that row is sticky. A second header would say "Models" twice and
// push the list down.
export function ModelsPage() {
  const navigate = useNavigate()
  return (
    <AppPage class="flex flex-col overflow-hidden">
      <div class="min-h-0 flex-1 overflow-y-auto">
        <SettingsModelsV2
          onConfigure={(key) => {
            // Full-screen, like the officer's settings page — not a dialog. The ids ride SEARCH PARAMS
            // because a catalog model id can contain a slash, which a path segment would split.
            const params = new URLSearchParams({
              providerID: key.providerID,
              modelID: key.modelID,
              returnTo: "/models",
            })
            navigate(`/models/configure?${params.toString()}`)
          }}
        />
      </div>
    </AppPage>
  )
}
