import React from "react";
import Markdown, { type Components } from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import { findLinks, remarkLinkify } from "./linkify";

// Raw HTML in agent output stays text (react-markdown escapes it); links leave the app.
// cjk-friendly lets "**结论。**后文" emphasize, which CommonMark refuses next to CJK punctuation.
// linkify links the addresses GFM misses (inline code, next to CJK text, bare hosts).
const remarkPlugins = [remarkGfm, remarkCjkFriendly, remarkLinkify];
const markdownComponents: Components = { a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> };
export function MessageText({ text, markdown }: { text: string; markdown: boolean }) {
  return markdown ? <div className="message-text markdown"><Markdown remarkPlugins={remarkPlugins} components={markdownComponents}>{text}</Markdown></div>
    : <div className="message-text">{linkPlain(text)}</div>;
}

/** Text shown as typed (user and room messages) still gets its addresses linked. */
function linkPlain(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const { start, end, href } of findLinks(text)) {
    parts.push(text.slice(at, start), <a key={start} className="message-link" href={href} target="_blank" rel="noopener noreferrer">{text.slice(start, end)}</a>);
    at = end;
  }
  parts.push(text.slice(at));
  return parts;
}
