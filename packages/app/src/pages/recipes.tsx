import { useNavigate, useSearchParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import { RecipeStudio } from "@/components/recipe-studio"
import { useConfirm } from "@/components/dialog-confirm"
import { useServerSDK } from "@/context/server-sdk"
import { recipeStudioApi } from "@/utils/recipe-studio"

export function RecipesPage() {
  const sdk = useServerSDK()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const api = createMemo(() => {
    const base = sdk()?.server.http
    return base ? recipeStudioApi(base) : undefined
  })
  return (
    <RecipeStudio
      api={api()}
      confirm={confirm}
      selectedSlug={typeof params.recipe === "string" ? params.recipe : undefined}
      onDeployed={(id) => {
        window.dispatchEvent(new Event("novaclaw:recipe-deployed"))
        navigate(`/projects?project=${encodeURIComponent(id)}`)
      }}
    />
  )
}
