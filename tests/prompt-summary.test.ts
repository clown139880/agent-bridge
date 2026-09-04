import assert from "node:assert/strict";
import test from "node:test";
import { summarizePrompt } from "../apps/bridge/src/app-server.js";

test("summarizePrompt makes a compact single-line Matrix label", () => {
  assert.equal(summarizePrompt("  Fix the API\n\nand run tests  "), "Fix the API and run tests");
  assert.equal(summarizePrompt("abcdefghij", 6), "abcde…");
  assert.equal(summarizePrompt("   "), undefined);
});
