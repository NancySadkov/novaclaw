// WHICH INSTANCE a rendered file link points at.
//
// 🔴 **The user and the colleague are often not on the same machine** (owner, 2026-08-22). A person
// driving the Spark instance from their laptop must get the Spark's copy of a report, not a path
// resolved against whatever served the page. A same-origin URL is right only while the app is served
// by the instance it talks to, and the app supports switching between servers, so it is wrong exactly
// when it matters most: the remote colleague is the one whose files you cannot otherwise reach.
//
// ⚠️ **A module-level cell, and it is a bridge across a PROVIDER ORDERING, not a convenience.**
// `MarkedProvider` is mounted inside `AppBaseProviders`, which wraps `AppInterface` — and
// `ServerProvider` lives inside THAT. So the renderer is configured strictly above the context that
// knows the connection, in both the web and desktop entries. The alternatives were restructuring two
// entry points, or post-processing rendered HTML in the session UI; a single cell that the tree keeps
// current is smaller than either and does not move code that boots the product.
//
// ⚠️ It is read at RENDER time, never captured. The user may switch servers mid-session, and a link
// rendered before the switch must still resolve against whoever is connected when it is clicked.

import type { FileContent } from "@novaclaw/sdk/v2"

let base = ""

/** Point subsequent file links at this instance. `""` restores same-origin. */
export const setInstanceBase = (url: string | undefined): void => {
  base = (url ?? "").trim().replace(/\/+$/, "")
}

/**
 * Read one file from the connected instance THROUGH ITS AUTHENTICATED CLIENT.
 *
 * 🔴 **This is the credential the chat renderer cannot otherwise reach, and the reason it needs
 * one.** A `<img src>` is a browser subresource: it carries no `Authorization` header, so an
 * instance route in it answers 401 on every instance that has a server password. The bytes have to
 * be fetched by code that holds the credential and handed to the browser inline, which is exactly
 * what `components/file-media.tsx` already does for the diff viewer — the same
 * `client.file.read({ directory, path })` call the Files browser uses to preview any absolute host
 * path.
 *
 * ⚠️ `undefined` while nothing is connected. A caller must degrade, not throw.
 */
export type InstanceFileReader = (directory: string, name: string) => Promise<FileContent | undefined>

let reader: InstanceFileReader | undefined

export const setInstanceFileReader = (read: InstanceFileReader | undefined): void => {
  reader = read
}

export const instanceFileReader = (): InstanceFileReader | undefined => reader

/**
 * Mint one short-lived, single-use ticket authorizing ONE download of ONE file.
 *
 * 🔴 **The download half of the same credential problem, and it needs a different answer from the
 * reader above.** A `<a download>` href is fetched by the BROWSER, which sends no `Authorization`
 * header — so on an instance with a server password the click saved the 401 body under the file's
 * own name. The image path solves that by reading the bytes here and pasting them into a `data:`
 * URL; a download must not, because the Files browser records a deliberate decision that a large
 * artefact must never have to fit in a JS string. So the credential buys a TICKET instead, and the
 * browser still streams the file itself.
 *
 * ⚠️ Minted at CLICK time and nowhere else. The chat's rendered HTML sits in a content-addressed
 * LRU that replays it verbatim while `/api/fs/read` sets no cache headers, so a ticket baked into
 * markup is spent on the first paint; and the user clicks a download at an arbitrary later moment,
 * which no TTL short enough to be a ticket survives.
 *
 * ⚠️ `undefined` while nothing is connected, and resolves `undefined` when the mint is refused. The
 * caller degrades to the unticketed URL — which is what every instance WITHOUT a password serves
 * happily — rather than doing nothing at all.
 */
export type InstanceTicketMinter = (directory: string, name: string) => Promise<string | undefined>

let minter: InstanceTicketMinter | undefined

export const setInstanceTicketMinter = (mint: InstanceTicketMinter | undefined): void => {
  minter = mint
}

export const instanceTicketMinter = (): InstanceTicketMinter | undefined => minter

let mediaNote = ""

/**
 * Already-translated copy for an image the chat could not put inline.
 *
 * ⚠️ **Mirrored rather than looked up**, for the same reason the base URL is: the renderer is a
 * plain function configured above the provider that owns the dictionary. Empty until the mirror has
 * run, and the renderer omits the note rather than printing a key.
 */
export const setInstanceMediaNote = (text: string): void => {
  mediaNote = text
}

export const instanceMediaNote = (): string => mediaNote

/**
 * The base every file URL is built on.
 *
 * ⚠️ `""` means same-origin, which is the honest answer before a connection is known — a relative URL
 * resolves against the page, which is right for the local case and the only safe guess for any other.
 */
export const instanceBase = (): string => base
