import { TextField } from "@novaclaw/ui/text-field"
import { Logo } from "@novaclaw/ui/logo"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Component, createSignal, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { Icon } from "@novaclaw/ui/v2/icon"
import { errorDescriptionKey } from "./error-description"
import { DISCORD_INVITE_URL } from "@/constants/links"

export type InitError = {
  name: string
  data: Record<string, unknown>
}

type Translator = ReturnType<typeof useLanguage>["t"]
const CHAIN_SEPARATOR = "\n" + "─".repeat(40) + "\n"

function isIssue(value: unknown): value is { message: string; path: string[] } {
  if (!value || typeof value !== "object") return false
  if (!("message" in value) || !("path" in value)) return false
  const message = (value as { message: unknown }).message
  const path = (value as { path: unknown }).path
  if (typeof message !== "string") return false
  if (!Array.isArray(path)) return false
  return path.every((part) => typeof part === "string")
}

function isInitError(error: unknown): error is InitError {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    "data" in error &&
    typeof (error as InitError).data === "object"
  )
}

function safeJson(value: unknown, circular: string): string {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === "bigint") return val.toString()
      if (typeof val === "object" && val) {
        if (seen.has(val)) return circular
        seen.add(val)
      }
      return val
    },
    2,
  )
  return json ?? String(value)
}

function formatInitError(error: InitError, t: Translator): string {
  const data = error.data
  const json = (value: unknown) => safeJson(value, t("error.page.circular"))
  switch (error.name) {
    case "MCPFailed": {
      const name = typeof data.name === "string" ? data.name : ""
      return t("error.chain.mcpFailed", { name })
    }
    case "APIError": {
      const message = typeof data.message === "string" ? data.message : t("error.chain.apiError")
      const lines: string[] = [message]

      if (typeof data.statusCode === "number") {
        lines.push(t("error.chain.status", { status: data.statusCode }))
      }

      if (typeof data.isRetryable === "boolean") {
        lines.push(t("error.chain.retryable", { retryable: data.isRetryable }))
      }

      if (typeof data.responseBody === "string" && data.responseBody) {
        lines.push(t("error.chain.responseBody", { body: data.responseBody }))
      }

      return lines.join("\n")
    }
    case "ProviderModelNotFoundError": {
      const { providerID, modelID, suggestions } = data as {
        providerID: string
        modelID: string
        suggestions?: string[]
      }

      const suggestionsLine =
        Array.isArray(suggestions) && suggestions.length
          ? [t("error.chain.didYouMean", { suggestions: suggestions.join(", ") })]
          : []

      return [
        t("error.chain.modelNotFound", { provider: providerID, model: modelID }),
        ...suggestionsLine,
        t("error.chain.checkConfig"),
      ].join("\n")
    }
    case "ProviderInitError": {
      const providerID = typeof data.providerID === "string" ? data.providerID : t("common.unknown")
      return t("error.chain.providerInitFailed", { provider: providerID })
    }
    case "ConfigJsonError": {
      const path = typeof data.path === "string" ? data.path : json(data.path)
      const message = typeof data.message === "string" ? data.message : ""
      if (message) return t("error.chain.configJsonInvalidWithMessage", { path, message })
      return t("error.chain.configJsonInvalid", { path })
    }
    case "ConfigDirectoryTypoError": {
      const path = typeof data.path === "string" ? data.path : json(data.path)
      const dir = typeof data.dir === "string" ? data.dir : json(data.dir)
      const suggestion = typeof data.suggestion === "string" ? data.suggestion : json(data.suggestion)
      return t("error.chain.configDirectoryTypo", { dir, path, suggestion })
    }
    case "ConfigFrontmatterError": {
      const path = typeof data.path === "string" ? data.path : json(data.path)
      const message = typeof data.message === "string" ? data.message : json(data.message)
      return t("error.chain.configFrontmatterError", { path, message })
    }
    case "ConfigInvalidError": {
      const issues = Array.isArray(data.issues)
        ? data.issues.filter(isIssue).map((issue) => "↳ " + issue.message + " " + issue.path.join("."))
        : []
      const message = typeof data.message === "string" ? data.message : ""
      const path = typeof data.path === "string" ? data.path : json(data.path)

      const line = message
        ? t("error.chain.configInvalidWithMessage", { path, message })
        : t("error.chain.configInvalid", { path })

      return [line, ...issues].join("\n")
    }
    case "UnknownError":
      return typeof data.message === "string" ? data.message : json(data)
    default:
      if (typeof data.message === "string") return data.message
      return json(data)
  }
}

