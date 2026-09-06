/** Only the authenticated instance may turn this route-shaped value into image bytes. */
export const isAgentPortraitURL = (avatar: string | undefined): avatar is string =>
  avatar?.startsWith("/api/agent/") === true && avatar.includes("/avatar")
