import assert from "node:assert/strict"
import test from "node:test"

import { normalizeLatexMarkdown as normalize } from "../plugins/latex-normalize.ts"

const BLOCK_CONFIG = {
  enabled: true,
  mode: "safe",
  layout: "block",
  displaystyle: true,
  transformHistory: true,
}

test("normalizes every supported delimiter to frontend-safe inline math", () => {
  assert.equal(normalize(String.raw`\(x^2\)`), String.raw`\(x^2\)`)
  assert.equal(normalize(String.raw`$x$`), String.raw`\(x\)`)
  assert.equal(normalize(String.raw`$1+1$`), String.raw`\(1+1\)`)
  assert.equal(normalize(String.raw`$α+β$`), String.raw`\(α+β\)`)
  assert.equal(normalize(String.raw`$$x^2$$`), String.raw`\(\displaystyle x^2\)`)
  assert.equal(normalize(String.raw`\[x^2\]`), String.raw`\(\displaystyle x^2\)`)
  assert.equal(
    normalize(String.raw`$$
x^2+y^2=z^2
$$`),
    String.raw`\(\displaystyle x^2+y^2=z^2\)`,
  )
  assert.equal(
    normalize(String.raw`\(
x^2+y^2=z^2
\)`),
    String.raw`\(\displaystyle x^2+y^2=z^2\)`,
  )
})

