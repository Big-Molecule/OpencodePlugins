import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, statSync } from "node:fs"
import { extname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const SOURCE_MARKER = "opencode-local-image:"
const MIME_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

function decodePath(value: string) {
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value)
    } catch {
      return
    }
  }
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function inside(root: string, path: string) {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function sourcePath(value: string, directory: string) {
  if (/^(?:data:|https?:|blob:)/i.test(value)) return
  const decoded = decodePath(value)
  if (!decoded) return
  const path = resolve(directory, decoded)
  if (!inside(directory, path) || !existsSync(path)) return
  return path
}

function marker(value: string) {
  return Buffer.from(value, "utf8").toString("base64url")
}

function unmarker(value: string) {
  try {
    return Buffer.from(value, "base64url").toString("utf8")
  } catch {
    return
  }
}

export function inlineLocalMarkdownImages(text: string, directory: string) {
  return text.replace(/!\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g, (full, alt, rawUrl) => {
    const wrapped = rawUrl.startsWith("<") && rawUrl.endsWith(">")
    const source = wrapped ? rawUrl.slice(1, -1) : rawUrl
    const path = sourcePath(source, directory)
    if (!path) return full

    const mime = MIME_BY_EXTENSION[extname(path).toLowerCase()]
    if (!mime) return full
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return full

    const data = readFileSync(path).toString("base64")
    return `![${alt}](data:${mime};base64,${data} "${SOURCE_MARKER}${marker(source)}")`
  })
}

export function restoreLocalMarkdownImageSources(text: string) {
  const pattern = new RegExp(
    `!\\[([^\\]]*)\\]\\(data:image\\/(?:gif|jpeg|png|webp);base64,[A-Za-z0-9+/=]+ "${SOURCE_MARKER}([A-Za-z0-9_-]+)"\\)`,
    "g",
  )
  return text.replace(pattern, (full, alt, encoded) => {
    const source = unmarker(encoded)
    return source ? `![${alt}](${source})` : full
  })
}

export const LocalMarkdownImagesPlugin: Plugin = async ({ directory }) => ({
  "experimental.text.complete": async (_input, output) => {
    output.text = inlineLocalMarkdownImages(output.text, directory)
  },

  // Keep large data URLs out of subsequent model requests while retaining them
  // in the persisted assistant message used by the Desktop renderer.
  "experimental.chat.messages.transform": async (_input, output) => {
    for (const message of output.messages) {
      if (message.info?.role !== "assistant") continue
      for (const part of message.parts) {
        if (part.type !== "text" || typeof part.text !== "string") continue
        part.text = restoreLocalMarkdownImageSources(part.text)
      }
    }
  },
})

export default LocalMarkdownImagesPlugin
