export * as LinkedAccount from "./linked-account"

/**
 * What a LINKED-ACCOUNT driver shares with every other one.
 *
 * A linked account is one where **the human and the agent are the same identity** — we are logged in
 * as the person, not as a bot beside them. `telegram-user` and `whatsapp-baileys` are both this
 * shape, and before 2026-09-01 they carried byte-identical copies of the two helpers below
 * (). The copies had already drifted apart in their error mapping, which is the argument for
 * this module existing: a rule about *our own echo* is not a per-platform decision, and two copies
 * of it drift silently because nothing compares them.
 *
 * ⚠️ **What does NOT belong here: anything a platform decides differently.** WhatsApp's
 * `foldSelfAddress` (phone JID vs LID) stays in its own driver — it looks like an identity helper
 * and is really a WhatsApp addressing quirk. The test for this module is "would BOTH drivers be
 * wrong if this changed?" If only one would, it is not shared.
 */

/**
 * A bounded FIFO of the `chat:message` ids WE sent, so an outgoing message coming back down the pump
 * can be recognised as our own echo.
 *
 * Bounded on purpose: a linked account can be years old and this must not grow with it. Eviction is
 * oldest-first, so the window is "the last N we sent" — ample, because an echo arrives within
 * seconds of the send that produced it, never hours later.
 */
export const sentTracker = (capacity: number) => {
  const order: string[] = []
  const set = new Set<string>()
  const key = (chatID: string, messageID: string) => `${chatID}:${messageID}`
  return {
    add: (chatID: string, messageID: string) => {
      const item = key(chatID, messageID)
      if (set.has(item)) return
      set.add(item)
      order.push(item)
      if (order.length > capacity) {
        const evicted = order.shift()
        if (evicted !== undefined) set.delete(evicted)
      }
    },
    has: (chatID: string, messageID: string) => set.has(key(chatID, messageID)),
  }
}

/**
 * The self-echo policy for a linked account, in four cases. Both drivers reached this same rule
 * independently, in identical code — it follows from the one-identity premise rather than from any
 * platform's API:
 *
 *  - **incoming** (not outgoing) → never self.
 *  - **outgoing that WE sent** → self (drop: our own relay echoing back).
 *  - **outgoing in the SELF-chat we did NOT send** → the OPERATOR typing on their own phone. This is
 *    the remote-control console, so it is REAL input, not an echo. 🔴 Getting this case wrong is how
 *    the console silently stops working — the message is dropped and nothing reports it.
 *  - **outgoing anywhere else we did not send** → the human using their own account (or another
 *    device). Acting as them there is not our turn → self (drop).
 *
 * ⚠️ `selfID` must be the CANONICAL self id. Where a platform addresses one account two ways, fold
 * to canonical before calling this (WhatsApp does exactly that with `foldSelfAddress`) — the
 * self-chat case is an equality test, so an unfolded alias reads as a stranger who happens to share
 * our identity, and the console never fires.
 */
export const isSelfMessage = (
  message: { readonly outgoing: boolean; readonly chatID: string; readonly messageID: string },
  selfID: string,
  wasSentByUs: boolean,
): boolean => {
  if (!message.outgoing) return false
  if (wasSentByUs) return true
  return message.chatID !== selfID
}
