import { decodeRecipeOfficers, type RecipeOfficer } from "./recipe-officer"

export interface RecipeDocument extends Record<string, unknown> {
  readonly version: 1
  readonly name: string
  readonly description?: string
  readonly prompt: string
  readonly needs?: readonly string[]
  readonly produces?: readonly string[]
  readonly officers?: readonly RecipeOfficer[]
}

export class RecipeFormatError extends Error {}

export const RECIPE_DOCUMENT_CAP = 1024 * 1024

export const parseRecipeDocument = (source: string): RecipeDocument => {
  try {
    if (new TextEncoder().encode(source).length > RECIPE_DOCUMENT_CAP)
      throw new Error("The recipe is too big. Maximum size is 1 MB.")
    const value: unknown = JSON.parse(source)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.")
    const document = value as Record<string, unknown>
    if (document.version !== 1)
      throw new Error(`Unsupported recipe version ${JSON.stringify(document.version) ?? "(missing)"}. Expected 1.`)
    if (typeof document.name !== "string" || !document.name.trim()) throw new Error("A recipe needs a name.")
    if (typeof document.prompt !== "string" || !document.prompt.trim()) throw new Error("A recipe needs a prompt.")
    if (document.description !== undefined && typeof document.description !== "string")
      throw new Error("description must be text.")
    for (const key of ["needs", "produces"])
      if (
        document[key] !== undefined &&
        (!Array.isArray(document[key]) ||
          !document[key].every((item: unknown) => typeof item === "string" && item.trim()))
      )
        throw new Error(`${key} must be an array of nonempty strings.`)
    if (document.officers !== undefined) decodeRecipeOfficers(document.officers)
    return document as RecipeDocument
  } catch (cause) {
    throw new RecipeFormatError(`Invalid recipe.json: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}
