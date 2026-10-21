import React from "react";
import Markdown, { type Components } from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";

// Raw HTML in agent output stays text (react-markdown escapes it); links leave the app.
// cjk-friendly lets "**结论。**后文" emphasize, which CommonMark refuses next to CJK punctuation.
const remarkPlugins = [remarkGfm, remarkCjkFriendly];
const markdownComponents: Components = { a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> };
export function MessageText({ text, markdown }: { text: string; markdown: boolean }) {
  return markdown ? <div className="message-text markdown"><Markdown remarkPlugins={remarkPlugins} components={markdownComponents}>{text}</Markdown></div>
    : <div className="message-text">{text}</div>;
}
