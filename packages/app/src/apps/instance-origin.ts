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

let base = ""

/** Point subsequent file links at this instance. `""` restores same-origin. */
export const setInstanceBase = (url: string | undefined): void => {
  base = (url ?? "").trim().replace(/\/+$/, "")
}

/**
 * The base every file URL is built on.
 *
 * ⚠️ `""` means same-origin, which is the honest answer before a connection is known — a relative URL
 * resolves against the page, which is right for the local case and the only safe guess for any other.
 */
export const instanceBase = (): string => base