function formatErrorChain(error: unknown, t: Translator, depth = 0, parentMessage?: string): string {
  const json = (value: unknown) => safeJson(value, t("error.page.circular"))
  if (!error) return t("error.chain.unknown")

  if (isInitError(error)) {
    const message = formatInitError(error, t)
    if (depth > 0 && parentMessage === message) return ""
    const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""
    return indent + `${error.name}\n${message}`
  }

  if (error instanceof Error) {
    const isDuplicate = depth > 0 && parentMessage === error.message
    const parts: string[] = []
    const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""

    const header = `${error.name}${error.message ? `: ${error.message}` : ""}`
    const stack = error.stack?.trim()

    if (stack) {
      const startsWithHeader = stack.startsWith(header)

      if (isDuplicate && startsWithHeader) {
        const trace = stack.split("\n").slice(1).join("\n").trim()
        if (trace) {
          parts.push(indent + trace)
        }
      }

      if (isDuplicate && !startsWithHeader) {
        parts.push(indent + stack)
      }

      if (!isDuplicate && startsWithHeader) {
        parts.push(indent + stack)
      }

      if (!isDuplicate && !startsWithHeader) {
        parts.push(indent + `${header}\n${stack}`)
      }
    }

    if (!stack && !isDuplicate) {
      parts.push(indent + header)
    }

    if (error.cause) {
      const causeResult = formatErrorChain(error.cause, t, depth + 1, error.message)
      if (causeResult) {
        parts.push(causeResult)
      }
    }

    return parts.join("\n\n")
  }

  if (typeof error === "string") {
    if (depth > 0 && parentMessage === error) return ""
    const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""
    return indent + error
  }

  const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""
  return indent + json(error)
}

function formatError(error: unknown, t: Translator): string {
  return formatErrorChain(error, t, 0)
}

interface ErrorPageProps {
  error: unknown
  /** When provided (root ErrorBoundary), a "Try again" button resets the boundary and re-renders in place —
   *  recovering from a TRANSIENT fault without a full reload/restart. The "never breaks in your hands" promise. */
  reset?: () => void
}

