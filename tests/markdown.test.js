import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../markdown.js";
import { mime } from "../core.js";

test("markdown renders common blocks and escapes repository HTML", () => {
  const { html, title } = renderMarkdown(
    [
      "# Hello *world*",
      "",
      "Paragraph with **bold**, _em_, `code`, and ~~gone~~.",
      "",
      "![diagram](./pic.svg)",
      "",
      "```js",
      "const x = '<script>alert(1)</script>';",
      "```",
      "",
      "> quoted **text**",
      "",
      "- one",
      "- two",
      "  - nested",
      "",
      "1. first",
      "2. second",
      "",
      "- [x] done",
      "- [ ] todo",
      "",
      "| a | b |",
      "| :- | -: |",
      "| 1 | 2 |",
      "",
      "---",
      "",
      "[local](./other.md) and [web](https://example.com) and <https://auto.test>",
      "",
      '<img src=x onerror="alert(1)">',
      "[bad](javascript:alert(1))",
    ].join("\n"),
  );
  assert.equal(title, "Hello *world*");
  assert.match(html, /<h1 id="hello-world">Hello <em>world<\/em><\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>em<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<del>gone<\/del>/);
  assert.match(html, /<img src="\.\/pic\.svg" alt="diagram">/);
  assert.match(
    html,
    /<pre><code class="language-js">const x = &#39;&lt;script&gt;/,
  );
  assert.match(html, /<blockquote>/);
  assert.match(
    html,
    /<ul><li>one<\/li><li>two\s*<ul><li>nested<\/li><\/ul><\/li><\/ul>/,
  );
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<input type="checkbox" disabled checked>/);
  assert.match(html, /<table><thead><tr><th style="text-align:left">a<\/th>/);
  assert.match(html, /<td style="text-align:right">2<\/td>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<a href="\.\/other.md">local<\/a>/);
  assert.match(html, /<a href="https:\/\/example.com">web<\/a>/);
  assert.match(html, /<a href="https:\/\/auto.test">https:\/\/auto.test<\/a>/);
  assert.ok(!html.includes("<img src=x"), "raw HTML must be escaped");
  assert.ok(
    !html.includes('href="javascript:'),
    "javascript links must be dropped",
  );
  assert.ok(!/<script/i.test(html));
});

test("markdown handles setext headings, tilde fences, and hard breaks", () => {
  const { html } = renderMarkdown(
    "Title\n=====\n\n~~~~\n<b>raw</b>\n~~~~\n\nline one  \nline two",
  );
  assert.match(html, /<h1 id="title">Title<\/h1>/);
  assert.match(html, /<pre><code>&lt;b&gt;raw&lt;\/b&gt;/);
  assert.ok(!html.includes("<b>raw</b>"));
  assert.match(html, /line one<br>\nline two/);
});

test("markdown files map to the markdown MIME type", () => {
  assert.equal(mime("docs/README.md"), "text/markdown");
  assert.equal(mime("NOTES.MARKDOWN"), "text/markdown");
  assert.equal(mime("main.mjs"), "text/javascript");
});
