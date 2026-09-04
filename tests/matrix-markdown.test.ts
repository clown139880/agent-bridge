import assert from "node:assert/strict";
import test from "node:test";
import { MsgType } from "matrix-js-sdk";
import {
  markdownMessageContent,
  markdownToMatrixHtml,
} from "../apps/control-plane/src/matrix.js";

test("Matrix messages retain Markdown as fallback and include formatted HTML", () => {
  const markdown = "## Result\n\n**Done** with `code`.";
  const content = markdownMessageContent(MsgType.Text, markdown);

  assert.equal(content.body, markdown);
  assert.equal(content.format, "org.matrix.custom.html");
  assert.match(content.formatted_body, /<h2>Result<\/h2>/);
  assert.match(content.formatted_body, /<strong>Done<\/strong>/);
  assert.match(content.formatted_body, /<code>code<\/code>/);
});

test("Markdown rendering supports fenced code and safe links", () => {
  const html = markdownToMatrixHtml([
    "```ts",
    "const answer = 42;",
    "```",
    "",
    "[docs](https://example.com/docs)",
  ].join("\n"));

  assert.match(html, /<pre><code class="language-ts">/);
  assert.match(html, /<a href="https:\/\/example.com\/docs">docs<\/a>/);
});

test("Markdown rendering strips unsafe HTML and link schemes", () => {
  const html = markdownToMatrixHtml([
    "<script>alert('xss')</script>",
    "[unsafe](javascript:alert('xss'))",
  ].join("\n\n"));

  assert.doesNotMatch(html, /<script|javascript:/i);
});
