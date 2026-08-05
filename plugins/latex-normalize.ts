import { type Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

type Mode = "safe" | "aggressive"

type LatexNormalizeConfig = {
  enabled?: boolean
  mode?: Mode
  /** Promote inline $...$ / \(...\) to display $$ blocks (default true). */
  promoteInline?: boolean
  /** Also rewrite messages already in the session when transform hook runs. */
  transformHistory?: boolean
}

const CONFIG_PATH = join(homedir(), ".config", "opencode", "latex-normalize.json")

const DEFAULTS: Required<LatexNormalizeConfig> = {
  enabled: true,
  mode: "safe",
  promoteInline: true,
  transformHistory: true,
}

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
const INLINE_CODE_RE = /`[^`\n]+`/g

const MATH_ENVS =
  "equation\\*?|align\\*?|gather\\*?|multline\\*?|eqnarray\\*?|flalign\\*?|alignat\\*?|pmatrix|bmatrix|vmatrix|Vmatrix|matrix|cases|array"

function loadConfig(): Required<LatexNormalizeConfig> {
  try {
    if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS }
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as LatexNormalizeConfig
    return {
      enabled: raw.enabled ?? DEFAULTS.enabled,
      mode: raw.mode === "aggressive" ? "aggressive" : "safe",
      promoteInline: raw.promoteInline ?? DEFAULTS.promoteInline,
      transformHistory: raw.transformHistory ?? DEFAULTS.transformHistory,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function protectSegments(text: string): { text: string; restore: (s: string) => string } {
  const slots: string[] = []
  const stash = (match: string) => {
    const i = slots.length
    slots.push(match)
    return `\u0000LNP${i}\u0000`
  }

  let out = text.replace(FENCE_RE, stash)
  out = out.replace(INLINE_CODE_RE, stash)

  return {
    text: out,
    restore: (s: string) => s.replace(/\u0000LNP(\d+)\u0000/g, (_, n) => slots[Number(n)] ?? ""),
  }
}

function looksLikeMath(inner: string): boolean {
  const s = inner.trim()
  if (!s || s.length > 400) return false
  if (/[\u4e00-\u9fff]/.test(s) && !/[\\^_{}]/.test(s)) return false
  if (/[\\^_{}]/.test(s)) return true
  if (/[=<>≤≥≈≠±×÷⋅]/.test(s) && /[A-Za-z]/.test(s)) return true
  if (/^[A-Za-z](?:_\{?[A-Za-z0-9]+\}?)?(?:\^[A-Za-z0-9]+)?$/.test(s)) return true
  if (/^[A-Za-z0-9+\-*/^_.,\s()]+$/.test(s) && /[A-Za-z]/.test(s) && /[=+\-*/^_]/.test(s)) return true
  return false
}

function looksLikeCurrencyOrNoise(before: string, inner: string, after: string): boolean {
  const s = inner.trim()
  // $5, $12.99, $1,000
  if (/^\d{1,3}(?:,\d{3})*(?:\.\d+)?$/.test(s)) return true
  if (/^\d+(?:\.\d+)?\s*(?:USD|usd|k|K|M|m)?$/.test(s)) return true
  // word$word unlikely math
  if (/\w$/.test(before) || /^\w/.test(after)) return true
  // empty or whitespace only
  if (!s) return true
  return false
}

function toDisplayBlock(body: string): string {
  const inner = body.replace(/^\n+|\n+$/g, "").trimEnd()
  return `\n\n$$\n${inner}\n$$\n\n`
}

function normalizeSingleLineDisplay(text: string): string {
  // $$...$$ on one line (no internal newlines) -> multi-line block
  return text.replace(/\$\$([^\n]+?)\$\$/g, (_m, inner: string) => {
    const body = String(inner).trim()
    if (!body) return _m
    return toDisplayBlock(body)
  })
}

function normalizeParenDelims(text: string): string {
  // \[ ... \] (block)
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_m, inner: string) => toDisplayBlock(String(inner)))
  // \( ... \) (inline)
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_m, inner: string) => toDisplayBlock(String(inner)))
  return text
}

function normalizeBareEnvs(text: string): string {
  const re = new RegExp(
    String.raw`\\begin\{(${MATH_ENVS})\}([\s\S]*?)\\end\{\1\}`,
    "g",
  )
  return text.replace(re, (match, _name: string, _body: string, offset: number, full: string) => {
    // Already wrapped in $$ ... $$
    const before = full.slice(0, offset)
    const after = full.slice(offset + match.length)
    if (/\$\$\s*$/.test(before) && /^\s*\$\$/.test(after)) return match
    return toDisplayBlock(match.trim())
  })
}

function normalizeInlineDollars(text: string, mode: Mode): string {
  // Scan manually so $5 does not pair with a later $x^2$.
  let out = ""
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch !== "$") {
      out += ch
      i++
      continue
    }
    // Skip $$ display open/close (handled elsewhere)
    if (text[i + 1] === "$") {
      out += "$$"
      i += 2
      continue
    }
    // Currency-like: $12.34 — do not treat as math open in safe mode
    if (mode === "safe" && /^\d/.test(text.slice(i + 1))) {
      out += "$"
      i++
      continue
    }

    // Find closing $ on same line (not $$)
    let j = i + 1
    let inner = ""
    let found = false
    while (j < text.length) {
      if (text[j] === "\n") break
      if (text[j] === "\\" && j + 1 < text.length) {
        inner += text[j] + text[j + 1]
        j += 2
        continue
      }
      if (text[j] === "$" && text[j + 1] !== "$") {
        found = true
        break
      }
      if (text[j] === "$" && text[j + 1] === "$") break
      inner += text[j]
      j++
    }

    if (!found) {
      out += "$"
      i++
      continue
    }

    const before = i > 0 ? text[i - 1]! : ""
    const after = j + 1 < text.length ? text[j + 1]! : ""
    let promote = true
    if (mode === "safe") {
      if (looksLikeCurrencyOrNoise(before, inner, after) || !looksLikeMath(inner)) promote = false
    } else if (looksLikeCurrencyOrNoise(before, inner, after) && !looksLikeMath(inner)) {
      promote = false
    }

    if (promote) out += toDisplayBlock(inner)
    else out += `$${inner}$`
    i = j + 1
  }
  return out
}

function collapseExtraBlankLines(text: string): string {
  return text.replace(/\n{4,}/g, "\n\n\n").replace(/[ \t]+\n/g, "\n")
}

/** Exported for local sanity checks. */
export function normalizeLatexMarkdown(text: string, cfg: Required<LatexNormalizeConfig> = DEFAULTS): string {
  if (!cfg.enabled || !text || !text.includes("$") && !text.includes("\\")) return text

  const { text: protectedText, restore } = protectSegments(text)
  let out = protectedText

  out = normalizeSingleLineDisplay(out)
  out = normalizeParenDelims(out)
  out = normalizeBareEnvs(out)
  if (cfg.promoteInline) {
    out = normalizeInlineDollars(out, cfg.mode)
  }

  out = collapseExtraBlankLines(out)
  return restore(out)
}

function partText(part: { type?: string; text?: string }): string | null {
  if (!part || part.type !== "text" || typeof part.text !== "string") return null
  return part.text
}

export const LatexNormalizePlugin: Plugin = async ({ client }) => {
  const cfg = loadConfig()

  await client.app.log({
    body: {
      service: "latex-normalize",
      level: "info",
      message: cfg.enabled
        ? `enabled mode=${cfg.mode} promoteInline=${cfg.promoteInline}`
        : "disabled via config",
    },
  }).catch(() => {})

  return {
    "experimental.text.complete": async (_input, output) => {
      if (!cfg.enabled) return
      const next = normalizeLatexMarkdown(output.text, cfg)
      if (next !== output.text) output.text = next
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      if (!cfg.enabled || !cfg.transformHistory) return
      for (const msg of output.messages) {
        if (msg.info?.role !== "assistant") continue
        for (const part of msg.parts) {
          const text = partText(part as { type?: string; text?: string })
          if (text == null) continue
          const next = normalizeLatexMarkdown(text, cfg)
          if (next !== text) (part as { text: string }).text = next
        }
      }
    },
  }
}
