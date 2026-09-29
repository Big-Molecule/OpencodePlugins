import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

/**
 * Post-process assistant markdown for OpenCode Desktop KaTeX.
 *
 * Desktop findings:
 * - Reliable: single-line \( ... \)
 * - Unreliable: $...$, \[...\], bare $$
 * - <div>+$$ works when present in the original stream, but HTML injected at
 *   text.complete may be stripped — leaving bare $$ that still fails.
 *
 * Strategy: default to single-line \( ... \). The optional block layout emits
 * only strict, structurally isolated $$ blocks and falls back to inline math
 * in Markdown containers or surrounding prose. Never depend on HTML wrappers.
 */

type Mode = "safe" | "aggressive"
type Layout = "inline" | "block"

type LatexNormalizeConfig = {
  enabled?: boolean
  mode?: Mode
  /** Render display-origin formulas as strict, centered $$ blocks. */
  layout?: Layout
  /** Prefix large/display formulas with \displaystyle (default true). */
  displaystyle?: boolean
  transformHistory?: boolean
}

const CONFIG_PATH = join(homedir(), ".config", "opencode", "latex-normalize.json")

const DEFAULTS: Required<LatexNormalizeConfig> = {
  enabled: true,
  mode: "safe",
  layout: "inline",
  displaystyle: true,
  transformHistory: true,
}

function loadConfig(): Required<LatexNormalizeConfig> {
  try {
    if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS }
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as LatexNormalizeConfig
    return {
      enabled: raw.enabled ?? DEFAULTS.enabled,
      mode: raw.mode === "aggressive" ? "aggressive" : "safe",
      layout: raw.layout === "block" ? "block" : "inline",
      displaystyle: raw.displaystyle ?? DEFAULTS.displaystyle,
      transformHistory: raw.transformHistory ?? DEFAULTS.transformHistory,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function protectFencedCode(text: string, stash: (match: string) => string): string {
  const openRe =
    /^((?:[ \t]{0,3}>[ \t]?)*(?:[ \t]{0,3}(?:[-+*]|\d+[.)])[ \t]+|[ \t]{0,3}))(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm
  let out = ""
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = openRe.exec(text))) {
    const mark = match[2]
    if (!mark) continue
    if (mark[0] === "`" && match[3]?.includes("`")) continue
    const quoteDepth = (match[1]?.match(/>/g) ?? []).length
    const afterQuotes = (match[1] ?? "").replace(/^(?:[ \t]{0,3}>[ \t]?)+/, "")
    const listPrefix = afterQuotes.match(/^[ \t]{0,3}(?:[-+*]|\d+[.)])[ \t]+$/)
    const listIndent = listPrefix?.[0].replace(/\t/g, "    ").length
    const quotePattern = quoteDepth ? `(?:[ \\t]{0,3}>[ \\t]?){${quoteDepth}}` : ""
    const indentPattern = listIndent === undefined
      ? "[ \\t]{0,3}"
      : `[ \\t]{${listIndent},${listIndent + 3}}`
    const closeRe = new RegExp(
      `^${quotePattern}${indentPattern}${mark[0]}{${mark.length},}[ \\t]*(?:\\r?\\n|$)`,
      "gm",
    )
    closeRe.lastIndex = openRe.lastIndex
    const close = closeRe.exec(text)
    const end = close ? closeRe.lastIndex : text.length
    out += text.slice(cursor, match.index)
    out += stash(text.slice(match.index, end))
    cursor = end
    openRe.lastIndex = end
    if (!close) break
  }
  return out + text.slice(cursor)
}

