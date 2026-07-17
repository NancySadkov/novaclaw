import { createNovaclawClient, createNovaclawServer } from "@novaclaw/sdk/v2"
import { pathToFileURL } from "bun"

const server = await createNovaclawServer()
const client = createNovaclawClient({ baseUrl: server.url, directory: process.cwd() })

const input = await Array.fromAsync(new Bun.Glob("packages/core/*.ts").scan())

await Promise.all(
  input.map(async (file) => {
    const session = await client.v2.session.create({})
    const sessionID = session.data!.data.id
    console.log("processing", file)
    await client.v2.session.prompt({
      sessionID,
      prompt: {
        text: "Write tests for every public function in this file.",
        files: [{ uri: pathToFileURL(file).href, name: file }],
      },
    })
    console.log("done", file)
  }),
)
