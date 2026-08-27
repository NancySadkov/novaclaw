import { mkdir } from "node:fs/promises"
import path from "node:path"
import { OfficerName } from "@novaclaw/core/agent/officer-name"
import { BESPOKE_AGENT_PORTRAITS } from "../src/apps/agent-portrait"

const output = path.resolve(import.meta.dir, "../public/assets/agents/portraits")

type Motif =
  | "cosmos"
  | "light"
  | "night"
  | "sea"
  | "fire"
  | "storm"
  | "earth"
  | "wild"
  | "craft"
  | "wisdom"
  | "healing"
  | "justice"
  | "war"
  | "music"
  | "fate"
  | "threshold"
  | "love"
  | "serpent"
  | "harvest"
  | "oracle"

const EXACT: Partial<Record<string, Motif>> = {
  abraxas: "cosmos",
  achilles: "war",
  aceso: "healing",
  adamanthea: "earth",
  adonis: "love",
  aegisthus: "war",
  aglaea: "light",
  aidos: "justice",
  aion: "fate",
  ajax: "war",
  amalthea: "harvest",
  antigone: "justice",
  apollonius: "music",
  argo: "sea",
  ariadne: "threshold",
  artemis: "wild",
  asclepius: "healing",
  astarte: "cosmos",
  atalanta: "wild",
  atlas: "cosmos",
  atropos: "fate",
  bacchus: "harvest",
  bellerophon: "war",
  brontes: "storm",
  cadmus: "wisdom",
  ceres: "harvest",
  charon: "threshold",
  chiron: "healing",
  corvus: "wild",
  cybele: "earth",
  daedalus: "craft",
  danae: "light",
  deimos: "war",
  demeter: "harvest",
  dionys: "harvest",
  dionysus: "harvest",
  echo: "music",
  erato: "music",
  eris: "storm",
  eupraxia: "justice",
  gaia: "earth",
  gorgon: "serpent",
  hades: "night",
  harmonia: "music",
  hecate: "threshold",
  hector: "war",
  helios: "light",
  hephestus: "craft",
  heracles: "war",
  hermes: "threshold",
  hesiod: "wisdom",
  hestia: "fire",
  homer: "music",
  hypatia: "wisdom",
  hypnos: "night",
  iaso: "healing",
  indra: "storm",
  iris: "light",
  ishtar: "love",
  janus: "threshold",
  jupiter: "storm",
  justitia: "justice",
  kali: "fate",
  kronos: "fate",
  lysander: "war",
  machaon: "healing",
  mars: "war",
  medea: "oracle",
  metis: "wisdom",
  midas: "craft",
  minerva: "wisdom",
  morpheus: "night",
  myron: "craft",
  nemesis: "justice",
  nestor: "wisdom",
  nike: "war",
  niobe: "earth",
  nyx: "night",
  oceanus: "sea",
  oedipus: "fate",
  orion: "cosmos",
  orpheus: "music",
  pandoreus: "threshold",
  peitho: "love",
  persephone: "harvest",
  perseus: "war",
  phanes: "light",
  phobos: "war",
  polaris: "cosmos",
  prometheus: "fire",
  proteus: "sea",
  pyrrho: "wisdom",
  rhea: "earth",
  sappho: "music",
  sibyl: "oracle",
  sisyphos: "fate",
  socrates: "wisdom",
  talos: "craft",
  tethys: "sea",
  tiresias: "oracle",
  tisiphone: "justice",
  tyche: "fate",
  typhon: "storm",
  uranos: "cosmos",
  vesta: "fire",
  xenia: "love",
  zephyrus: "storm",
  zeno: "wisdom",
}

const ROOTS: ReadonlyArray<readonly [RegExp, Motif]> = [
  [/(aether|aero|astr|aurig|deneb|kosmo|luna|pol|stell|uran|zoos)/, "cosmos"],
  [/(aegl|alb|elect|hel|luc|lumen|phan|phoeb|sol|zest)/, "light"],
  [/(calig|ereb|frigus|fusc|nigr|nox|obscur|somn|tenebr|umbr)/, "night"],
  [/(aeg(e|eo)|aqua|galat|hydr|neil|nere|ocean|pelag|poseid|psari|teth)/, "sea"],
  [/(aest|aith|aitne|agniv|pyre|pyr|vesta)/, "fire"],
  [/(bront|tempest|thye|trykym|zephyr)/, "storm"],
  [/(adamant|arcad|athos|gaia|krana|nemea|rhea)/, "earth"],
  [/(aegipan|fauna|galeos|kykn|silvan|theron|ursin|vukol)/, "wild"],
  [/(arch|argyr|daedal|heph|kelmis|mulcib|talos)/, "craft"],
  [/(anax|arist|empir|ephor|hesiod|plutarch|socrat|timae)/, "wisdom"],
  [/(aces|asclep|hyg|iaso|machaon|nectar)/, "healing"],
  [/(adras|aeac|aidos|dik|eumen|just|nemes|poine|rhad)/, "justice"],
  [/(achill|agamemn|ajax|ares|hector|mavor|peleus|sarped|telamon|tydeus)/, "war"],
  [/(apoll|erato|harmon|linos|musa|orphe|sappho|thespis)/, "music"],
  [/(aion|aisa|atropos|kron|moros|tempus|tyche)/, "fate"],
  [/(charon|hecat|janus|kharos|lavern|persephon)/, "threshold"],
  [/(adon|aglae|eulal|peitho|venus|xenia)/, "love"],
  [/(ceto|gorgon|ladon|ophis|serpent|typhon)/, "serpent"],
  [/(ampel|bacch|ceres|demet|dionys|midas|semele)/, "harvest"],
]

