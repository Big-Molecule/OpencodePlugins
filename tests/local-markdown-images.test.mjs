import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  inlineLocalMarkdownImages,
  restoreLocalMarkdownImageSources,
} from "../plugins/local-markdown-images.ts"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "opencode-local-image-"))
  mkdirSync(join(root, "figures"))
  writeFileSync(join(root, "figures", "plot.png"), Buffer.from("89504e470d0a1a0a", "hex"))
  return root
}

test("inlines a workspace-relative image and restores it for model history", () => {
  const root = fixture()
  const source = "![Plot](figures/plot.png)"
  const display = inlineLocalMarkdownImages(source, root)

  assert.match(display, /^!\[Plot\]\(data:image\/png;base64,/)
  assert.match(display, /opencode-local-image:/)
  assert.equal(restoreLocalMarkdownImageSources(display), source)
})

test("supports encoded paths and file URLs within the workspace", () => {
  const root = fixture()
  const encoded = inlineLocalMarkdownImages("![Plot](figures%2Fplot.png)", root)
  assert.match(encoded, /data:image\/png;base64,/)

  const url = new URL(`file:///${join(root, "figures", "plot.png").replaceAll("\\", "/")}`).href
  assert.match(inlineLocalMarkdownImages(`![Plot](${url})`, root), /data:image\/png;base64,/)
})

test("does not read remote, unsupported, missing, or out-of-workspace files", () => {
  const root = fixture()
  const cases = [
    "![Remote](https://example.com/image.png)",
    "![Missing](figures/missing.png)",
    "![Text](notes.txt)",
    "![Outside](../outside.png)",
  ]
  for (const source of cases) assert.equal(inlineLocalMarkdownImages(source, root), source)
})

test("is idempotent after an image has been inlined", () => {
  const root = fixture()
  const once = inlineLocalMarkdownImages("![Plot](figures/plot.png)", root)
  assert.equal(inlineLocalMarkdownImages(once, root), once)
})
