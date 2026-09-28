import { userInfo } from "node:os"

export const instanceOwnerName = (): string => {
  try {
    return userInfo().username.trim() || "Owner"
  } catch {
    return "Owner"
  }
}