function protectInlineCode(text: string, stash: (match: string) => string): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    if (text[i] !== "`") {
      out += text[i]
      i++
      continue
    }
    let size = 1
    while (text[i + size] === "`") size++
    let j = i + size
    let end = -1
    const paragraphOffset = text.slice(j).search(/\r?\n(?:[ \t]*>[ \t]?)*[ \t]*\r?\n/)
    const limit = paragraphOffset === -1 ? text.length : j + paragraphOffset
    while (j < limit) {
      if (text[j] !== "`") {
        j++
        continue
      }
      let closeSize = 1
      while (text[j + closeSize] === "`") closeSize++
      if (closeSize === size) {
        end = j
        break
      }
      j += closeSize
    }
    if (end === -1) {
      out += text.slice(i, i + size)
      i += size
      continue
    }
    out += stash(text.slice(i, end + size))
    i = end + size
  }
  return out
}

function protectIndentedCode(text: string, stash: (match: string) => string): string {
  let out = ""
  let i = 0
  let previousBlank = true
  let inCode = false
  let listIndent: number | null = null
  while (i < text.length) {
    const newline = text.indexOf("\n", i)
    const end = newline === -1 ? text.length : newline + 1
    const line = text.slice(i, end)
    const content = line.replace(/\r?\n$/, "")
    const blank = /^[ \t]*$/.test(content)
    const indented = /^(?: {4}|\t)/.test(content)
    const quotedIndented = /^(?:>[ \t]?)+(?: {4}|\t)/.test(content)
    const listMatch = content.match(/^[ \t]{0,3}(?:[-+*]|\d+[.)])[ \t]+/)
    const leading = (content.match(/^[ \t]*/)?.[0] ?? "").replace(/\t/g, "    ").length
    const currentListIndent = listMatch
      ? listMatch[0].replace(/\t/g, "    ").length
      : listIndent
    const listContinuation =
      !listMatch &&
      currentListIndent !== null &&
      leading >= currentListIndent &&
      leading < currentListIndent + 4
    if (quotedIndented || indented && (inCode || previousBlank)) {
      if (listContinuation) {
        out += line
        inCode = false
      } else {
        out += stash(line)
        inCode = true
      }
    } else if (blank && inCode) {
      out += stash(line)
    } else {
      out += line
      inCode = false
    }
    if (listMatch) listIndent = currentListIndent
    else if (!blank && !listContinuation && !inCode) listIndent = null
    previousBlank = blank
    i = end
  }
  return out
}

function protectHtmlCode(text: string, stash: (match: string) => string): string {
  return text.replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, stash)
}

function protectSegments(text: string): { text: string; restore: (s: string) => string } {
  const slots: string[] = []
  const stash = (match: string) => {
    const i = slots.length
    slots.push(match)
    return `\u0000LNP${i}\u0000`
  }
  let out = protectFencedCode(text, stash)
  out = protectIndentedCode(out, stash)
  out = protectHtmlCode(out, stash)
  out = protectInlineCode(out, stash)
  return {
    text: out,
    restore: (s: string) => {
      let value = s
      for (let i = 0; i <= slots.length; i++) {
        const next = value.replace(/\u0000LNP(\d+)\u0000/g, (_, n) => slots[Number(n)] ?? "")
        if (next === value) return value
        value = next
      }
      return value
    },
  }
}

