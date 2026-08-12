export * as WebFetchTool from "./webfetch"

import { ToolFailure } from "@novaclaw/llm"
import { Duration, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import TurndownService from "turndown"
import { makeLocationNode } from "../effect/app-node"
import { LayerNodePlatform } from "../effect/app-node-platform"
import { PermissionV2 } from "../permission"
import { SessionOrigin } from "../session/origin"
import { collectBoundedResponseBody } from "./http-body"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { WebGovernor } from "../web/governor"
import { CalloutPolicy } from "../callout-policy"

export const name = "webfetch"
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
export const DEFAULT_TIMEOUT_SECONDS = 30
export const MAX_TIMEOUT_SECONDS = 120

export const description = `Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.

Use a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.

Fetches STATIC HTML only — it does not run JavaScript. A chat platform (t.me / Telegram, Discord, VK) returns an empty shell here, with none of the posts. Do NOT report such a page as having no content: read the channel through the \`messenger\` tool instead, using the user's own connected account. If a site refuses us outright, record it as inaccessible rather than retrying.`

const Timeout = Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_TIMEOUT_SECONDS))

export const Input = Schema.Struct({
  url: Schema.String.annotate({ description: "The HTTP or HTTPS URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({ description: "The format to return the content in. Defaults to markdown." })
    .pipe(Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Timeout.pipe(Schema.optional).annotate({
    description: `Optional timeout in seconds (maximum: ${MAX_TIMEOUT_SECONDS})`,
  }),
})

const Output = Schema.Struct({
  url: Schema.String,
  contentType: Schema.String,
  format: Input.fields.format,
  output: Schema.String,
})

type Format = (typeof Input.Type)["format"]

const acceptHeader = (format: Format) => {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
  }
  return "*/*"
}

const headers = (format: Format, userAgent: string) => ({
  "User-Agent": userAgent,
  Accept: acceptHeader(format),
  "Accept-Language": "en-US,en;q=0.9",
})

const browserUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

const isCloudflareChallenge = (error: unknown) => {
  if (!error || typeof error !== "object" || !("reason" in error)) return false
  const reason = error.reason
  if (
    !reason ||
    typeof reason !== "object" ||
    !("_tag" in reason) ||
    reason._tag !== "StatusCodeError" ||
    !("response" in reason)
  )
    return false
  const response = reason.response as HttpClientResponse.HttpClientResponse
  return response.status === 403 && response.headers["cf-mitigated"] === "challenge"
}

const request = (url: string, format: Format, userAgent = browserUserAgent) =>
  HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers(format, userAgent)))

const assertHttpUrl = (url: URL) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http:// or https://")
}

const execute = (http: HttpClient.HttpClient, url: string, format: Format, userAgent = browserUserAgent) =>
  http.execute(request(url, format, userAgent)).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))

const collectBody = (response: HttpClientResponse.HttpClientResponse) =>
  collectBoundedResponseBody(
    response,
    MAX_RESPONSE_BYTES,
    () => new Error(`Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`),
  )

const mimeFrom = (contentType: string) => contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
const isImageAttachment = (mime: string) =>
  mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
const isTextualMime = (mime: string) =>
  !mime ||
  mime.startsWith("text/") ||
  mime === "application/json" ||
  mime.endsWith("+json") ||
  mime === "application/xml" ||
  mime.endsWith("+xml") ||
  mime === "application/javascript" ||
  mime === "application/x-javascript"

// ── Untrusted-input framing ─────────────────────────────────────────────────────────────────────
//
// A fetched page is a stranger's prose arriving inside our own turn — the same class of input the
// messenger client/audience frames exist for (`session/origin.ts`), and until 2026-07-30 the only
// one of the two that was framed at all. The shared helper owns the WORDING; this file only decides
// what to call the source.
//
// The HOST, not the whole URL: the URL is already in the model's own tool call, so repeating it
// costs tokens on every fetch and says nothing new, while the host is the fact that actually decides
// how much weight to give the bytes. A URL that will not parse is named verbatim rather than
// guessed at — the frame says what is known and no more (ruling 2).
export const sourceLabel = (url: string): string => {
  try {
    return `fetched from ${new URL(url).host}`
  } catch {
    return `fetched from ${url}`
  }
}

