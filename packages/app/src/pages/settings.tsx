import { useNavigate, useSearchParams } from "@solidjs/router"
import { AppPage } from "@/components/app-page"
import { SettingsScreen } from "@/components/settings-v2/settings-screen"

export function SettingsPage() {
  const [query] = useSearchParams<{ tab?: string; returnTo?: string }>()
  const navigate = useNavigate()
  const dismiss = () => {
    const target = query.returnTo
    navigate(target?.startsWith("/") && !target.startsWith("//") ? target : "/")
  }
  return (
    <AppPage class="flex flex-col overflow-hidden">
      <SettingsScreen defaultTab={query.tab} onDismiss={dismiss} />
    </AppPage>
  )
}
