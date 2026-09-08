/** Keep the sidecar on the complete instance selected by the desktop parent. In particular, never
 * redirect state to Electron userData: auth.json lives in the instance data home and must be opened
 * with the credential key from the matching instance state home. */
export function prepareSidecarEnv(password: string) {
  Object.assign(process.env, {
    NOVACLAW_SERVER_USERNAME: "novaclaw",
    NOVACLAW_SERVER_PASSWORD: password,
  })
}