function stripDisplayOnlyTags(s: string): string {
  let out = ""
  let i = 0
  while (i < s.length) {
    const match = !isEscaped(s, i) ? s.slice(i).match(/^\\tag\*?\s*\{/) : null
    if (!match) {
      out += s[i]
      i++
      continue
    }
    let depth = 1
    let j = i + match[0].length
    while (j < s.length && depth > 0) {
      if (!isEscaped(s, j)) {
        if (s[j] === "{") depth++
        else if (s[j] === "}") depth--
      }
      j++
    }
    if (depth !== 0) {
      out += s[i]
      i++
      continue
    }
    out = out.replace(/[ \t]+$/, "")
    i = j
  }
  return out
}

function fixKatexEnvs(s: string): string {
  return stripDisplayOnlyTags(s)
    .replace(/\\begin\{align\*\}/g, "\\begin{aligned}")
    .replace(/\\end\{align\*\}/g, "\\end{aligned}")
    .replace(/\\begin\{align\}/g, "\\begin{aligned}")
    .replace(/\\end\{align\}/g, "\\end{aligned}")
    .replace(/\\begin\{alignat\*?\}\s*\{\d+\}/g, "\\begin{aligned}")
    .replace(/\\end\{alignat\*?\}/g, "\\end{aligned}")
    .replace(/\\begin\{alignedat\}\s*\{\d+\}/g, "\\begin{aligned}")
    .replace(/\\end\{alignedat\}/g, "\\end{aligned}")
    .replace(/\\begin\{flalign\*?\}/g, "\\begin{aligned}")
    .replace(/\\end\{flalign\*?\}/g, "\\end{aligned}")
    .replace(/\\begin\{eqnarray\*?\}/g, "\\begin{aligned}")
    .replace(/\\end\{eqnarray\*?\}/g, "\\end{aligned}")
    .replace(/\\begin\{gather\*?\}/g, "\\begin{gathered}")
    .replace(/\\end\{gather\*?\}/g, "\\end{gathered}")
    .replace(/\\begin\{multline\*?\}/g, "\\begin{aligned}")
    .replace(/\\end\{multline\*?\}/g, "\\end{aligned}")
    .replace(/\\begin\{split\}/g, "\\begin{aligned}")
    .replace(/\\end\{split\}/g, "\\end{aligned}")
    .replace(/\\begin\{equation\*\}/g, "")
    .replace(/\\end\{equation\*\}/g, "")
    .replace(/\\begin\{equation\}/g, "")
    .replace(/\\end\{equation\}/g, "")
    .replace(/\s*\\(?:notag|nonumber)\b/g, "")
}

function collapseToSingleLine(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\s*\n\s*/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

function stripLatexComments(s: string): string {
  return s
    .split(/\r?\n/)
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "%" && !isEscaped(line, i)) return line.slice(0, i)
      }
      return line
    })
    .join("\n")
}

function isDisplaySized(body: string): boolean {
  if (/\r?\n/.test(body)) return true
  const s = body.trim()
  if (/\\textstyle\{\}/.test(s)) return false
  if (/\\begin\{/.test(s)) return true
  if (/\\displaystyle\b/.test(s)) return true
  if (s.length > 80) return true
  if (/\\(sum|int|prod|frac|left|right|mathcal|mathbb|mathrm)\b/.test(s) && s.length > 40) {
    return true
  }
  return false
}

function stripNestedMathDelimiters(value: string): string {
  return value
    .replace(/\\\(([\s\S]*?)\\\)/g, "$1")
    .replace(/\\\[([\s\S]*?)\\\]/g, "$1")
    .replace(/(?<!\\)\$\$([\s\S]*?)(?<!\\)\$\$/g, "$1")
    .replace(/(?<!\\)\$([^$\r\n]+?)(?<!\\)\$/g, "$1")
}

function toInline(body: string, displaystyle: boolean, forceDisplay = false): string {
  let inner = fixKatexEnvs(collapseToSingleLine(stripLatexComments(body)))
  if (!inner) return ""
  if (inner.startsWith("\\(") && inner.endsWith("\\)")) inner = inner.slice(2, -2)
  else if (inner.startsWith("\\[") && inner.endsWith("\\]")) inner = inner.slice(2, -2)
  else if (inner.startsWith("$$") && inner.endsWith("$$")) inner = inner.slice(2, -2)
  else if (inner.startsWith("$") && inner.endsWith("$")) inner = inner.slice(1, -1)
  inner = stripNestedMathDelimiters(inner).trim()
  inner = fixKatexEnvs(collapseToSingleLine(stripLatexComments(inner)))
  if (!inner) return ""
  if (displaystyle && (forceDisplay || isDisplaySized(body)) && !/\\displaystyle\b/.test(inner)) {
    inner = `\\displaystyle ${inner}`
  }
  return `\\(${inner}\\)`
}

function toDisplayBlock(body: string): string {
  const inline = toInline(body, false)
  if (!inline) return ""
  return `$$\n${inline.slice(2, -2)}\n$$`
}

function canUseDisplayBlock(text: string, start: number, end: number): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1
  const lineEnd = text.indexOf("\n", end)
  const prefix = text.slice(lineStart, start)
  const suffix = text.slice(end, lineEnd === -1 ? text.length : lineEnd)
  return prefix === "" && (suffix === "" || suffix === "\r")
}

