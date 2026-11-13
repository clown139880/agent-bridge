import React from "react";
import Markdown, { type Components } from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import { remarkLinkify } from "./linkify";

// Raw HTML in agent output stays text (react-markdown escapes it); links leave the app.
// cjk-friendly lets "**结论。**后文" emphasize, which CommonMark refuses next to CJK punctuation.
// linkify links the addresses GFM misses (inline code, next to CJK text, bare hosts).
const remarkPlugins = [remarkGfm, remarkCjkFriendly, remarkLinkify];
const markdownComponents: Components = { a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> };
export function MessageText({ text, markdown }: { text: string; markdown: boolean }) {
  return markdown ? <div className="message-text markdown"><Markdown remarkPlugins={remarkPlugins} components={markdownComponents}>{text}</Markdown></div>
    : <div className="message-text">{text}</div>;
}
