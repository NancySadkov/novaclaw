import path from "node:path"
import { cmd } from "./cmd"
import { CommandSpec } from "../command-spec"
import { CliError } from "../effect-cmd"

export const DeployCommand = cmd({
  ...CommandSpec.deploy,
  builder: (yargs) =>
    yargs
      .positional("archive", { type: "string", demandOption: true, describe: "The .nova recipe package" })
      .option("directory", {
        type: "string",
        describe: "New absolute project folder on the server; defaults to its home/projects folder",
      })
      .option("attach", { type: "string", default: "http://127.0.0.1:4096", describe: "NovaClaw instance URL" })
      .option("model", {
        type: "string",
        describe: "Provider/model for this project's team; defaults to the instance model",
      })
      .option("username", { type: "string", default: "novaclaw" })
      .option("password", { type: "string", describe: "Instance API password" }),
  async handler(args) {
    try {
      if (path.extname(args.archive).toLowerCase() !== ".nova") throw new Error("Choose a .nova recipe archive.")
      const file = Bun.file(args.archive)
      if (!(await file.exists()) || file.size > 32 * 1024 * 1024)
        throw new Error("The recipe package is missing or exceeds 32 MiB.")
      const base = args.attach.replace(/\/$/, "")
      const auth: Record<string, string> = args.password
        ? { authorization: `Basic ${Buffer.from(`${args.username}:${args.password}`).toString("base64")}` }
        : {}
      const request = async (route: string, body: BodyInit, type: string) => {
        const response = await fetch(`${base}/api/recipe/${route}`, {
          method: "POST",
          headers: { ...auth, "content-type": type },
          body,
          signal: AbortSignal.timeout(120000),
        })
        if (!response.ok) {
          const text = await response.text()
          let message = text
          try {
            message = JSON.parse(text).message ?? text
          } catch {}
          throw new Error(`Deployment failed (${response.status}): ${message}`)
        }
        return response.json()
      }
      const recipe = (await request("archive", file, "application/zip")) as { slug: string }
      const deployment = await request(
        `${encodeURIComponent(recipe.slug)}/deploy`,
        JSON.stringify({
          ...(args.directory ? { directory: args.directory } : {}),
          ...(args.model ? { model: args.model } : {}),
        }),
        "application/json",
      )
      process.stdout.write(`${JSON.stringify(deployment, null, 2)}\n`)
    } catch (cause) {
      throw new CliError({ message: cause instanceof Error ? cause.message : String(cause) })
    }
  },
})