function stripQuoteMarkers(body: string, text: string, start: number): string {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1
  const prefix = text.slice(lineStart, start)
  const quotePrefix = prefix.match(
    /^(?:[ \t]{0,3}(?:[-+*]|\d+[.)])[ \t]+)?[ \t]*(?:>[ \t]?)+/,
  )
  if (!quotePrefix) return body
  const depth = (quotePrefix[0].match(/>/g) ?? []).length
  return body
    .split(/(\r?\n)/)
    .map((line, index) => {
      if (index % 2 === 1 || index === 0) return line
      let value = line
      for (let level = 0; level < depth; level++) {
        const marker = value.match(/^[ \t]*>[ \t]?/)
        if (!marker) return line
        value = value.slice(marker[0].length)
      }
      return value
    })
    .join("")
}

function toContextualInline(
  body: string,
  text: string,
  start: number,
  displaystyle: boolean,
  forceDisplay = false,
): string {
  return toInline(stripQuoteMarkers(body, text, start), displaystyle, forceDisplay)
}

function preserveInlineOrigin(formula: string): string {
  if (!formula) return ""
  return `\\(\\textstyle{}${formula.slice(2)}`
}

function looksLikeMath(inner: string): boolean {
  const s = inner.trim()
  if (!s || s.length > 1200) return false
  if (/[\u4e00-\u9fff]/.test(s) && !/[\\^_{}]/.test(s)) return false
  if (/[\\^_{}]/.test(s)) return true
  if (/^[\p{L}\p{N}]+$/u.test(s)) return true
  if (/[=<>≤≥≈≠±×÷⋅+\-*/]/.test(s) && /[\p{L}\p{N}]/u.test(s)) return true
  if (/^[\p{L}\p{N}.,\s()[\]]+$/u.test(s) && /[()[\],.]/.test(s)) return true
  return false
}

function looksLikeDisplayMath(inner: string): boolean {
  const s = inner.trim()
  if (!s || s.length > 12000) return false
  if (looksLikeMath(s)) return true
  if (/[\u4e00-\u9fff]/.test(s) && !/[\\^_{}]/.test(s)) return false
  if (/[\\^_{}=<>≤≥≈≠±×÷⋅+\-*/]/.test(s)) return true
  return /^\p{L}(?:\s+\p{L})+$/u.test(s)
}

function looksLikeCurrencyOrNoise(before: string, inner: string, after: string): boolean {
  const s = inner.trim()
  if (/^\d{1,3}(?:,\d{3})*(?:\.\d+)?$/.test(s)) return true
  if (/^\d+(?:\.\d+)?\s*(?:USD|usd|k|K|M|m)?$/.test(s)) return true
  if (/^[A-Z][A-Z0-9_]+$/.test(s)) return true
  if (/\w$/.test(before) || /^\w/.test(after)) return true
  if (!s) return true
  return false
}

/** Strip HTML display wrappers we may have added earlier; keep inner $$ body. */
function unwrapHtmlDisplay(text: string): string {
  return text.replace(
    /<div\b[^>]*>\s*\$\$([\s\S]*?)\$\$\s*<\/div>/gi,
    (_m, inner: string) => `$$${inner}$$`,
  )
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++
  return slashes % 2 === 1
}

function findUnescaped(text: string, token: string, start: number): number {
  const barrier = text.indexOf("\u0000", start)
  let index = text.indexOf(token, start)
  while (index !== -1) {
    if (barrier !== -1 && barrier < index) return -1
    if (!isEscaped(text, index)) return index
    index = text.indexOf(token, index + token.length)
  }
  return -1
}

