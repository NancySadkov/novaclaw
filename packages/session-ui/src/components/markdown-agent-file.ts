import { AGENT_FILE_PATH_ATTRIBUTE, type HostFileResolver } from "@novaclaw/ui/context/marked"

/**
 * 🔴 **SAVING A COLLEAGUE'S FILE IS A CLICK, NOT AN HREF.**
 *
 * The chat's file link used to carry `<instance>/api/fs/read/<name>` in its `href`. A `download`
 * href is fetched by the BROWSER, and a browser-issued request carries no `Authorization` header —
 * so on any instance with a server password the click saved the 401 body under the file's own name.
 * The anchor's href is `#` now; the path rides {@link AGENT_FILE_PATH_ATTRIBUTE}, and the host mints
 * a short-lived single-use ticket here, at the moment the user asks, then lets the browser stream
 * the file. Streaming is the requirement that rules out the chat IMAGE path's answer: a report, an
 * archive or a video must never have to fit in a JS string.
 *
 * ⚠️ **Minting at CLICK time is not an optimisation, it is the only time that works.** `Markdown`
 * replays rendered HTML from a 200-entry content-addressed LRU and `/api/fs/read` sets no cache
 * headers, so a ticket baked into the markup is spent on the first paint and refused on the second;
 * and a download is clicked at an arbitrary later moment, which no TTL short enough to be a ticket
 * survives.
 *
 * ⚠️ **Its own module, because the test that matters needs a DOM and `markdown.tsx` cannot be
 * imported into one.** That file pulls in the syntax-highlighting worker through a bundler-only
 * `?worker&url` import, which `bun test` cannot resolve — so a handler living inside it could only
 * ever be asserted by reading source. Here the real renderer's markup, a real click and the real
 * handler meet in `app/test-browser/agent-file-download-click.test.ts`; the one line that remains a
 * source assertion is `markdown.tsx` calling this.
 */
export function handleAgentFileClick(event: MouseEvent, getResolver: () => HostFileResolver | undefined): boolean {
  const target = event.target
  if (!(target instanceof Element)) return false
  const anchor = target.closest(`a[${AGENT_FILE_PATH_ATTRIBUTE}]`)
  if (!(anchor instanceof HTMLAnchorElement)) return false

  // ⚠️ Prevented even when no resolver is wired, and even when the attribute is empty: the href is
  // `#`, so letting the default through would scroll the chat to the top of the log. Losing the
  // user's place mid-conversation is a worse answer than a download that quietly did not happen.
  event.preventDefault()
  const path = anchor.getAttribute(AGENT_FILE_PATH_ATTRIBUTE)
  if (path) getResolver()?.download(path)
  return true
}