const motifFor = (name: string): Motif => EXACT[name] ?? ROOTS.find(([root]) => root.test(name))?.[1] ?? "oracle"

const hash = (value: string) => {
  let result = 2166136261
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619)
  return result >>> 0
}

const SYMBOL: Record<Motif, string> = {
  cosmos: '<circle cx="128" cy="86" r="51" fill="none"/><path d="M128 22v32M96 31l16 28M160 31l-16 28"/>',
  light:
    '<circle cx="128" cy="80" r="38"/><path d="M128 22v24M128 114v24M70 80h24M162 80h24M87 39l17 17M152 104l17 17M169 39l-17 17M104 104l-17 17"/>',
  night:
    '<path d="M155 35a47 47 0 1 0 0 90 53 53 0 1 1 0-90Z"/><circle cx="91" cy="49" r="3"/><circle cx="178" cy="78" r="2"/>',
  sea: '<path d="M47 74c18-20 36 20 54 0s36 20 54 0 36 20 54 0M47 96c18-20 36 20 54 0s36 20 54 0 36 20 54 0"/>',
  fire: '<path d="M128 25c35 37-5 43 17 72 8 11 13 22 4 40-8-23-20-24-22-44-11 17-23 27-18 48-29-25-13-55 1-72 12-15 14-29 18-44Z"/>',
  storm: '<path d="M145 25 93 92h31l-15 47 54-68h-33Z"/>',
  earth: '<path d="m61 119 38-58 22 28 19-40 55 70Z"/><path d="M83 119h90"/>',
  wild: '<path d="M73 116c0-46 25-73 55-87 30 14 55 41 55 87-21-20-35-30-55-32-20 2-34 12-55 32Z"/>',
  craft:
    '<circle cx="128" cy="82" r="42"/><circle cx="128" cy="82" r="18"/><path d="M128 21v19M128 124v19M67 82h19M170 82h19M85 39l14 14M157 111l14 14M171 39l-14 14M99 111l-14 14"/>',
  wisdom: '<path d="M69 114V46l59-19 59 19v68l-59-20Z"/><circle cx="128" cy="61" r="16"/>',
  healing: '<path d="M128 25v112M91 62h74"/><path d="M98 122c15-10 15-22 0-32M158 122c-15-10-15-22 0-32"/>',
  justice: '<path d="M128 27v105M79 48h98M91 48l-24 48h48Zm74 0-24 48h48Z"/>',
  war: '<path d="m128 24 57 22v38c0 32-22 48-57 61-35-13-57-29-57-61V46Z"/><path d="m103 82 17 17 35-39"/>',
  music: '<path d="M112 35v77c0 18-35 23-35 4 0-15 23-20 35-11M112 47l58-14v65c0 18-35 23-35 4 0-15 23-20 35-11V33"/>',
  fate: '<path d="M88 29h80M88 137h80M100 30c0 30 28 35 28 52s-28 22-28 54M156 30c0 30-28 35-28 52s28 22 28 54"/>',
  threshold: '<path d="M76 137V68c0-56 104-56 104 0v69M105 137V72c0-25 46-25 46 0v65"/>',
  love: '<path d="M128 133 73 80c-30-34 20-70 55-29 35-41 85-5 55 29Z"/>',
  serpent: '<path d="M88 41c65-27 81 25 30 37-43 10-40 51 22 53 19 1 29-8 30-19"/><circle cx="92" cy="40" r="7"/>',
  harvest:
    '<path d="M128 137V38M126 63c-24-1-37-12-39-31 23 0 36 11 39 31Zm4 22c24-1 37-12 39-31-23 0-36 11-39 31Zm-4 22c-24-1-37-12-39-31 23 0 36 11 39 31Z"/>',
  oracle:
    '<circle cx="128" cy="80" r="50"/><path d="M77 80c27-34 75-34 102 0-27 34-75 34-102 0Z"/><circle cx="128" cy="80" r="17"/>',
}