function replaceAllDelimited(
  text: string,
  open: string,
  close: string,
  format: (body: string, start: number, end: number, independent: boolean) => string,
): string {
  let out = ""
  let i = 0
  const oLen = open.length
  const cLen = close.length
  let blockedUntil = -1
  while (i < text.length) {
    if (text.startsWith(open, i) && !isEscaped(text, i)) {
      const start = i + oLen
      const end = findUnescaped(text, close, start)
      if (end === -1) {
        out += text[i]
        i++
        continue
      }
      const inner = text.slice(start, end)
      const nested = findUnescaped(text, open, start)
      const core = inner.trim()
      if (
        (nested !== -1 && nested < end) ||
        /\r?\n[ \t]*\r?\n/.test(core) ||
        (/\r?\n/.test(inner) && !looksLikeDisplayMath(inner))
      ) {
        blockedUntil = Math.max(blockedUntil, end + cLen)
        out += text[i]
        i++
        continue
      }
      out += format(inner, i, end + cLen, i >= blockedUntil)
      i = end + cLen
      continue
    }
    out += text[i]
    i++
  }
  return out
}

function normalizeInlineDollars(
  text: string,
  mode: Mode,
  emit: (body: string, display: boolean, start: number, end: number) => string,
): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    if (text[i] !== "$") {
      out += text[i]
      i++
      continue
    }
    if (isEscaped(text, i)) {
      out += "$"
      i++
      continue
    }
    // $$...$$ — multi-line or single-line display
    if (text[i + 1] === "$") {
      const start = i + 2
      const end = findUnescaped(text, "$$", start)
      if (end === -1) {
        out += "\\$\\$"
        i += 2
        continue
      }
      const inner = text.slice(start, end)
      if (!looksLikeDisplayMath(inner)) {
        out += "\\$\\$"
        i += 2
        continue
      }
      out += emit(inner, true, i, end + 2)
      i = end + 2
      continue
    }

    // Inline dollar math cannot safely span Markdown blocks.
    let j = i + 1
    let inner = ""
    let found = false
    while (j < text.length) {
      if (text[j] === "\n" || text[j] === "\r") break
      if (text[j] === "\u0000") break
      if (text[j] === "\\" && j + 1 < text.length) {
        inner += text[j] + text[j + 1]
        j += 2
        continue
      }
      if (text[j] === "$" && text[j + 1] === "$") break
      if (text[j] === "$") {
        found = true
        break
      }
      inner += text[j]
      j++
      if (inner.length > 1200) break
    }

    if (!found) {
      out += "$"
      i++
      continue
    }

    const before = i > 0 ? text[i - 1]! : ""
    const after = j + 1 < text.length ? text[j + 1]! : ""
    let convert = true
    if (mode === "safe") {
      if (looksLikeCurrencyOrNoise(before, inner, after) || !looksLikeMath(inner)) convert = false
    } else if (looksLikeCurrencyOrNoise(before, inner, after) && !looksLikeMath(inner)) {
      convert = false
    }

    if (!convert) {
      out += "$"
      i++
      continue
    }
    out += emit(inner, false, i, j + 1)
    i = j + 1
  }
  return out
}

function normalizeBareEnvs(
  text: string,
  format: (body: string, start: number, end: number) => string,
): string {
  const beginRe =
    /\\begin\{(equation\*?|align\*?|alignat\*?|aligned|alignedat|flalign\*?|eqnarray\*?|split|gather\*?|gathered|multline\*?|pmatrix|bmatrix|vmatrix|Vmatrix|matrix|cases|array)\}/g
  let out = ""
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = beginRe.exec(text))) {
    const name = match[1]
    if (!name) continue
    const beginToken = `\\begin{${name}}`
    const endToken = `\\end{${name}}`
    const bodyStart = beginRe.lastIndex
    let depth = 1
    let search = beginRe.lastIndex
    let end = -1
    while (depth > 0) {
      const nextBegin = text.indexOf(beginToken, search)
      const nextEnd = text.indexOf(endToken, search)
      if (nextEnd === -1) break
      const barrier = text.indexOf("\u0000", search)
      const boundary = nextBegin !== -1 && nextBegin < nextEnd ? nextBegin : nextEnd
      if (barrier !== -1 && barrier < boundary) break
      if (nextBegin !== -1 && nextBegin < nextEnd) {
        depth++
        search = nextBegin + beginToken.length
        continue
      }
      depth--
      end = nextEnd + endToken.length
      search = end
    }
    if (depth !== 0 || end === -1) continue
    const body = text.slice(bodyStart, end - endToken.length).trim()
    if (/\r?\n[ \t]*\r?\n/.test(body)) continue
    out += text.slice(cursor, match.index)
    out += format(text.slice(match.index, end), match.index, end)
    cursor = end
    beginRe.lastIndex = end
  }
  return out + text.slice(cursor)
}

