import { marked, Marked, type Token, type Tokens } from "marked"
import markedShiki from "marked-shiki"
import katex from "katex"
import { bundledLanguages, type BundledLanguage } from "shiki/langs"
import { createSimpleContext } from "./helper"
import { findMathSpans, render as renderMath } from "../util/math-latex"
import { escapeHtml } from "../util/html"
import { getSharedHighlighter, registerCustomTheme, ThemeRegistrationResolved } from "@pierre/diffs"

export const NovaClawTheme = {
  name: "NovaClaw",
  bg: "var(--color-background-stronger)",
  fg: "var(--text-base)",
  colors: {
    "editor.background": "var(--color-background-stronger)",
    "editor.foreground": "var(--text-base)",
    "gitDecoration.addedResourceForeground": "var(--syntax-diff-add)",
    "gitDecoration.deletedResourceForeground": "var(--syntax-diff-delete)",
    "gitDecoration.modifiedResourceForeground": "var(--syntax-diff-unknown)",
    // "gitDecoration.conflictingResourceForeground": "#ffca00",
    // "gitDecoration.modifiedResourceForeground": "#1a76d4",
    // "gitDecoration.untrackedResourceForeground": "#00cab1",
    // "gitDecoration.ignoredResourceForeground": "#84848A",
    // "terminal.titleForeground": "#adadb1",
    // "terminal.titleInactiveForeground": "#84848A",
    // "terminal.background": "#141415",
    // "terminal.foreground": "#adadb1",
    // "terminal.ansiBlack": "#141415",
    // "terminal.ansiRed": "#ff2e3f",
    // "terminal.ansiGreen": "#0dbe4e",
    // "terminal.ansiYellow": "#ffca00",
    // "terminal.ansiBlue": "#008cff",
    // "terminal.ansiMagenta": "#c635e4",
    // "terminal.ansiCyan": "#08c0ef",
    // "terminal.ansiWhite": "#c6c6c8",
    // "terminal.ansiBrightBlack": "#141415",
    // "terminal.ansiBrightRed": "#ff2e3f",
    // "terminal.ansiBrightGreen": "#0dbe4e",
    // "terminal.ansiBrightYellow": "#ffca00",
    // "terminal.ansiBrightBlue": "#008cff",
    // "terminal.ansiBrightMagenta": "#c635e4",
    // "terminal.ansiBrightCyan": "#08c0ef",
    // "terminal.ansiBrightWhite": "#c6c6c8",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: {
        foreground: "var(--syntax-comment)",
      },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: {
        foreground: "var(--syntax-property)", // maybe attribute
      },
    },
    {
      scope: ["constant", "entity.name.constant", "variable.other.constant", "variable.language", "entity"],
      settings: {
        foreground: "var(--syntax-constant)",
      },
    },
    {
      scope: ["entity.name", "meta.export.default", "meta.definition.variable"],
      settings: {
        foreground: "var(--syntax-type)",
      },
    },
    {
      scope: ["meta.object.member"],
      settings: {
        foreground: "var(--syntax-primitive)",
      },
    },
    {
      scope: [
        "variable.parameter.function",
        "meta.jsx.children",
        "meta.block",
        "meta.tag.attributes",
        "entity.name.constant",
        "meta.embedded.expression",
        "meta.template.expression",
        "string.other.begin.yaml",
        "string.other.end.yaml",
      ],
      settings: {
        foreground: "var(--syntax-punctuation)",
      },
    },
    {
      scope: ["entity.name.function", "support.type.primitive"],
      settings: {
        foreground: "var(--syntax-primitive)",
      },
    },
    {
      scope: ["support.class.component"],
      settings: {
        foreground: "var(--syntax-type)",
      },
    },
    {
      scope: "keyword",
      settings: {
        foreground: "var(--syntax-keyword)",
      },
    },
    {
      scope: [
        "keyword.operator",
        "storage.type.function.arrow",
        "punctuation.separator.key-value.css",
        "entity.name.tag.yaml",
        "punctuation.separator.key-value.mapping.yaml",
      ],
      settings: {
        foreground: "var(--syntax-operator)",
      },
    },
    {
      scope: ["storage", "storage.type"],
      settings: {
        foreground: "var(--syntax-keyword)",
      },
    },
    {
      scope: ["storage.modifier.package", "storage.modifier.import", "storage.type.java"],
      settings: {
        foreground: "var(--syntax-primitive)",
      },
    },
    {
      scope: [
        "string",
        "punctuation.definition.string",
        "string punctuation.section.embedded source",
        "entity.name.tag",
      ],
      settings: {
        foreground: "var(--syntax-string)",
      },
    },
    {
      scope: "support",
      settings: {
        foreground: "var(--syntax-primitive)",
      },
    },
    {
      scope: ["support.type.object.module", "variable.other.object", "support.type.property-name.css"],
      settings: {
        foreground: "var(--syntax-object)",
      },
    },
    {
      scope: "meta.property-name",
      settings: {
        foreground: "var(--syntax-property)",
      },
    },
    {
      scope: "variable",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: "variable.other",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: [
        "invalid.broken",
        "invalid.illegal",
        "invalid.unimplemented",
        "invalid.deprecated",
        "message.error",
        "markup.deleted",
        "meta.diff.header.from-file",
        "punctuation.definition.deleted",
        "brackethighlighter.unmatched",
        "token.error-token",
      ],
      settings: {
        foreground: "var(--syntax-critical)",
      },
    },
    {
      scope: "carriage-return",
      settings: {
        foreground: "var(--syntax-keyword)",
      },
    },
    {
      scope: "string source",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: "string variable",
      settings: {
        foreground: "var(--syntax-constant)",
      },
    },
    {
      scope: [
        "source.regexp",
        "string.regexp",
        "string.regexp.character-class",
        "string.regexp constant.character.escape",
        "string.regexp source.ruby.embedded",
        "string.regexp string.regexp.arbitrary-repitition",
        "string.regexp constant.character.escape",
      ],
      settings: {
        foreground: "var(--syntax-regexp)",
      },
    },
    {
      scope: "support.constant",
      settings: {
        foreground: "var(--syntax-primitive)",
      },
    },
    {
      scope: "support.variable",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: "meta.module-reference",
      settings: {
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "punctuation.definition.list.begin.markdown",
      settings: {
        foreground: "var(--syntax-punctuation)",
      },
    },
    {
      scope: ["markup.heading", "markup.heading entity.name"],
      settings: {
        fontStyle: "bold",
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "markup.quote",
      settings: {
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "markup.italic",
      settings: {
        fontStyle: "italic",
        // foreground: "",
      },
    },
    {
      scope: "markup.bold",
      settings: {
        fontStyle: "bold",
        foreground: "var(--text-strong)",
      },
    },
    {
      scope: [
        "markup.raw",
        "markup.inserted",
        "meta.diff.header.to-file",
        "punctuation.definition.inserted",
        "markup.changed",
        "punctuation.definition.changed",
        "markup.ignored",
        "markup.untracked",
      ],
      settings: {
        foreground: "var(--text-base)",
      },
    },
    {
      scope: "meta.diff.range",
      settings: {
        fontStyle: "bold",
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: "meta.diff.header",
      settings: {
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: "meta.separator",
      settings: {
        fontStyle: "bold",
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: "meta.output",
      settings: {
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: "meta.export.default",
      settings: {
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: [
        "brackethighlighter.tag",
        "brackethighlighter.curly",
        "brackethighlighter.round",
        "brackethighlighter.square",
        "brackethighlighter.angle",
        "brackethighlighter.quote",
      ],
      settings: {
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: ["constant.other.reference.link", "string.other.link"],
      settings: {
        fontStyle: "underline",
        foreground: "var(--syntax-unknown)",
      },
    },
    {
      scope: "token.info-token",
      settings: {
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "token.warn-token",
      settings: {
        foreground: "var(--syntax-warning)",
      },
    },
    {
      scope: "token.debug-token",
      settings: {
        foreground: "var(--syntax-info)",
      },
    },
  ],
  semanticTokenColors: {
    comment: "var(--syntax-comment)",
    string: "var(--syntax-string)",
    number: "var(--syntax-constant)",
    regexp: "var(--syntax-regexp)",
    keyword: "var(--syntax-keyword)",
    variable: "var(--syntax-variable)",
    parameter: "var(--syntax-variable)",
    property: "var(--syntax-property)",
    function: "var(--syntax-primitive)",
    method: "var(--syntax-primitive)",
    type: "var(--syntax-type)",
    class: "var(--syntax-type)",
    namespace: "var(--syntax-type)",
    enumMember: "var(--syntax-primitive)",
    "variable.constant": "var(--syntax-constant)",
    "variable.defaultLibrary": "var(--syntax-unknown)",
  },
} as unknown as ThemeRegistrationResolved

registerCustomTheme("NovaClaw", () => Promise.resolve(NovaClawTheme))

/**
 * KaTeX, as the VERIFIER in a repair-then-verify loop — the only thing this package hands it.
 *
 * 🔴 The detection, the repairs and the give-up rule live in `../util/math-latex`, PURE and tested
 * (`math-latex.test.ts`). Two things used to be wrong here and both were invisible to every test:
 *
 *  · **Prices rendered as formulas.** The inline rule was
 *    `(?<!\$)\$(?!\$)((?:[^$\]|\.)+?)\$(?!\$)`, which happily matched across "It costs $5 and
 *    the other is $10" and set "5 and the other is " in italic serif. A silent misrender of the
 *    user's own words is worse than rendering no maths at all.
 *  · **`\(…\)` and `\[…\]` were not recognised at all**, and they are what a LaTeX-trained model
 *    emits at least as often as `$…$`. The STEM answer that took the most effort to produce was the
 *    one that came out as gibberish.
 *
 * And `throwOnError: false` meant a malformed formula was rendered as KaTeX's red diagnostic. Now
 * the parser is the VERIFIER: each repair candidate is offered to it in strict mode, and if none is
 * accepted the model's own text is shown as ordinary prose.
 */
const katexRender = (tex: string, options: { displayMode: boolean; throwOnError: boolean }): string =>
  katex.renderToString(tex, options)

/**
 * Attribute-safe text. The path comes from a MODEL, so it is untrusted input in an HTML string.
 *
 * ⚠️ **`&` is escaped unconditionally, and the tempting refinement is refused on purpose.** An
 * entity-aware escaper — one that leaves an existing `&amp;` alone — would render a markdown source
 * that spells its query string `?a=1&amp;b=2` slightly better, and would also preserve
 * `java&#115;cript:` intact for the browser to decode. The first is a rare authoring style
 * (`marked@17` hands this function a raw `&` for the ordinary `?a=1&b=2`, measured), the second is a
 * live obfuscation vector, and between a cosmetic loss and a decoded scheme the answer is not close.
 */
const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/**
 * ONE attribute, quoted and escaped, emitted whole — leading space included.
 *
 * 🔴 **This exists so that no renderer below can write an attribute by hand.** The escaping used to
 * be opt-in at each interpolation: every `name="${value}"` was a separate chance to forget, and two
 * of them did. Emitting the whole attribute here removes the choice — there is nothing to remember,
 * because `name="` is no longer something a renderer types. `marked-attribute-slots.test.ts` fails
 * if an interpolation reappears inside a quoted attribute value anywhere in the renderers.
 *
 * ⚠️ **Absent OR empty means the attribute is not written at all.** `marked` hands `title` as `null`
 * when the author wrote none, and an empty `title=""` is a tooltip that opens onto nothing.
 * {@link flagAttr} is for the other kind, where presence is itself the meaning.
 */
const attr = (name: string, value: string | null | undefined): string =>
  value === null || value === undefined || value === "" ? "" : ` ${name}="${escapeAttribute(value)}"`

/**
 * An attribute whose PRESENCE carries the meaning, so an empty value still writes it.
 *
 * `download=""` is not `download` omitted: the empty form still makes the click save the file (under
 * the server-suggested name), while dropping the attribute makes the browser navigate to it instead.
 * A link whose text is empty is rare, and it must not silently change from a download into a
 * navigation because of that.
 */
const flagAttr = (name: string, value: string | null | undefined): string =>
  ` ${name}="${escapeAttribute(value ?? "")}"`

/**
 * The marked extension that renders maths — OUR detector, not `marked-katex-extension`.
 *
 * 🔴 Swapped for two reasons, and neither is stylistic. That extension has no way to REFUSE a `$…$`
 * span, so every price pair in a chat became a formula; and it renders a malformed formula through
 * KaTeX's `throwOnError: false`, which produces a red error box in the middle of an answer. Both
 * are decisions this codebase has to own, so the tokenizer is ours and `../util/math-latex` holds
 * the rules with the tests against them.
 *
 * ⚠️ Tokenizing maths at the INLINE level (rather than post-processing the HTML) is what keeps
 * marked's own inline rules off the formula. `a_1 + a_2` contains two underscores; left to marked
 * they become an `<em>`, and the subscripts silently disappear before KaTeX ever sees the string.
 */
export function markedMath() {
  const claim = (src: string, display: boolean) => {
    const span = findMathSpans(src)[0]
    if (!span || span.start !== 0 || span.display !== display) return undefined
    return span
  }
  const html = (body: string, display: boolean, raw: string) => {
    const result = renderMath(body, { display, katex: katexRender })
    return result.ok ? result.html : escapeHtml(raw)
  }
  return {
    extensions: [
      {
        name: "novaclawMathBlock",
        level: "block" as const,
        // `start` is marked's cheap "could a token begin near here?" hint. It must be permissive:
        // a miss means the span is never offered to the tokenizer at all.
        start: (src: string) => {
          const at = src.search(/\$\$|\\\[|\\begin\{/)
          return at === -1 ? undefined : at
        },
        tokenizer(src: string) {
          const span = claim(src, true)
          if (!span) return undefined
          return { type: "novaclawMathBlock", raw: src.slice(0, span.end), text: span.body }
        },
        renderer(token: { raw: string; text: string }) {
          return html(token.text, true, token.raw)
        },
      },
      {
        name: "novaclawMathInline",
        level: "inline" as const,
        start: (src: string) => {
          const at = src.search(/\$|\\\(/)
          return at === -1 ? undefined : at
        },
        tokenizer(src: string) {
          const span = claim(src, false)
          if (!span) return undefined
          return { type: "novaclawMathInline", raw: src.slice(0, span.end), text: span.body }
        },
        renderer(token: { raw: string; text: string }) {
          return html(token.text, false, token.raw)
        },
      },
    ],
  }
}

/**
 * The markup hook a colleague's file link is clicked through.
 *
 * 🔴 **The href a host file link carries is `#`.** The real path lives here instead, so that
 * nothing about the anchor is fetchable until a click has minted a credential for it. One constant
 * because the renderer that writes it and the delegated handler that reads it are in different
 * packages, and a hook spelled twice is a feature that silently stops working.
 */
export const AGENT_FILE_PATH_ATTRIBUTE = "data-agent-file-path"

/**
 * What the host offers for one markdown href that names a file on it.
 *
 * `undefined` from {@link HostFileResolver.target} means "not a local file" and the ordinary
 * external-link rendering applies.
 */
export interface HostFileTarget {
  /**
   * 🔴 **There is no URL here, and that absence is the type's whole job.**
   *
   * This carried `url: string` — the instance route that serves the file — and the two renderers
   * below wrote it straight into an `<a href download>`. A browser fetches a `download` href
   * ITSELF, and a browser-issued request carries no `Authorization` header, so on any instance with
   * a server password that anchor saved the 401 body under the file's own name. Deleting the member
   * is the close: a renderer can only emit what it is handed, so an instance route cannot reappear
   * in an attribute by anyone forgetting anything.
   *
   * What replaces it is a CLICK: the markup carries the file's href in a data attribute, and
   * {@link HostFileResolver.download} mints a short-lived ticket at the moment the user asks and
   * lets the browser stream the file. Minting during the parse would not work — the rendered HTML is
   * content-addressed and replayed from an LRU, so the ticket is spent on the first paint — and a
   * `data:` URL (the answer the IMAGE path takes) is refused here on purpose: a large artefact must
   * never have to fit in a JS string.
   */
  /** The file's own name. The label a degraded image falls back to when the alt text is empty. */
  readonly name: string
  /** Render inline as an image rather than offering it as a download. */
  readonly image: boolean
}

/**
 * One host image, ALREADY READ.
 *
 * 🔴 **There is no arm here that carries a URL, and that is the property this type exists for.**
 * The image renderer can only ever emit what it is given, so it structurally cannot put an instance
 * route into an `<img src>` again.
 */
export type HostImage =
  | { readonly ok: true; readonly src: string }
  | {
      readonly ok: false
      /** Why it is not inline — rendered as a `data-agent-file-inline` value, so a test can see it. */
      readonly reason: "oversize" | "unreadable"
      /** Already-translated copy for the reader. Absent when the host has no dictionary to hand. */
      readonly note?: string
    }

/**
 * Where {@link hostImagePrepass} leaves what it read, for {@link fileRenderer}'s image branch.
 *
 * ⚠️ `marked`'s renderers must return a `string`, so they cannot await anything. `walkTokens` is the
 * one asynchronous seam the parser has, and it runs to completion BEFORE rendering starts — so the
 * bytes are fetched there and stashed on the token itself.
 */
type HostImageSlot = { novaclawHostImage?: HostImage }

/**
 * The ONE place the slot is written, and the ONE place it is read.
 *
 * ⚠️ `marked` owns the token's type, so the slot is reached through an assertion rather than by
 * widening the renderer's declared parameter — that would put an intersection in a position marked
 * type-checks contravariantly, for no gain. Two functions, six lines, and no other file has to know
 * the property's name.
 */
const stashHostImage = (token: Tokens.Image, image: HostImage): void => {
  ;(token as Tokens.Image & HostImageSlot).novaclawHostImage = image
}

const stashedHostImage = (token: Tokens.Image): HostImage | undefined =>
  (token as Tokens.Image & HostImageSlot).novaclawHostImage

/**
 * How the HOST decides whether a markdown href names a local file, and how it is served.
 *
 * 🔴 Injected rather than implemented here (owner, 2026-08-22: *"the agent can embed links to the
 * files on the host machine, which user can just click in the chat log to download, as well as link
 * images"*). This package renders markdown for anybody; only the app knows which instance is
 * connected and how to reach its filesystem, and a renderer that guessed would produce links to the
 * wrong machine the moment the user is driving a remote instance.
 *
 * ⚠️ **Two members, because the two questions have different costs.** Whether an href IS a host file
 * is a decision about the path and needs no I/O; producing an image's `src` means READING it through
 * whatever authenticated channel the host holds, which is asynchronous by construction.
 */
export interface HostFileResolver {
  readonly target: (href: string) => HostFileTarget | undefined
  /**
   * Read one host image and return it inline. The host owns the size limit and the memoisation;
   * this pass calls it once per image token per parse.
   */
  readonly inline: (href: string) => Promise<HostImage>
  /**
   * Save one host file, NOW — the click behind {@link AGENT_FILE_PATH_ATTRIBUTE}.
   *
   * 🔴 **Called from a delegated handler, never from a renderer.** The host mints a short-lived
   * single-use ticket, hands the browser a URL carrying it, and lets the browser stream the bytes
   * to disk. Everything about that has to happen at click time: a ticket minted while the markdown
   * was parsed is spent by the first paint (the rendered HTML sits in a content-addressed LRU that
   * replays it verbatim, and the route sets no cache headers), and the user clicks at an arbitrary
   * later moment anyway.
   *
   * ⚠️ Takes the ORIGINAL href, not a resolved path, so the host re-applies its own admission rules
   * — including the refusal of `//host/share/…`, which is a network destination wearing a path's
   * clothes and must not become one because a value round-tripped through an attribute.
   */
  readonly download: (href: string) => void
}

/**
 * The `walkTokens` pass that reads every host image before anything is rendered.
 *
 * ⚠️ The resolver is passed as an ACCESSOR, not a value: the provider's props are reactive and the
 * connected instance can change mid-session, so the pass must read whoever is current when a parse
 * actually runs rather than whoever was current when the parser was built.
 */
export const hostImagePrepass =
  (resolveFile: () => HostFileResolver | undefined) =>
  async (token: Token): Promise<void> => {
    if (token.type !== "image") return
    const resolver = resolveFile()
    if (!resolver) return
    const image = token as Tokens.Image
    if (!resolver.target(image.href)?.image) return
    stashHostImage(image, await resolver.inline(image.href))
  }

/**
 * The link and image renderers, lifted out of the context's `init` so they can be DRIVEN BY A TEST.
 *
 * 🔴 **Every value these renderers receive arrives RAW, and that was measured, not assumed.** Driving
 * `marked@17.0.1` with a spy renderer shows it hands `href`, `title` and `text` back exactly as the
 * author wrote them — no entity escaping of any kind, on any of the three. So an attribute written
 * as `name="${value}"` is an attribute the author of the markdown can close and continue, and this
 * file believed the opposite of that in writing: a comment here stated that `href` was deliberately
 * left unescaped because *"marked already closes the quote vector there"*. It does not.
 * `[x](<https://e.com/" onmouseover="alert(1)>)` produced a live `onmouseover` on a real `<a>`, and
 * `[x](<https://e.com/"><img src=x onerror=alert(1)>)` produced a whole injected element. The escape
 * on the neighbouring `title` had already been added; the `href` two characters away had not.
 *
 * ⚠️ **What is a slot the renderer owns, and what is markdown's own business.** An attribute value is
 * a slot THIS code opened with a quote, so this code must close it — that is the property below. The
 * link's element content is not: markdown passes inline HTML through by design (`marked`'s own
 * renderer does the same), and the sanitizer in `session-ui/src/components/markdown-cache.tsx` is the
 * declared boundary for the whole document's raw HTML. Escaping `text` here would not add safety, it
 * would change what markdown means.
 *
 * ⚠️ DOMPurify downstream strips `on*` handlers, so an escaped attribute is defence in depth rather
 * than the only wall — but the sanitizer lives in another package, this subsystem already documents
 * one deliberate bypass of it (`markdown-html-embed.ts`), and `markdown-cache.tsx` widens its
 * `ADD_ATTR`. An HTML string built from model output should be correct where it is built.
 *
 * `marked-attributes.test.ts` drives these through the real parser with breakout payloads;
 * `marked-attribute-slots.test.ts` reads this source and fails if a raw interpolation returns.
 */
export const fileRenderer = (resolveFile?: HostFileResolver) => ({
  link({ href, title, text }: Tokens.Link): string {
    // 🔴 A FILE THIS INSTANCE CAN SERVE — a colleague handing over what it made. `download`
    // makes the click save it rather than navigate, and the attribute carries the file's own
    // name so it does not land as the route's last segment.
    const local = resolveFile?.target(href)
    // 🔴 `href="#"` and the real path in a DATA attribute, because a `download` href is fetched by
    // the BROWSER and a browser request carries no `Authorization`. The click is handled by
    // `session-ui/src/components/markdown.tsx`, which mints a ticket and streams the file.
    if (local)
      return `<a href="#"${attr("title", title)} class="agent-file-link"${flagAttr("download", text)} data-agent-file="true"${attr(AGENT_FILE_PATH_ATTRIBUTE, href)}>${text}</a>`
    return `<a${attr("href", href)}${attr("title", title)} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
  },
  /**
   * `![alt](path.png)` from a colleague renders INLINE, from BYTES this app already fetched.
   *
   * 🔴 **The `src` of a host image is a `data:` URL and never an instance route.** A browser
   * subresource carries no `Authorization` header, so a route here rendered broken on every
   * instance that has a server password; the bytes are read by the code that HOLDS the
   * credential — {@link hostImagePrepass}, through the host's authenticated client — and pasted
   * in whole. That is also why it survives the markdown LRU: a `data:` URL has no lifetime and
   * no second request, so replaying the cached HTML on a later mount renders the same picture.
   * Measured: our `sanitizeMarkdown` config admits `data:` on an `<img src>` (and, correctly,
   * refuses it on an `<a href>`) — `agent-file-inline-image.test.ts` pins both halves.
   *
   * ⚠️ Only for a host file this instance can serve. A remote image URL stays an ordinary
   * `<img>` with whatever the author wrote — rewriting those would make the chat fetch from
   * wherever a model happened to name, which is egress the user did not ask for.
   *
   * ⚠️ **A file too big to inline DEGRADES to the download link rather than to a broken image.**
   * The bytes go inside a cached HTML string, so there is a size limit; what there must not be
   * is a silent hole where a colleague's work was.
   *
   * ⚠️ **NO `loading="lazy"`, and this was measured.** The first version had it, and the
   * image never appeared: an `<img>` with no intrinsic size lays out 0×0, and a lazy image
   * with zero dimensions is never triggered even when it is squarely in the viewport —
   * `complete` stayed false with the element visible and its URL answering 200. Setting
   * `eager` on the live element loaded it at 320×120 immediately. Every ledger passed
   * throughout, because they assert the resolver is called and the `src` is right; nothing
   * about a correct `src` makes a browser fetch it.
   */
  image(token: Tokens.Image): string {
    const { href, title, text } = token
    const local = resolveFile?.target(href)
    // `alt` stays present even when empty: an `<img>` with no `alt` at all is an accessibility
    // fault, while `alt=""` is the declared "this image carries no information" form.
    if (!local?.image)
      return `<img${attr("src", href)}${flagAttr("alt", text)}${attr("title", title)} class="agent-file-image" />`

    const inlined = stashedHostImage(token)
    if (inlined?.ok)
      return `<img${attr("src", inlined.src)}${flagAttr("alt", text)}${attr("title", title)} class="agent-file-image" />`

    // The alt text is the author's own inline markdown and stays raw, as everywhere else here; the
    // file NAME is a path segment a model wrote, so it is escaped as ordinary text.
    const label = text === "" ? escapeHtml(local.name) : text
    const anchor = `<a href="#"${attr("title", title)} class="agent-file-link"${flagAttr("download", local.name)} data-agent-file="true"${attr(AGENT_FILE_PATH_ATTRIBUTE, href)}${attr("data-agent-file-inline", inlined?.reason ?? "unreadable")}>${label}</a>`
    return inlined?.note ? `${anchor}<span class="agent-file-note">${escapeHtml(inlined.note)}</span>` : anchor
  },
})

/**
 * Parse markdown through these renderers and nothing else.
 *
 * ⚠️ **Exported so a test in another package can drive the real parser without importing `marked`
 * itself.** `packages/ui` has no DOM, so the assertion that matters — that a payload produces no
 * injected attribute and no injected element once the output is PARSED — has to run in
 * `packages/app`'s browser harness; and `renderer-dependency-ledger.test.ts` correctly refuses an
 * import of a package `packages/app` does not declare. One helper here is smaller than a dependency
 * there, and it keeps the parser configuration in the file that owns it. This is the same reason
 * `fileRenderer` is a factory rather than an object literal inside `init`.
 */
export const parseWithFileRenderer = (markdown: string, resolveFile?: HostFileResolver): Promise<string> =>
  Promise.resolve(
    new Marked({
      renderer: fileRenderer(resolveFile),
      async: true,
      walkTokens: hostImagePrepass(() => resolveFile),
    }).parse(markdown),
  )

/**
 * ⚠️ `MarkedContext` is exported for TESTS ONLY — product code uses `useMarked`.
 *
 * The delegated click that saves a colleague's file lives in `session-ui`'s `Markdown` and reaches
 * the host through this context, so the assertion that a click actually calls it has to mount that
 * component. `provider` runs the real `init`, which builds a parser and a syntax highlighter; the
 * raw context lets a test supply a stub value instead, which is the case `createSimpleContext`
 * exposes `context` for.
 */
export const {
  use: useMarked,
  provider: MarkedProvider,
  context: MarkedContext,
} = createSimpleContext({
  name: "Marked",
  init: (props: { resolveFile?: HostFileResolver }) => {
    /**
     * 🔴 **There is ONE parser, and `fileRenderer` is on it.** This used to return a second,
     * host-supplied parser when a `nativeParser` prop was given — a path that applied neither the
     * file renderer nor `markedMath`, so every agent file link and every formula would have
     * silently vanished for whoever wired it. It had zero suppliers and had never run. The rung
     * above "document the hazard" is to make it unreachable, so the branch and its prop are gone:
     * a parser that skips the renderer no longer exists to be selected.
     */
    const jsParser = marked.use(
      {
        renderer: fileRenderer(props.resolveFile),
        // The bytes of every host image, fetched before rendering begins. `async` makes
        // `parse` return a promise; both call sites in `session-ui` already await it.
        async: true,
        walkTokens: hostImagePrepass(() => props.resolveFile),
      },
      markedMath(),
      markedShiki({
        async highlight(code, lang) {
          const highlighter = await getSharedHighlighter({
            themes: ["NovaClaw"],
            langs: [],
            preferredHighlighter: "shiki-wasm",
          })
          if (!(lang in bundledLanguages)) {
            lang = "text"
          }
          if (!highlighter.getLoadedLanguages().includes(lang)) {
            await highlighter.loadLanguage(lang as BundledLanguage)
          }
          return highlighter.codeToHtml(code, {
            lang: lang || "text",
            theme: "NovaClaw",
            tabindex: false,
          })
        },
      }),
    )

    /**
     * ⚠️ **The resolver rides the context beside the parser**, because the markup the renderer
     * emits is only half a feature: the other half is the delegated click in
     * `session-ui/src/components/markdown.tsx`, and that component has no other way to reach the
     * host. Read through an accessor rather than captured, for the same reason `walkTokens` does —
     * props are reactive and the connected instance changes mid-session.
     */
    return { parser: jsParser, resolveFile: () => props.resolveFile }
  },
})