/** The model-facing projection: the frame, then the page. Exported so the wording is pinned by a
 *  test rather than by whoever reads the file next (`test/untrusted-framing.test.ts`). */
export const toModelOutput = (output: { readonly url: string; readonly output: string }): string =>
  SessionOrigin.externalContentFrame(sourceLabel(output.url)) + output.output

/**
 * An extraction that yields nothing must SAY nothing came out.
 *
 * ⚠️ The silent case this exists for: a page answers 200 with `text/html`, the body arrives whole
 * and well under the size cap, and conversion produces an empty string. Every failure signal the
 * tool has — status, content type, byte cap, timeout — reports success, so the model receives the
 * untrusted-content frame with nothing after it and has no way to tell an empty page from an
 * unextractable one. The likeliest reading is "this page is blank", which is wrong.
 *
 * Deliberately no size threshold. A floor would need a number nothing measures, and the note is TRUE
 * at every size — a 40-byte document that extracts to nothing is still better described than
 * silently empty. The wording names the byte count so the reader can judge which case they are in,
 * and states that the fetch itself succeeded, because the one wrong response here is a retry.
 *
 * ✅ **The SPA-shell case is now caught too (2026-08-12), by a parse rather than a threshold.** This
 * guard used to ask "did conversion produce anything", and a JS-rendered shell answers YES: it
 * carries `<title>App</title>`, the converter lifts it, and a one-word output reads as page content —
 * worse than an empty one, which at least reads as nothing. The question was never how SHORT the
 * output is, so no byte floor could have answered it; it is whether the BODY said anything, which
 * `bodyTextFromHTML` answers exactly. The title is then NAMED in the note rather than returned as if
 * it were the article.
 */
const emptyExtractionNote = (bytes: number, format: Format, title: string) =>
  `[No readable text could be extracted. The server returned ${bytes} bytes of HTML and its body ` +
  `carried no text` +
  (title === "" ? "" : ` — only the page title, ${JSON.stringify(title)}`) +
  `. Typically a page that renders its content with JavaScript, or an interstitial. The fetch itself ` +
  `succeeded, so this is an extraction result and not a network failure; requesting the same URL ` +
  `again will return the same thing.]`

