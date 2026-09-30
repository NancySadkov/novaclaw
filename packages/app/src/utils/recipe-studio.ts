import { parseRecipeDocument } from "@novaclaw/schema/recipe-document"
import type { ServerConnection } from "@/context/server"
import * as recipes from "./recipe-api"

export const recipeStudioApi = (server: ServerConnection.HttpBase) => ({
  list: () => recipes.listRecipes(server),
  load: async (slug: string) => {
    const [source, assets] = await Promise.all([
      recipes.recipeSource(server, slug),
      recipes.listRecipeAssets(server, slug),
    ])
    const document = parseRecipeDocument(source.source)
    return { needs: document.needs ?? [], produces: document.produces ?? [], assets }
  },
  create: (input: recipes.SaveRecipeInput) => recipes.saveRecipe(server, input),
  update: (slug: string, input: recipes.UpdateRecipeInput) => recipes.updateRecipe(server, slug, input),
  readAsset: (slug: string, path: string) => recipes.readRecipeAsset(server, slug, path),
  writeAsset: (slug: string, asset: recipes.RecipeAssetContent) => recipes.writeRecipeAsset(server, slug, asset),
  deleteAsset: (slug: string, path: string) => recipes.deleteRecipeAsset(server, slug, path),
  preview: (bytes: Uint8Array<ArrayBuffer>) => recipes.previewRecipeArchive(server, bytes),
  import: (bytes: Uint8Array<ArrayBuffer>) => recipes.importRecipeArchive(server, bytes),
  export: (slug: string) => recipes.recipeArchive(server, slug),
  duplicate: (slug: string) => recipes.duplicateRecipe(server, slug),
  remove: (slug: string) => recipes.removeRecipe(server, slug),
  deploy: (slug: string, directory?: string) => recipes.deployRecipe(server, slug, { directory }),
})

export type RecipeStudioApi = ReturnType<typeof recipeStudioApi>

export const recipeFileBytes = (asset: recipes.RecipeAssetContent) =>
  asset.encoding === "base64"
    ? Uint8Array.from(atob(asset.content), (value) => value.charCodeAt(0))
    : new TextEncoder().encode(asset.content)

export const recipeFileImage = (path: string) => {
  const extension = path.split(".").at(-1)?.toLowerCase()
  return (
    { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as Record<
      string,
      string
    >
  )[extension ?? ""]
}