export const ErrorPage: Component<ErrorPageProps> = (props) => {
  const platform = usePlatform()
  const language = useLanguage()
  const formattedError = () => formatError(props.error, language.t)
  const [showDetails, setShowDetails] = createSignal(false)
  let recordedFatalError: Promise<void> | undefined
  /**
   * 🔴 **A recovery action's failure is SPLIT — a sentence for the page, the chain for the
   * disclosure — because this is the one screen where a stack trace must not be the body text.**
   *
   * The page already got this right for the fault that brought the user here: `errorDescriptionKey`
   * writes a plain headline and `formatError`'s output — which deliberately emits `error.stack` and
   * walks `error.cause` under `Caused by` rules — sits behind "Show technical details". The action
   * handler then wrote that same output straight into `actionError`, which rendered uncollapsed, in
   * danger red, under the buttons. So pressing "Export Logs" on the crash screen and having it fail
   * answered a frightened non-technical user with a multi-frame stack trace.
   *
   * AGENTS.md: the UI *"never crashes to a dead-end … a calm 'connection lost — reconnecting…',
   * never a stack trace or a white screen"*. That rule is at its strongest here, because everybody
   * who reads this page arrives already knowing something broke.
   *
   * ⚠️ **The detail is not discarded — it is MOVED.** It joins the existing disclosure under its own
   * separator, so a developer, a support request and the copy button all still reach it; only the
   * default view changes. Deleting it would trade one failure of this page for another.
   */
  const [store, setStore] = createStore({
    actionError: undefined as { readonly message: string; readonly detail: string } | undefined,
  })

  /**
   * What "Show technical details" reveals: the fault itself, plus whatever a recovery action added.
   *
   * ⚠️ One field rather than a second disclosure — the user has already been told where the detail
   * is, and a page that grows a new collapsed box per failed button is a worse answer than a longer
   * one in the box they were pointed at.
   */
  const detailsText = () => {
    const problem = store.actionError
    if (!problem) return formattedError()
    return `${formattedError()}\n${CHAIN_SEPARATOR}${language.t("error.page.details.actionFailure")}\n${problem.detail}`
  }

  function ensureFatalErrorRecorded() {
    recordedFatalError ??=
      platform.recordFatalRendererError?.({
        error: formattedError(),
        url: location.href,
        version: platform.version,
        platform: platform.platform,
        os: platform.os,
      }) ?? Promise.resolve()
    return recordedFatalError
  }

  onMount(() => {
    void ensureFatalErrorRecorded().catch(() => undefined)
  })

  async function exportDebugLogs() {
    const exportLogs = platform.exportDebugLogs
    if (!exportLogs) return
    await ensureFatalErrorRecorded()
      .then(() => exportLogs())
      .then(() => setStore("actionError", undefined))
      .catch((err) => {
        // ⚠️ The failure is still REPORTED — ruling 2's first half, a failed mutation never reports
        // success. What changed is which half of it the page reads out loud.
        setStore("actionError", {
          message: language.t("error.page.action.exportLogs.failed"),
          detail: formatError(err, language.t),
        })
      })
  }

  return (
    <div
      data-component="error-page"
      class="relative flex-1 h-screen w-screen min-h-0 flex flex-col items-center justify-center bg-v2-background-bg-deep font-sans"
    >
      <div class="w-2/3 max-w-3xl flex flex-col items-center justify-center gap-8">
        <Logo class="w-58.5 opacity-12 shrink-0" />
        <div class="flex flex-col items-center gap-2 text-center">
          <h1 class="text-lg font-medium text-v2-text-text-base">{language.t("error.page.title")}</h1>
          <p class="text-sm text-v2-text-text-muted">{language.t(errorDescriptionKey(props.error))}</p>
        </div>
        {/* SP7: don't confront everyone with the raw stack/cause chain — tuck it behind a disclosure
            (collapsed by default; the error page renders above SettingsProvider, so it can't read the
            expertise level to auto-open in Developer). */}
        <div class="flex w-full flex-col items-center gap-2">
          <button
            type="button"
            class="text-xs font-medium text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted"
            onClick={() => setShowDetails((v) => !v)}
          >
            {showDetails() ? language.t("error.page.details.hide") : language.t("error.page.details.show")}
          </button>
          <Show when={showDetails()}>
            <TextField
              value={detailsText()}
              readOnly
              copyable
              multiline
              class="max-h-96 w-full font-mono text-xs no-scrollbar"
              label={language.t("error.page.details.label")}
              hideLabel
            />
          </Show>
        </div>
        <div class="flex flex-row items-center justify-center gap-3 flex-wrap max-w-64">
          <Show when={props.reset}>
            <ButtonV2 size="large" onClick={() => props.reset?.()}>
              {language.t("error.page.action.retry")}
            </ButtonV2>
          </Show>
          <ButtonV2 size="large" variant={props.reset ? "ghost" : undefined} onClick={platform.restart}>
            {language.t("error.page.action.restart")}
          </ButtonV2>
          <Show when={platform.platform === "desktop" && platform.exportDebugLogs}>
            <ButtonV2 size="large" variant="ghost" onClick={exportDebugLogs}>
              {language.t("error.page.action.exportLogs")}
            </ButtonV2>
          </Show>
        </div>
        <Show when={store.actionError}>
          {(problem) => (
            <p class="text-xs text-v2-state-fg-danger text-center max-w-2xl" data-slot="error-page-action-error">
              {problem().message}
            </p>
          )}
        </Show>
        <div class="flex flex-col items-center gap-2">
          <div class="flex items-center justify-center gap-1">
            {language.t("error.page.report.prefix")}
            <button
              type="button"
              class="flex items-center text-v2-text-text-accent gap-1"
              onClick={() => platform.openLink(DISCORD_INVITE_URL)}
            >
              <div>{language.t("error.page.report.discord")}</div>
              <Icon name="discord" class="text-v2-text-text-accent" size="large" />
            </button>
          </div>
          <Show when={platform.version}>
            {(version) => (
              <p class="text-xs text-v2-text-text-muted">{language.t("error.page.version", { version: version() })}</p>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