const convert = (content: string, contentType: string, format: Format) => {
  if (!contentType.includes("text/html")) return content
  if (format !== "markdown" && format !== "text") return content
  const extracted = format === "markdown" ? convertHTMLToMarkdown(content) : extractTextFromHTML(content)
  // ⚠️ The DECISION reads the body; the RETURN is still the full conversion. Those are two different
  // questions and collapsing them would throw away a real page whose body text is thin but present.
  if (content.length === 0 || bodyTextFromHTML(content) !== "") return extracted
  return emptyExtractionNote(content.length, format, titleFromHTML(content))
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const http = yield* HttpClient.HttpClient
    const permission = yield* PermissionV2.Service
    const governor = yield* WebGovernor.Service

    yield* tools
      .register({
        [name]: Tool.make({
          sideEffect: "read",
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* Effect.try({
                try: () => assertHttpUrl(new URL(input.url)),
                catch: (error) => error,
              })

              yield* permission.assert({
                action: name,
                resources: [input.url],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              // Every outbound read goes through the traffic governor (web/governor.ts): paced per host,
              // capped per host per day, one request in flight per host, and refused outright if this URL
              // is being re-fetched in a loop. The wait happens BEFORE the timeout starts, so a paced
              // delay can never be mistaken for a slow server.
              const policy = CalloutPolicy.webfetch((input.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1_000)
              const { body, contentType } = yield* governor.guard({
                url: input.url,
                sessionID: context.sessionID,
                fetch: Effect.gen(function* () {
                  const response = yield* execute(http, input.url, input.format).pipe(
                    Effect.catchIf(isCloudflareChallenge, () => execute(http, input.url, input.format, "novaclaw")),
                  )
                  const contentType = response.headers["content-type"] || ""
                  const mime = mimeFrom(contentType)
                  if (isImageAttachment(mime))
                    return yield* Effect.fail(new Error(`Unsupported fetched image content type: ${mime}`))
                  if (!isTextualMime(mime))
                    return yield* Effect.fail(new Error(`Unsupported fetched file content type: ${mime}`))
                  return { body: yield* collectBody(response), contentType }
                }).pipe(
                  Effect.timeoutOrElse({
                    duration: Duration.millis(policy.timeoutMs),
                    orElse: () => Effect.fail(new Error("Request timed out")),
                  }),
                ),
              })
              const content = new TextDecoder().decode(body)
              const output = yield* Effect.try({
                try: () => convert(content, contentType, input.format),
                catch: (error) => error,
              })
              return {
                url: input.url,
                contentType,
                format: input.format,
                output,
              }
            }).pipe(
              // `denialMessage` FIRST, per its own contract — a blanket absorber that ignores its
              // error collapses a permission verdict into "Unable to fetch", which reads as a
              // transient network fault and invites a retry. Since B4c `webfetch` is no longer
              // granted by a compiled catch-all, so it ASKS on first use; under an unattended root
              // the evaluator deny-fasts with `unattended-unanswerable`, whose whole job is to tell
              // the model that retrying is pointless and which grant would fix it. Discarding that
              // text made an unattended run retry a refused fetch for the entire run.
              Effect.mapError((error) => {
                const denial = PermissionV2.denialMessage(error)
                if (denial) return new ToolFailure({ message: denial })
                return new ToolFailure({ message: `Unable to fetch ${input.url}` })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/webfetch",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, LayerNodePlatform.httpClient, WebGovernor.node],
})

/**
 * Text the page's BODY carries — the head, and everything unreadable, excluded.
 *
 * 🔴 This is the parse the empty-extraction guard was missing. That guard asked "did conversion
 * produce anything", and an SPA shell answers YES: it carries `<title>App</title>`, the converter
 * lifts it, and a one-word output reads as page content. A byte floor was the wrong instrument —
 * any number would have been chosen to fit that example — and this is the right one, because the
 * question was never "how short is it" but "did the BODY say anything".
 *
 * ⚠️ It does not require a `<body>` tag, deliberately. A fetched fragment has no `html`/`head`/`body`
 * at all, and demanding one would report every fragment as bodyless. The rule is subtractive: text
 * counts unless it is inside `<head>` or inside an element whose contents are not prose.
 */
export function bodyTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0
  let headDepth = 0
  const parser = new Parser({
    onopentag(name) {
      if (name === "head" || headDepth > 0) headDepth++
      else if (skipDepth > 0 || UNREADABLE_ELEMENTS.includes(name)) skipDepth++
    },
    ontext(input) {
      if (skipDepth === 0 && headDepth === 0) text += input
    },
    onclosetag() {
      if (headDepth > 0) headDepth--
      else if (skipDepth > 0) skipDepth--
    },
  })
  parser.write(html)
  parser.end()
  return text.trim()
}

/** The document's `<title>`, so the note can NAME what the shell actually said. */
export function titleFromHTML(html: string) {
  let title = ""
  let inTitle = false
  const parser = new Parser({
    onopentag(name) {
      if (name === "title") inTitle = true
    },
    ontext(input) {
      if (inTitle) title += input
    },
    onclosetag(name) {
      if (name === "title") inTitle = false
    },
  })
  parser.write(html)
  parser.end()
  return title.trim()
}

/** Elements whose text is never prose. Shared so the two walks cannot drift apart. */
const UNREADABLE_ELEMENTS = ["script", "style", "noscript", "iframe", "object", "embed"]

export function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || UNREADABLE_ELEMENTS.includes(name)) skipDepth++
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })
  parser.write(html)
  parser.end()
  return text.trim()
}

export function convertHTMLToMarkdown(html: string) {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndown.remove(["script", "style", "meta", "link"])
  return turndown.turndown(html)
}
