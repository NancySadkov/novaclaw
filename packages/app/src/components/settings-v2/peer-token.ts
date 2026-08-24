/**
 * MERGING A PEER EDIT WITH WHAT IS ALREADY STORED.
 *
 * 🔴 **A blank token means KEEP, never CLEAR.** Adding a peer REPLACES any peer of the same name, and
 * the config write omits a falsy token — so re-adding a peer with the token field empty silently
 * discarded the stored token, leaving the user with auth failures against that instance and nothing
 * on screen to explain them. That is exactly the shape the product's own scan produces: picking a
 * discovered instance fills name and url and leaves the token blank.
 *
 * ⚠️ Clearing a token is done by REMOVING the peer, which says what it does. This is the same rule
 * `mergeProviderKey` applies to a model's API key, for the same reason: a write-once secret that a
 * later edit can silently erase is a data-loss bug wearing the clothes of a form.
 */

export interface Peer {
  readonly name: string
  readonly url: string
  readonly token?: string
}

/**
 * What the peer named by `draft` should become.
 *
 * @param draft what the person typed, untrimmed.
 * @param existing the stored peer of the same name, if there is one.
 * @returns the peer to store, or `undefined` when the draft is not complete enough to store at all.
 */
export const mergePeer = (input: { readonly draft: Peer; readonly existing?: Peer }): Peer | undefined => {
  const name = input.draft.name.trim()
  const url = input.draft.url.trim()
  if (name === "" || url === "") return undefined
  const typed = input.draft.token?.trim()
  // ⚠️ The `?? undefined` matters: an existing peer with no token must yield a peer with no token,
  // not one carrying an empty string, so the stored shape is the same whichever path produced it.
  const token = typed ? typed : (input.existing?.token ?? undefined)
  return token === undefined || token === "" ? { name, url } : { name, url, token }
}
