// ⚠️ This file used to declare its own `type Translator = (key: string, ...) => string`. That reads
// like the permissive option and is in fact the UNSATISFIABLE one: the app's `t` is key-typed, and
// parameters are contravariant, so a translator that only accepts real keys is not assignable to one
// claiming to accept any string. Import the alias; never re-declare a looser local copy.
import type { Translator, TranslationKey } from "@/context/language"

export type ConfigInvalidError = {
  name: "ConfigInvalidError"
  data: {
    path?: string
    message?: string
    issues?: Array<{ message: string; path: string[] }>
  }
}

export type ProviderModelNotFoundError = {
  name: "ProviderModelNotFoundError"
  data: {
    providerID: string
    modelID: string
    suggestions?: string[]
  }
}

function tr(
  translator: Translator | undefined,
  key: TranslationKey,
  text: string,
  vars?: Record<string, string | number>,
) {
  if (!translator) return text
  const out = translator(key, vars)
  if (!out || out === key) return text
  return out
}

export function formatServerError(error: unknown, translate?: Translator, fallback?: string) {
  const unwrapped = unwrapNamedError(error)
  if (isConfigInvalidErrorLike(unwrapped)) return parseReadableConfigInvalidError(unwrapped, translate)
  if (isProviderModelNotFoundErrorLike(unwrapped)) return parseReadableProviderModelNotFoundError(unwrapped, translate)
  if (isNamedMessageErrorLike(unwrapped)) return unwrapped.data.message
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  if (fallback) return fallback
  return tr(translate, "error.chain.unknown", "Unknown error")
}

function unwrapNamedError(error: unknown): unknown {
  if (error instanceof Error && error.cause && typeof error.cause === "object" && "body" in error.cause) {
    return (error.cause as Record<string, unknown>).body
  }
  return error
}

export function isSessionNotFoundError(error: unknown, sessionID: string) {
  // Bare client-synthesized Error (result-tuple path).
  if (error instanceof Error && error.message === `Session not found: ${sessionID}`) return true
  const unwrapped = unwrapNamedError(error)
  if (typeof unwrapped !== "object" || unwrapped === null) return false
  const value = unwrapped as Record<string, unknown>
  // Tagged shape (if ever emitted).
  if (value._tag === "SessionNotFoundError" && value.sessionID === sessionID) return true
  // wrapClientError path: cause.body = { name:"NotFoundError", data:{ message:"Session not found: <id>" } }.
  // Scope to THIS session via the server-authored message so other 404s stay visible.
  const data = value.data as { message?: unknown } | undefined
  if (value.name === "NotFoundError" && typeof data?.message === "string" && data.message.includes(sessionID))
    return true
  return false
}

export function isMissingDirectoryError(error: unknown) {
  const matches = (value: unknown) =>
    typeof value === "string" && value.trimStart().startsWith("Directory does not exist:")
  if (error instanceof Error && matches(error.message)) return true
  if (matches(error)) return true
  const unwrapped = unwrapNamedError(error)
  if (typeof unwrapped !== "object" || unwrapped === null) return false
  if (!("name" in unwrapped) || !("data" in unwrapped)) return false
  const data = unwrapped.data
  if (typeof data !== "object" || data === null) return false
  if (!("field" in data) || !("message" in data)) return false
  return unwrapped.name === "InvalidRequestError" && data.field === "directory" && matches(data.message)
}

function isConfigInvalidErrorLike(error: unknown): error is ConfigInvalidError {
  if (typeof error !== "object" || error === null) return false
  const o = error as Record<string, unknown>
  return o.name === "ConfigInvalidError" && typeof o.data === "object" && o.data !== null
}

function isProviderModelNotFoundErrorLike(error: unknown): error is ProviderModelNotFoundError {
  if (typeof error !== "object" || error === null) return false
  const o = error as Record<string, unknown>
  return o.name === "ProviderModelNotFoundError" && typeof o.data === "object" && o.data !== null
}

function isNamedMessageErrorLike(error: unknown): error is { name: string; data: { message: string } } {
  if (typeof error !== "object" || error === null) return false
  const value = error as Record<string, unknown>
  if (typeof value.name !== "string" || typeof value.data !== "object" || value.data === null) return false
  return typeof (value.data as Record<string, unknown>).message === "string"
}

export function parseReadableConfigInvalidError(errorInput: ConfigInvalidError, translator?: Translator) {
  const file = errorInput.data.path && errorInput.data.path !== "config" ? errorInput.data.path : "config"
  const detail = errorInput.data.message?.trim() ?? ""
  const issues = (errorInput.data.issues ?? [])
    .map((issue) => {
      const msg = issue.message.trim()
      if (!issue.path.length) return msg
      return `${issue.path.join(".")}: ${msg}`
    })
    .filter(Boolean)
  const msg = issues.length ? issues.join("\n") : detail
  if (!msg) return tr(translator, "error.chain.configInvalid", `Config file at ${file} is invalid`, { path: file })
  return tr(translator, "error.chain.configInvalidWithMessage", `Config file at ${file} is invalid: ${msg}`, {
    path: file,
    message: msg,
  })
}

function parseReadableProviderModelNotFoundError(errorInput: ProviderModelNotFoundError, translator?: Translator) {
  const p = errorInput.data.providerID.trim()
  const m = errorInput.data.modelID.trim()
  const list = (errorInput.data.suggestions ?? []).map((v) => v.trim()).filter(Boolean)
  const body = tr(translator, "error.chain.modelNotFound", `Model not found: ${p}/${m}`, { provider: p, model: m })
  const tail = tr(
    translator,
    "error.chain.checkConfig",
    "Check the model in Settings → Models — it may have been renamed or removed.",
  )
  if (list.length) {
    const suggestions = list.slice(0, 5).join(", ")
    return [body, tr(translator, "error.chain.didYouMean", `Did you mean: ${suggestions}`, { suggestions }), tail].join(
      "\n",
    )
  }
  return [body, tail].join("\n")
}