const MOTIF_COLOR: Record<Motif, string> = {
  cosmos: "#9ea7ff",
  light: "#fff1af",
  night: "#aa83d8",
  sea: "#63d6df",
  fire: "#ff8a55",
  storm: "#a7bfff",
  earth: "#8dcc8a",
  wild: "#75c99a",
  craft: "#62c9bd",
  wisdom: "#b5a8ff",
  healing: "#72d7ac",
  justice: "#eee1c6",
  war: "#e98279",
  music: "#e89ecf",
  fate: "#c89be8",
  threshold: "#8eb6e8",
  love: "#ef9aae",
  serpent: "#8fd184",
  harvest: "#dfbd62",
  oracle: "#c1a4ed",
}

const portrait = (name: string) => {
  const seed = hash(name)
  const motif = motifFor(name)
  const accent = MOTIF_COLOR[motif]
  const hue = 266 + (seed % 32)
  const eye = 112 + (seed % 33)
  const jaw = 92 + (seed % 20)
  const crown = 57 + (seed % 19)
  const orbit = 3 + (seed % 6)
  const form = seed % 6
  const title = `${OfficerName.display(name)}: ${motif} motif interpreted as a NovaClaw synthetic colleague`

  const eyeMark = (x: number, y: number, scale = 1) => `<g transform="translate(${x} ${y}) scale(${scale})">
<path d="M-57 0Q0-50 57 0 0 50-57 0Z" fill="#e7c878" stroke="url(#gold)" stroke-width="5"/>
<ellipse rx="26" ry="28" fill="url(#iris)" filter="url(#glow)"/><circle r="11" fill="#17080a"/><circle cx="${eye - 128}" cy="-11" r="5" fill="#fff7d2"/>
</g>`
  const motifMark = (x: number, y: number, scale: number) =>
    `<g transform="translate(${x - 128 * scale} ${y - 80 * scale}) scale(${scale})" fill="none" stroke="${accent}" stroke-width="${Math.max(5, 2 / scale)}" filter="url(#glow)">${SYMBOL[motif]}</g>`
  const plaque = `<circle cx="128" cy="205" r="27" fill="#13091d" stroke="url(#gold)" stroke-width="3"/>${motifMark(128, 205, 0.24)}`

  const forms = [
    // A colleague-shaped bust: familiar, but now only one member of the family.
    `<path d="M31 256c8-57 43-83 82-91h30c39 8 74 34 82 91Z" fill="#13091d" stroke="#8f5a22" stroke-width="3"/>
<path d="M52 256c9-45 37-65 76-76 39 11 67 31 76 76Z" fill="hsl(${hue} 48% 15%)" stroke="url(#gold)" stroke-width="3"/>
<path d="M${crown} 73Q128 22 ${256 - crown} 73l-9 91-${49 - (seed % 11)} 39H${98 - (seed % 11)}L${crown + 9} 164Z" fill="#100817" stroke="url(#gold)" stroke-width="5"/>
<path d="M${crown + 5} 72 90 36l21 37 17-49 17 49 21-37 ${85 - crown + 128} 72-22 16H${crown + 27}Z" fill="url(#gold)" opacity=".92"/>
<path d="M${jaw} 119q36 31 ${256 - jaw} 0l-7 54-29 28-29-28Z" fill="hsl(${hue} 58% 18%)" stroke="#d7a94b" stroke-width="3"/>
<path d="M${jaw + 7} 127q29 23 ${249 - jaw} 0" fill="none" stroke="${accent}" stroke-width="3" opacity=".8"/>
${eyeMark(128, 105)}${plaque}`,

    // A self-contained thinking orb, closer to an instrument than a body.
    `<circle cx="128" cy="128" r="91" fill="#100817" stroke="url(#gold)" stroke-width="7"/>
<circle cx="128" cy="128" r="76" fill="hsl(${hue} 58% 17%)" stroke="${accent}" stroke-width="3"/>
<path d="M49 108c25-78 133-94 160-13M48 148c28 68 131 82 162 7" fill="none" stroke="url(#gold)" stroke-width="8"/>
<path d="M73 55 52 31M183 55l21-24M65 190l-25 21M191 190l25 21" stroke="${accent}" stroke-width="5"/>
${eyeMark(128, 119, 0.9)}${motifMark(128, 184, 0.25)}`,

    // A crystalline monolith: a vertical intelligence with no anatomical cues.
    `<path d="m128 18 64 55-18 139-46 31-46-31L64 73Z" fill="hsl(${hue} 60% 13%)" stroke="url(#gold)" stroke-width="6"/>
<path d="m128 18 18 59-18 152-18-152Z" fill="${accent}" opacity=".24"/>
<path d="m64 73 46 4M192 73l-46 4M82 212l28-32M174 212l-28-32" fill="none" stroke="${accent}" stroke-width="3" opacity=".9"/>
<circle cx="128" cy="104" r="62" fill="none" stroke="#d8ab4b" stroke-dasharray="3 8" opacity=".45"/>
${eyeMark(128, 105, 0.76)}${motifMark(128, 187, 0.27)}`,

    // A ribbon-mask: related to the logo's embracing curves, but freely abstract.
    `<path d="M23 102C53 33 83 28 128 86c45-58 75-53 105 16-36-20-53-8-74 21 28 31 38 72 25 111-21-37-38-48-56-49-18 1-35 12-56 49-13-39-3-80 25-111-21-29-38-41-74-21Z" fill="#100817" stroke="url(#gold)" stroke-width="6"/>
<path d="M25 100c43 10 62 32 72 62M231 100c-43 10-62 32-72 62" fill="none" stroke="${accent}" stroke-width="10" opacity=".78"/>
<path d="M62 54c31 11 50 30 66 60 16-30 35-49 66-60" fill="none" stroke="url(#gold)" stroke-width="13"/>
${eyeMark(128, 112, 0.86)}${motifMark(128, 188, 0.25)}`,

    // A winged signal: the eye is a sensor suspended between two expressive vanes.
    `<path d="M111 74C78 34 41 32 18 45c35 13 54 36 64 68-28-12-50-9-67 3 32 14 54 39 70 78 10-30 18-53 43-77Z" fill="hsl(${hue} 48% 17%)" stroke="url(#gold)" stroke-width="5"/>
<path d="M145 74c33-40 70-42 93-29-35 13-54 36-64 68 28-12 50-9 67 3-32 14-54 39-70 78-10-30-18-53-43-77Z" fill="hsl(${hue} 48% 17%)" stroke="url(#gold)" stroke-width="5"/>
<path d="M31 55c33 22 51 48 61 83M225 55c-33 22-51 48-61 83" fill="none" stroke="${accent}" stroke-width="5" opacity=".9"/>
<circle cx="128" cy="118" r="62" fill="#100817" stroke="#d8ab4b" stroke-width="6"/>
${eyeMark(128, 118, 0.78)}${motifMark(128, 204, 0.28)}`,

    // A floating sigil-entity: symbol, plates, and perception held together without a body.
    `<g opacity=".9">${motifMark(128, 105, 0.72)}</g>
<path d="m128 17 21 49 52-20-23 49 49 23-51 18 17 53-48-26-25 50-14-54-55 12 35-45-42-36 56-2Z" fill="hsl(${hue} 62% 14%)" stroke="url(#gold)" stroke-width="5" opacity=".94"/>
<path d="M36 64 67 48l10 34-33 9ZM220 64l-31-16-10 34 33 9ZM56 196l32-18 13 32-36 12ZM200 196l-32-18-13 32 36 12Z" fill="${accent}" stroke="#f1cf78" stroke-width="3" opacity=".68"/>
${eyeMark(128, 118, 0.88)}
<circle cx="128" cy="118" r="72" fill="none" stroke="${accent}" stroke-width="3" stroke-dasharray="2 10"/>`,
  ]

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img">
<title>${title}</title><defs>
<radialGradient id="bg" cx="50%" cy="34%"><stop stop-color="${accent}" stop-opacity=".42"/><stop offset=".48" stop-color="hsl(${hue} 55% 20%)"/><stop offset="1" stop-color="#09050f"/></radialGradient>
<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff1af"/><stop offset=".28" stop-color="#e9bd61"/><stop offset=".68" stop-color="#9c6120"/><stop offset="1" stop-color="#f1cf78"/></linearGradient>
<radialGradient id="iris"><stop stop-color="#fff7cf"/><stop offset=".18" stop-color="#f5d778"/><stop offset=".62" stop-color="#b66f1e"/><stop offset="1" stop-color="#2b1207"/></radialGradient>
<filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs><rect width="256" height="256" fill="url(#bg)"/>
<g fill="none" stroke="${accent}" stroke-width="3" opacity=".32">${SYMBOL[motif]}</g>
<g fill="none" stroke="#f4d985" opacity=".18">${Array.from({ length: orbit }, (_, index) => `<circle cx="128" cy="100" r="${66 + index * 7}" stroke-dasharray="${2 + (seed % 4)} ${8 + index}"/>`).join("")}</g>
${forms[form]}
</svg>`
}

await mkdir(output, { recursive: true })
const generated = OfficerName.POOL.filter((name) => !BESPOKE_AGENT_PORTRAITS.has(name))
for (const name of generated) await Bun.write(path.join(output, `${name}.svg`), portrait(name))
console.log(`Generated ${generated.length} officer portraits in ${output}`)
