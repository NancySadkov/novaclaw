import { marked, Marked, type Tokens } from "marked"
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
 * ONE math renderer for both parser paths — repair-then-VERIFY.
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
function renderMathInText(text: string): string {
  const spans = findMathSpans(text)
  if (spans.length === 0) return text
  let out = ""
  let cursor = 0
  for (const span of spans) {
    out += text.slice(cursor, span.start)
    const result = renderMath(span.body, { display: span.display, katex: katexRender })
    // ⚠️ The give-up branch re-emits the ORIGINAL slice, delimiters included, escaped as HTML. It
    // must not re-emit the raw source: this function's output goes into an HTML string, and a
    // formula containing `<` would otherwise open a tag.
    out += result.ok ? result.html : escapeHtml(text.slice(span.start, span.end))
    cursor = span.end
  }
  return out + text.slice(cursor)
}

const katexRender = (tex: string, options: { displayMode: boolean; throwOnError: boolean }): string =>
  katex.renderToString(tex, options)

function renderMathExpressions(html: string): string {
  // Split on code/pre/kbd tags to avoid processing their contents
  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi
  const parts = html.split(codeBlockPattern)

  return parts
    .map((part, i) => {
      // Odd indices are the captured code blocks - leave them alone
      if (i % 2 === 1) return part
      // Process math only in non-code parts
      return renderMathInText(part)
    })
    .join("")
}

async function highlightCodeBlocks(html: string): Promise<string> {
  const codeBlockRegex = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g
  const matches = [...html.matchAll(codeBlockRegex)]
  if (matches.length === 0) return html

  const highlighter = await getSharedHighlighter({
    themes: ["NovaClaw"],
    langs: [],
    preferredHighlighter: "shiki-wasm",
  })

  let result = html
  for (const match of matches) {
    const [fullMatch, lang, escapedCode] = match
    const code = escapedCode
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")

    let language = lang || "text"
    if (!(language in bundledLanguages)) {
      language = "text"
    }
    if (!highlighter.getLoadedLanguages().includes(language)) {
      await highlighter.loadLanguage(language as BundledLanguage)
    }

    const highlighted = highlighter.codeToHtml(code, {
      lang: language,
      theme: "NovaClaw",
      tabindex: false,
    })
    result = result.replace(fullMatch, () => highlighted)
  }

  return result
}

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

export type NativeMarkdownParser = (markdown: string) => Promise<string>

/**
 * How the HOST decides whether a markdown href names a local file, and what URL serves it.
 *
 * 🔴 Injected rather than implemented here (owner, 2026-08-22: *"the agent can embed links to the
 * files on the host machine, which user can just click in the chat log to download, as well as link
 * images"*). This package renders markdown for anybody; only the app knows which instance is
 * connected and how to reach its filesystem, and a renderer that guessed would produce links to the
 * wrong machine the moment the user is driving a remote instance.
 *
 * `undefined` means "not a local file" and the ordinary external-link rendering applies.
 */
export type HostFileResolver = (href: string) => { readonly url: string; readonly image: boolean } | undefined

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
    const local = resolveFile?.(href)
    if (local)
      return `<a${attr("href", local.url)}${attr("title", title)} class="agent-file-link"${flagAttr("download", text)} data-agent-file="true">${text}</a>`
    return `<a${attr("href", href)}${attr("title", title)} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
  },
  /**
   * `![alt](path.png)` from a colleague renders INLINE.
   *
   * ⚠️ Only for a host file this instance can serve. A remote image URL stays an ordinary
   * `<img>` with whatever the author wrote — rewriting those would make the chat fetch from
   * wherever a model happened to name, which is egress the user did not ask for.
   *
   * ⚠️ **NO `loading="lazy"`, and this was measured.** The first version had it, and the
   * image never appeared: an `<img>` with no intrinsic size lays out 0×0, and a lazy image
   * with zero dimensions is never triggered even when it is squarely in the viewport —
   * `complete` stayed false with the element visible and its URL answering 200. Setting
   * `eager` on the live element loaded it at 320×120 immediately. Every ledger passed
   * throughout, because they assert the resolver is called and the `src` is right; nothing
   * about a correct `src` makes a browser fetch it.
   */
  image({ href, title, text }: Tokens.Image): string {
    const local = resolveFile?.(href)
    const src = local?.image ? local.url : href
    // `alt` stays present even when empty: an `<img>` with no `alt` at all is an accessibility
    // fault, while `alt=""` is the declared "this image carries no information" form.
    return `<img${attr("src", src)}${flagAttr("alt", text)}${attr("title", title)} class="agent-file-image" />`
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
export const parseWithFileRenderer = (markdown: string, resolveFile?: HostFileResolver): string =>
  new Marked({ renderer: fileRenderer(resolveFile) }).parse(markdown, { async: false }) as string

export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: (props: { nativeParser?: NativeMarkdownParser; resolveFile?: HostFileResolver }) => {
    const jsParser = marked.use(
      {
        renderer: fileRenderer(props.resolveFile),
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

    if (props.nativeParser) {
      const nativeParser = props.nativeParser
      return {
        async parse(markdown: string): Promise<string> {
          const html = await nativeParser(markdown)
          const withMath = renderMathExpressions(html)
          return highlightCodeBlocks(withMath)
        },
      }
    }

    return jsParser
  },
})
