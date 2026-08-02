import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const testWorkflow = readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");

function runEntrypoint(path, overrides = {}) {
  const inherited = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE"
  ]) {
    if (process.env[name]) inherited[name] = process.env[name];
  }
  return spawnSync(process.execPath, [path], {
    cwd: root,
    encoding: "utf8",
    env: { ...inherited, ...overrides }
  });
}

test("plan entrypoint rejects a write token before producing an artifact", () => {
  const result = runEntrypoint(".github/maintainer/plan.mjs", {
    GITHUB_TOKEN: "test-write-token"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /planning must not receive the write-capable GitHub token/u);
});

test("apply entrypoint rejects model credentials before reading a plan", () => {
  const result = runEntrypoint(".github/maintainer/apply.mjs", {
    ODINN_OPENAI_OAUTH_JSON: "{\"accessToken\":\"test\"}"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deterministic apply must not receive model credentials/u);
});

test("review and target entrypoints fail closed without repository credentials", () => {
  const review = runEntrypoint(".github/maintainer/index.mjs");
  assert.equal(review.status, 1);
  assert.match(review.stderr, /Odinn Maintainer failed:/u);

  const targets = runEntrypoint(".github/maintainer/targets.mjs");
  assert.equal(targets.status, 1);
  assert.match(targets.stderr, /Odinn Maintainer discovery failed:/u);
});

test("the required test check aggregates the complete platform matrix", () => {
  assert.match(testWorkflow, /^\s{2}test_matrix:$/mu);
  assert.match(testWorkflow, /os: \[ubuntu-latest, windows-latest\]/u);
  assert.match(testWorkflow, /^\s{2}test:\n\s{4}name: test$/mu);
  assert.match(testWorkflow, /needs: test_matrix/u);
  assert.match(testWorkflow, /MATRIX_RESULT: \$\{\{ needs\.test_matrix\.result \}\}/u);
  assert.match(testWorkflow, /test "\$MATRIX_RESULT" = "success"/u);
});