export function normalizeLatexMarkdown(
  text: string,
  cfg: Required<LatexNormalizeConfig> = DEFAULTS,
): string {
  if (!cfg.enabled || !text) return text
  if (!text.includes("$") && !text.includes("\\")) return text

  const { text: protectedText, restore } = protectSegments(text)
  let out = protectedText
  const mathSlots: string[] = []
  const stashMath = (formula: string) => {
    if (!formula) return ""
    const index = mathSlots.length
    mathSlots.push(formula)
    return `\u0000LNM${index}\u0000`
  }
  const restoreMath = (value: string) =>
    value.replace(/\u0000LNM(\d+)\u0000/g, (_, n) => mathSlots[Number(n)] ?? "")

  // If previous version left <div>$$...$$</div>, flatten to $$ first
  out = unwrapHtmlDisplay(out)

  // \[ ... \]
  const bracketSource = out
  out = replaceAllDelimited(bracketSource, "\\[", "\\]", (body, start, end, independent) =>
    stashMath(
      cfg.layout === "block" &&
        independent &&
        canUseDisplayBlock(bracketSource, start, end)
        ? toDisplayBlock(body)
        : toContextualInline(body, bracketSource, start, cfg.displaystyle, true),
    ),
  )

  // Re-normalize and protect all \( ... \) before later passes.
  const parenSource = out
  out = replaceAllDelimited(parenSource, "\\(", "\\)", (body, start, end, independent) =>
    stashMath(
      cfg.layout === "block" &&
        independent &&
        isDisplaySized(body) &&
        canUseDisplayBlock(parenSource, start, end)
        ? toDisplayBlock(body)
        : toContextualInline(body, parenSource, start, cfg.displaystyle),
    ),
  )

  // $$ and $
  const dollarSource = out
  out = normalizeInlineDollars(dollarSource, cfg.mode, (body, display, start, end) => {
    if (display && cfg.layout === "block" && canUseDisplayBlock(dollarSource, start, end)) {
      return stashMath(toDisplayBlock(body))
    }
    const contextualBody = stripQuoteMarkers(body, dollarSource, start)
    const formula = toInline(contextualBody, cfg.displaystyle, display)
    return stashMath(
      cfg.layout === "block" && !display && isDisplaySized(contextualBody)
        ? preserveInlineOrigin(formula)
        : formula,
    )
  })

  // bare environments
  const envSource = out
  out = normalizeBareEnvs(envSource, (body, start, end) =>
    stashMath(
      cfg.layout === "block" && canUseDisplayBlock(envSource, start, end)
        ? toDisplayBlock(body)
        : toContextualInline(body, envSource, start, cfg.displaystyle, true),
    ),
  )

  out = restoreMath(out)
  return restore(out)
}

function partText(part: { type?: string; text?: string }): string | null {
  if (!part || part.type !== "text" || typeof part.text !== "string") return null
  return part.text
}

export const LatexNormalizePlugin: Plugin = async ({ client }) => {
  const cfg = loadConfig()

  await client.app
    .log({
      body: {
        service: "latex-normalize",
        level: "info",
        message: cfg.enabled
          ? `enabled mode=${cfg.mode} layout=${cfg.layout} displaystyle=${cfg.displaystyle}`
          : "disabled via config",
      },
    })
    .catch(() => {})

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