test("emits strict centered blocks only for display-origin formulas", () => {
  const xBlock = ["$$", "x^2", "$$"].join("\n")
  assert.equal(normalize(String.raw`$$x^2$$`, BLOCK_CONFIG), xBlock)
  assert.equal(normalize(String.raw`\[x^2\]`, BLOCK_CONFIG), xBlock)
  assert.equal(normalize(String.raw`$x^2$`, BLOCK_CONFIG), String.raw`\(x^2\)`)
  assert.equal(normalize(String.raw`\(x^2\)`, BLOCK_CONFIG), String.raw`\(x^2\)`)
  assert.equal(
    normalize(String.raw`\(
x^2+y^2=z^2
\)`, BLOCK_CONFIG),
    ["$$", "x^2+y^2=z^2", "$$"].join("\n"),
  )
  assert.equal(
    normalize(String.raw`\begin{align}a&=b\\c&=d\end{align}`, BLOCK_CONFIG),
    ["$$", String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`, "$$"].join("\n"),
  )
})

test("falls back to inline math inside prose, lists, and block quotes", () => {
  assert.equal(
    normalize(String.raw`before $$x^2$$ after`, BLOCK_CONFIG),
    String.raw`before \(\displaystyle x^2\) after`,
  )
  assert.equal(
    normalize(["- $$", "  x^2", "  $$"].join("\n"), BLOCK_CONFIG),
    String.raw`- \(\displaystyle x^2\)`,
  )
  assert.equal(
    normalize(["> $$", "> x^2", "> $$"].join("\n"), BLOCK_CONFIG),
    String.raw`> \(\displaystyle x^2\)`,
  )
  assert.equal(
    normalize(String.raw`> \[x^2\]`, BLOCK_CONFIG),
    String.raw`> \(\displaystyle x^2\)`,
  )
  assert.equal(
    normalize(["- > $$", "  > x^2", "  > $$"].join("\n"), BLOCK_CONFIG),
    String.raw`- > \(\displaystyle x^2\)`,
  )
})

test("keeps block layout strict and idempotent for LF and CRLF input", () => {
  const expected = ["$$", "x^2", "$$"].join("\n")
  for (const source of [String.raw`\[x^2\]`, "\\[x^2\\]\r\n"]) {
    const once = normalize(source, BLOCK_CONFIG)
    assert.equal(once, expected + (source.endsWith("\r\n") ? "\r\n" : ""))
    assert.equal(normalize(once, BLOCK_CONFIG), once)
  }

  const fallback = normalize(String.raw`- $$x^2$$`, BLOCK_CONFIG)
  assert.equal(normalize(fallback, BLOCK_CONFIG), fallback)

  for (const source of [String.raw`$\displaystyle x$`, `$${"x+".repeat(50)}x$`]) {
    const once = normalize(source, BLOCK_CONFIG)
    assert.doesNotMatch(once, /^\$\$/m)
    assert.match(once, /\\textstyle\{\}/)
    assert.equal(normalize(once, BLOCK_CONFIG), once)
  }
})

test("does not emit blocks inside rejected outer slash delimiters", () => {
  const source = String.raw`\[
outer
\[
x^2
\]`
  const result = normalize(source, BLOCK_CONFIG)
  assert.doesNotMatch(result, /^\$\$/m)
  assert.match(result, /\\\(\\displaystyle x\^2\\\)/)
})

test("does not reinterpret currency, prose, escaped dollars, or code", () => {
  assert.equal(normalize("Price is $12.99."), "Price is $12.99.")
  assert.equal(normalize("Prices are $12.99 and $13.99."), "Prices are $12.99 and $13.99.")
  assert.equal(normalize(String.raw`$not math prose$`), String.raw`$not math prose$`)
  assert.equal(normalize(String.raw`\$a+b$`), String.raw`\$a+b$`)
  assert.equal(normalize(String.raw`\$a+b\$`), String.raw`\$a+b\$`)

  const code = ["`$x^2$`", "```tex", "$x^2$", "```"].join("\n")
  assert.equal(normalize(code), code)

  const longFence = ["````text", "```", "$$", "x^2", "$$", "````"].join("\n")
  assert.equal(normalize(longFence), longFence)

  const quotedFence = ["> ~~~tex", "> $$", "> x^2", "> $$", "> ~~~"].join("\n")
  assert.equal(normalize(quotedFence, BLOCK_CONFIG), quotedFence)

  const listFence = ["- ~~~tex", "  $$", "  x^2", "  $$", "  ~~~"].join("\n")
  assert.equal(normalize(listFence, BLOCK_CONFIG), listFence)

  const quotedListFence = ["> - ~~~tex", ">   $x^2$", ">   ~~~"].join("\n")
  assert.equal(normalize(quotedListFence, BLOCK_CONFIG), quotedListFence)

  const unclosedFence = ["~~~tex", "$$", "x^2", "$$"].join("\n")
  assert.equal(normalize(unclosedFence), unclosedFence)

  const inlineTildes = ["before ~~~ after", "", "$$", "x^2", "$$", "", "more ~~~"].join("\n")
  assert.match(normalize(inlineTildes), /\\\(\\displaystyle x\^2\\\)/)

  const invalidFence = ["```bad`", "", "$$", "x^2", "$$"].join("\n")
  assert.match(normalize(invalidFence), /\\\(\\displaystyle x\^2\\\)/)

  const indented = "    $x^2$"
  assert.equal(normalize(indented), indented)

  const htmlCode = "<pre><code>$x^2$</code></pre>"
  assert.equal(normalize(htmlCode), htmlCode)

  const nestedHtmlCode = ["<pre>", "```tex", "$x^2$", "```", "</pre>"].join("\n")
  assert.equal(normalize(nestedHtmlCode), nestedHtmlCode)

  const multilineCodeSpan = ["``first", "$x^2$", "last``"].join("\n")
  assert.equal(normalize(multilineCodeSpan), multilineCodeSpan)

  const falseMultilineSpan = ["`unclosed", "", "$$", "x^2", "$$", "", "`later"].join("\n")
  assert.match(normalize(falseMultilineSpan), /\\\(\\displaystyle x\^2\\\)/)

  const quotedFalseSpan = ["> `unclosed", ">", "> $$", "> x^2", "> $$", ">", "> `later"].join("\n")
  assert.doesNotMatch(normalize(quotedFalseSpan), /^> \$\$/m)

  assert.equal(normalize("- item\n    $x$"), "- item\n    \\(x\\)")
  assert.equal(
    normalize(["10. item", "", "    $$", "    x^2", "    $$"].join("\n"), BLOCK_CONFIG),
    "10. item\n\n    \\(\\displaystyle x^2\\)",
  )
  assert.equal(normalize(">     $x$"), ">     $x$")
})

test("keeps shell-style uppercase variables unchanged in safe mode", () => {
  assert.equal(normalize(String.raw`Use $HOME$ here.`), String.raw`Use $HOME$ here.`)
})

test("does not let currency or protected code steal a later inline formula", () => {
  assert.equal(
    normalize(String.raw`Price is $5 and equation $x^2$.`),
    String.raw`Price is $5 and equation \(x^2\).`,
  )
  assert.equal(normalize("$x `code` y$ then $z^2$"), "$x `code` y$ then \\(z^2\\)")
})

test("does not pair unmatched slash delimiters across later formulas", () => {
  const paren = String.raw`First \( is unclosed

Second \(x^2\)`
  const normalizedParen = normalize(paren)
  assert.equal(normalizedParen, paren)
  assert.doesNotMatch(normalizedParen, /\\displaystyle First/)

  const bracket = String.raw`First \[ is unclosed

Second \[x^2\]`
  const normalizedBracket = normalize(bracket)
  assert.equal(
    normalizedBracket,
    String.raw`First \[ is unclosed

Second \(\displaystyle x^2\)`,
  )
  assert.doesNotMatch(normalizedBracket, /\\displaystyle First/)
})

test("removes balanced nested math delimiters as a unit", () => {
  assert.equal(normalize(String.raw`\[$x$+y\]`), String.raw`\(\displaystyle x+y\)`)
  assert.equal(normalize(String.raw`\[\(x\)+y\]`), String.raw`\(\displaystyle x+y\)`)
})

test("does not wrap environments that were already inside math", () => {
  const aligned = String.raw`\(\begin{aligned}a&=b\\c&=d\end{aligned}\)`
  assert.equal(
    normalize(aligned),
    String.raw`\(\displaystyle \begin{aligned}a&=b\\c&=d\end{aligned}\)`,
  )

  const alignBlock = String.raw`$$
\begin{align}
a &= b\\
c &= d
\end{align}
$$`
  assert.equal(
    normalize(alignBlock),
    String.raw`\(\displaystyle \begin{aligned} a &= b\\ c &= d \end{aligned}\)`,
  )

  const casesBlock = String.raw`\[
\begin{cases}
x, & x\ge0\\
-x, & x<0
\end{cases}
\]`
  assert.equal(
    normalize(casesBlock),
    String.raw`\(\displaystyle \begin{cases} x, & x\ge0\\ -x, & x<0 \end{cases}\)`,
  )

  const bareCases = String.raw`\begin{cases}x,&x\ge0\\-x,&x<0\end{cases}`
  assert.equal(
    normalize(bareCases),
    String.raw`\(\displaystyle \begin{cases}x,&x\ge0\\-x,&x<0\end{cases}\)`,
  )
})

test("normalization is idempotent", () => {
  const source = String.raw`$$
\begin{align}
a &= b\\
c &= d
\end{align}
$$`
  const once = normalize(source)
  assert.equal(normalize(once), once)
})

test("repairs malformed display variants without leaving active double dollars", () => {
  const variants = [
    String.raw`$$x^2$$`,
    String.raw`$$
x^2$$`,
    String.raw`  $$
x^2
$$`,
    String.raw`$$

\int_0^1x^2\,dx=\frac13

$$`,
  ]

  for (const source of variants) {
    const result = normalize(source)
    assert.doesNotMatch(result, /(?<!\\)\$\$/)
    assert.match(result, /\\\(\\displaystyle /)
  }
})

test("accepts explicit display formulas that are long or use implicit multiplication", () => {
  assert.equal(normalize(String.raw`$$x y$$`), String.raw`\(\displaystyle x y\)`)
  const long = `$$${"x+".repeat(700)}x$$`
  const result = normalize(long)
  assert.equal(result, `\\(\\displaystyle ${"x+".repeat(700)}x\\)`)
})

test("neutralizes unmatched display delimiters and prevents cross-paragraph pairing", () => {
  assert.equal(
    normalize(String.raw`before

$$
not closed`),
    String.raw`before

\$\$
not closed`,
  )

  assert.equal(
    normalize(String.raw`$$
plain prose

$$
x^2
$$`),
    String.raw`\$\$
plain prose

\(\displaystyle x^2\)`,
  )
})

test("repairs consecutive malformed display blocks without consuming labels", () => {
  const source = String.raw`N12, opener has a space:

$$ 
x^2
$$

N13, body starts on the opener line:

$$x^2
$$

N14, closer is on the body line:

$$
x^2$$

N15, blank lines inside:

$$

\int_0^1x^2\,dx=\frac13

$$

N16, indented opener:

  $$
x^2
$$`

  const result = normalize(source)
  for (const label of ["N12", "N13", "N14", "N15", "N16"]) assert.match(result, new RegExp(label))
  assert.doesNotMatch(result, /(?<!\\)\$\$/)
  assert.doesNotMatch(result, /\\\([^)]*N1[2-6]/)
  assert.equal(normalize(result), result)
})

test("converts display-only environments to inline-safe KaTeX environments", () => {
  assert.equal(
    normalize(String.raw`\begin{gather}a=b\\c=d\end{gather}`),
    String.raw`\(\displaystyle \begin{gathered}a=b\\c=d\end{gathered}\)`,
  )
  assert.equal(
    normalize(String.raw`\begin{multline}a+b\\=c\end{multline}`),
    String.raw`\(\displaystyle \begin{aligned}a+b\\=c\end{aligned}\)`,
  )
  assert.equal(
    normalize(String.raw`\begin{alignat*}{2}a&=b&c&=d\end{alignat*}`),
    String.raw`\(\displaystyle \begin{aligned}a&=b&c&=d\end{aligned}\)`,
  )
  assert.equal(
    normalize(String.raw`\begin{flalign*}a&=b\end{flalign*}`),
    String.raw`\(\displaystyle \begin{aligned}a&=b\end{aligned}\)`,
  )
})

test("keeps nested same-name environments intact", () => {
  const source = String.raw`\begin{matrix}1&\begin{matrix}2\\3\end{matrix}\\4&5\end{matrix}`
  assert.equal(
    normalize(source),
    String.raw`\(\displaystyle \begin{matrix}1&\begin{matrix}2\\3\end{matrix}\\4&5\end{matrix}\)`,
  )
})

test("does not pair bare environments across prose or protected code", () => {
  const prose = String.raw`\begin{matrix}
plain prose

another paragraph
\end{matrix}`
  assert.equal(normalize(prose), prose)

  const code = "\\begin{matrix} before `code` after \\end{matrix}"
  assert.equal(normalize(code), code)
})

test("removes TeX comments before collapsing formulas", () => {
  assert.equal(
    normalize(String.raw`$$
x % explanatory comment
+ y
$$`),
    String.raw`\(\displaystyle x + y\)`,
  )
  assert.equal(normalize(String.raw`$x\%+y$`), String.raw`\(x\%+y\)`)
})

test("removes display-only tags from inline-safe output", () => {
  assert.equal(
    normalize(String.raw`$$\begin{align}x&=1\tag{1}\end{align}$$`),
    String.raw`\(\displaystyle \begin{aligned}x&=1\end{aligned}\)`,
  )
  assert.equal(
    normalize(String.raw`$$\begin{align}x&=1\nonumber\end{align}$$`),
    String.raw`\(\displaystyle \begin{aligned}x&=1\end{aligned}\)`,
  )
  assert.equal(
    normalize(String.raw`$$\begin{align}x&=1\tag{\text{A}}\end{align}$$`),
    String.raw`\(\displaystyle \begin{aligned}x&=1\end{aligned}\)`,
  )
})

test("preserves Markdown hard breaks outside formulas", () => {
  const source = "first line  \nsecond line\n\n$x^2$"
  assert.equal(normalize(source), "first line  \nsecond line\n\n\\(x^2\\)")
})
