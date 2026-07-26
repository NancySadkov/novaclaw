import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "app.novaclaw.desktop" : `app.novaclaw.desktop.${channel}`
const productName = channel === "prod" ? "NovaClaw" : `NovaClaw ${channel.charAt(0).toUpperCase() + channel.slice(1)}`
const summary = `Local-first AI agent OS${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>LicenseRef-FSL-1.1-ALv2</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="app.novaclaw">
    <name>Nancy Sadkov</name>
  </developer>

  <description>
    <p>
      NovaClaw is a local-first agent OS that helps you write and run code with any AI model.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="homepage">https://novaclaw.app</url>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
