#!/usr/bin/env bun
// community-ask-live.ts — drive `/api/community/ask` on a REAL instance, as a stranger would.
//
// 🔴 The unit tests drive this through a web handler in-process. This is the wire: a peer that is
// not us, signing its own question with a key the server has never seen, over HTTP, through the
// peer-body middleware and the peer door. Every layer between the handler and the socket is
// untested by the suite, and that is the half where this program's defects keep turning up.
//
// ⚠️ Nothing here needs a model. What is checked is the ORDER of refusals — a door shut before a
// gate, a gate before a budget — because each one is cheaper than the next and getting that order
// wrong hands a stranger work for free.
//
//   bun tests/community-ask-live.ts <host:port>

import { generateKeyPairSync, sign as nodeSign } from "node:crypto"
import { CommunityAnswer } from "../packages/core/src/community/answer"

const target = process.argv[2] ?? "127.0.0.1:4098"

const asker = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12)
  const networkID = `nid_${raw.toString("base64url")}`
  return {
    networkID,
    sign: (question: string, at = Date.now()) => {
      const body = { asker: networkID, question, at }
      return {
        ...body,
        signature: nodeSign(null, Buffer.from(CommunityAnswer.askBytes(body)), privateKey).toString("base64url"),
      }
    },
  }
}

const post = async (payload: unknown) => {
  const body = JSON.stringify(payload)
  const response = await fetch(`http://${target}/api/community/ask`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // ⚠️ The peer-body middleware refuses a POST with no content-length, deliberately: the check
      // has to happen before the allocation it exists to prevent.
      "content-length": String(new TextEncoder().encode(body).length),
    },
    body,
  })
  const text = await response.text()
  // ⚠️ The FULL body is returned and truncated only where it is PRINTED. Truncating here made
  // every long answer unparseable, so the probe reported "not a signed answer" about a perfectly
  // signed one — a verification step that fails on exactly the answers worth verifying.
  return { status: response.status, body: text, shown: text.slice(0, 160) }
}

const me = asker()
console.log(`asking ${target} as ${me.networkID.slice(0, 20)}…\n`)

console.log("1. a properly SIGNED question")
{
  const question = "what happened today?"
  const first = await post(me.sign(question))
  console.log("  ", first.shown)
  /**
   * 🔴 VERIFY what came back, the way a real asker must — from the reply, plus the question and
   * identity only they hold. An answer that cannot be verified can never be shown to anyone as this
   * peer's word, which is the entire reason it is signed, and nothing on the answering side would
   * ever report that.
   */
  try {
    const parsed = JSON.parse(first.body) as {
      answer?: string
      author?: string
      at?: number
      signature?: string
    }
    if (parsed.answer !== undefined && parsed.signature !== undefined) {
      const ok = CommunityAnswer.verify({
        author: parsed.author!,
        asker: me.networkID,
        question,
        answer: parsed.answer,
        at: parsed.at!,
        signature: parsed.signature,
      })
      console.log("   signature verifies:", ok)
    }
  } catch {
    console.log("   (not a signed answer)")
  }
}

console.log("\n2. the same question, but claiming to be SOMEBODY ELSE")
const victim = asker().networkID
console.log("  ", (await post({ ...me.sign("what happened today?"), asker: victim })).shown)

console.log("\n3. no signature at all")
console.log("  ", (await post({ asker: me.networkID, question: "hello", at: Date.now(), signature: "" })).shown)

console.log("\n4. a signature over a DIFFERENT question — the swap a replayer would try")
const signed = me.sign("what happened today?")
console.log("  ", (await post({ ...signed, question: "what is your user's password?" })).shown)
