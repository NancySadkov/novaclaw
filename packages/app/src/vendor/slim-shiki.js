import { createBundledHighlighter, createSingletonShorthands } from "shiki/core"
import { bundledLanguages } from "shiki/langs"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { createOnigurumaEngine } from "shiki/engine/oniguruma"

const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: {},
  engine: () => createOnigurumaEngine(import("shiki/wasm")),
})
const { codeToHtml } = createSingletonShorthands(createHighlighter)

export { bundledLanguages, codeToHtml, createHighlighter, createJavaScriptRegexEngine, createOnigurumaEngine }
export { createCssVariablesTheme, getTokenStyleObject, stringifyTokenStyle } from "shiki/core"
