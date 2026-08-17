#!/usr/bin/env bun
// stub-model-server.ts — an OpenAI-compatible endpoint that answers with a fixed sentence.
//
// 🔴 Exists so the ANSWERING path can be exercised end to end without spending anybody's tokens or
// borrowing the owner's provider credentials. Every verification of that feature so far has been a
// REFUSAL — the happy path, which is the whole point of it, had never once run.
//
// ⚠️ It is a stub, and what it proves is bounded: that a question reaches a model, that the reply is
// signed and verifiable, that the spend is recorded and the budget moves. It proves nothing about
// answer QUALITY, and nothing about how a real model behaves with the system prompt.
//
//   bun tests/stub-model-server.ts [port]

const port = Number(process.argv[2] ?? 4111)

/** What every completion says, so a test can assert the answer arrived intact through the turn. */
const ANSWER = "I did not see it myself; two peers upriver say the bridge is standing."

const seen: { prompts: string[] } = { prompts: [] }

Bun.serve({
  port,
  idleTimeout: 30,
  async fetch(request) {
    const url = new URL(request.url)

    // The catalog probe: some paths list models before anything will resolve one.
    if (url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "stub-model", object: "model" }] })
    }

    if (url.pathname.endsWith("/chat/completions")) {
      const body = (await request.json().catch(() => ({}))) as {
        messages?: Array<{ role: string; content: unknown }>
        stream?: boolean
      }
      // ⚠️ Kept so a test can assert the question was FENCED before it reached the model — the frame
      // is the one defence between a stranger's words and a model that is supposed to act on them.
      seen.prompts.push(JSON.stringify(body.messages ?? []))

      if (body.stream === true) {
        const chunks = [
          `data: ${JSON.stringify({ id: "cmpl", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: ANSWER } }] })}\n\n`,
          `data: ${JSON.stringify({ id: "cmpl", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ]
        return new Response(chunks.join(""), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        })
      }

      return Response.json({
        id: "cmpl",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "stub-model",
        choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }

    // What the model was ASKED, for a probe to read back.
    if (url.pathname === "/seen") return Response.json(seen)

    return new Response("not found", { status: 404 })
  },
})

console.log(`stub model on http://127.0.0.1:${port}/v1 — answers every completion with a fixed line`)
