export const SHARE_PREVIEW_VERSION = 2

export function getShareVersion(manifest) {
  return `${manifest?.generatedAt || manifest?.version || "1"}-${SHARE_PREVIEW_VERSION}`
}
