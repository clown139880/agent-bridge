import assert from "node:assert/strict";
import test from "node:test";
import { manifestDrift } from "../scripts/shared-skills-manifest.js";

test("shared skill manifest hashes match the skill files", () => {
  assert.deepEqual(manifestDrift(), []);
});
