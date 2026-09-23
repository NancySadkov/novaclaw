import { describe, expect, test } from "bun:test"
import { desktopExecutableName, desktopHelp, desktopOptionError, parseDesktopInvocation } from "./desktop-cli"

describe("desktop command line", () => {
  test.each(["-h", "--help"])("%s selects help without launching", (flag) => {
    expect(parseDesktopInvocation(["C:\\NovaClaw.exe", flag])).toEqual({ action: "help" })
  })

  test("prints the version without launching", () => {
    expect(parseDesktopInvocation(["NovaClaw.exe", "--version"])).toEqual({ action: "version" })
  })

  test("groups the complete public command line by general, client, and server roles", () => {
    const help = desktopHelp()
    expect(help).toStartWith("Usage: NovaClaw.exe [OPTION]... [novaclaw://URL | recipe.nova]\n")
    expect(help).toContain("\nGeneral options:\n")
    expect(help).toContain("\nClient options (with --client-only):\n")
    expect(help).toContain("\nServer options:\n")
    for (const option of [
      "--home=DIR",
      "--client-only",
      "--server-only",
      "-h, --help",
      "--version",
      "--connect=URL",
      "--connect-username=USER",
      "--connect-password=TOKEN",
      "--hostname=HOST",
      "--port=PORT",
      "--username=USER",
      "--password=TOKEN",
      "--cors=ORIGIN",
      "--mdns",
      "--mdns-domain=DOMAIN",
      "--[no-]supervise",
    ])
      expect(help, option).toContain(option)
  })

  test("retires Chromium's old user-data spelling with the replacement in the error", () => {
    const parsed = parseDesktopInvocation(["C:\\NovaClaw.exe", "--user-data-dir=D:\\old"])
    expect(parsed).toEqual({ action: "error", message: "option '--user-data-dir' has been renamed to '--home'" })
    expect(desktopOptionError("NovaClaw.exe", parsed.action === "error" ? parsed.message : "")).toBe(
      "NovaClaw.exe: option '--user-data-dir' has been renamed to '--home'\n" +
        "Try 'NovaClaw.exe --help' for more information.\n",
    )
  })

  test("defaults to launching client and server on loopback", () => {
    expect(parseDesktopInvocation(["NovaClaw.exe", "--home=D:\\one"])).toEqual({
      action: "launch",
      options: {
        mode: "both",
        server: {
          hostname: "127.0.0.1",
          username: "novaclaw",
          cors: [],
          mdns: false,
          mdnsDomain: "novaclaw.local",
          supervise: true,
        },
      },
    })
  })

  test("parses a client-only connection", () => {
    expect(
      parseDesktopInvocation([
        "NovaClaw.exe",
        "--client-only",
        "--connect=https://nova.example",
        "--connect-username=alice",
        "--connect-password=secret",
      ]),
    ).toMatchObject({
      action: "launch",
      options: {
        mode: "client",
        connect: { url: "https://nova.example", username: "alice", password: "secret" },
      },
    })
  })

  test("parses all headless server options", () => {
    expect(
      parseDesktopInvocation([
        "NovaClaw.exe",
        "--server-only",
        "--hostname=0.0.0.0",
        "--port",
        "4096",
        "--username=alice",
        "--password=secret",
        "--cors=https://one.example",
        "--cors",
        "https://two.example",
        "--mdns",
        "--mdns-domain=nova.local",
        "--no-supervise",
      ]),
    ).toEqual({
      action: "launch",
      options: {
        mode: "server",
        server: {
          hostname: "0.0.0.0",
          port: 4096,
          username: "alice",
          password: "secret",
          cors: ["https://one.example", "https://two.example"],
          mdns: true,
          mdnsDomain: "nova.local",
          supervise: false,
        },
      },
    })
  })

  test("mDNS without an explicit hostname listens on all interfaces", () => {
    expect(parseDesktopInvocation(["NovaClaw.exe", "--server-only", "--mdns"])).toMatchObject({
      action: "launch",
      options: { server: { hostname: "0.0.0.0", mdns: true } },
    })
  })

  test("headless server refuses a recipe package argument", () => {
    expect(parseDesktopInvocation(["NovaClaw.exe", "--server-only", "sample.nova"])).toEqual({
      action: "error",
      message: "a link or .nova package cannot be opened with '--server-only'",
    })
  })

  test("rejects incomplete and contradictory modes", () => {
    for (const [argv, message] of [
      [["NovaClaw.exe", "--home"], "option '--home' requires a value"],
      [["NovaClaw.exe", "--client-only"], "option '--client-only' requires '--connect=URL'"],
      [
        ["NovaClaw.exe", "--client-only", "--server-only"],
        "options '--client-only' and '--server-only' cannot be used together",
      ],
      [
        ["NovaClaw.exe", "--client-only", "--connect=http://host", "--port=4096"],
        "server option '--port' cannot be used with '--client-only'",
      ],
      [["NovaClaw.exe", "--server-only", "--connect=http://host"], "client option '--connect' cannot be used with '--server-only'"],
      [["NovaClaw.exe", "--port=70000"], "option '--port' must be a whole number from 0 to 65535"],
      [["NovaClaw.exe", "--client-only", "--connect=file:///tmp/nova"], "option '--connect' requires an http:// or https:// URL"],
    ] as const)
      expect(parseDesktopInvocation(argv)).toEqual({ action: "error", message })
  })

  test("Chromium switches and deep links continue to launch the combined app", () => {
    expect(
      parseDesktopInvocation(["NovaClaw.exe", "--remote-debugging-port=9222", "novaclaw://session/ses_1"]),
    ).toMatchObject({ action: "launch", options: { mode: "both" } })
  })

  test("uses the real executable basename in diagnostics", () => {
    expect(desktopExecutableName("C:\\Apps\\NovaClaw.exe")).toBe("NovaClaw.exe")
  })
})
