import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/codex-security-remediation.yml", import.meta.url),
  "utf8"
);

test("remediation is caller-scoped to Odinn Forge and never auto-merges", () => {
  assert.match(workflow, /github\.repository == 'BlueDot-IT\/Odinn-Forge'/u);
  assert.match(workflow, /repository: BlueDot-IT\/Odinn-Forge/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /--draft/u);
  assert.doesNotMatch(workflow, /gh pr merge|mergePull|automerge/u);
});

test("model work and repository write credentials occupy separate steps", () => {
  const patchStart = workflow.indexOf("name: Generate candidate remediation");
  const writeStart = workflow.indexOf("name: Push branch and open draft pull request");
  assert.ok(patchStart >= 0);
  assert.ok(writeStart > patchStart);

  const patchStep = workflow.slice(patchStart, writeStart);
  assert.match(patchStep, /CODEX_HOME:/u);
  assert.doesNotMatch(patchStep, /GH_TOKEN:|github\.token/u);

  const writeStep = workflow.slice(writeStart);
  assert.match(writeStep, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.doesNotMatch(writeStep, /CODEX_HOME:|oauth_json/u);
});

test("candidate remediation is base-bound, bounded, and path restricted", () => {
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$BASE_SHA"/u);
  assert.match(workflow, /test "\$\{#changed\[@\]\}" -le 20/u);
  assert.match(workflow, /test "\$diff_bytes" -le 300000/u);
  assert.match(workflow, /git diff --check/u);
  assert.match(workflow, /Candidate touches a denied path/u);
  assert.match(workflow, /fingerprints\.primary/u);
  assert.match(workflow, /test "\$\(git rev-parse "origin\/\$TARGET_REF"\)" = "\$BASE_SHA"/u);
});

test("candidate is verified before publication and CI is explicitly dispatched", () => {
  const verifyStart = workflow.indexOf("name: Verify candidate against Forge checks");
  const writeStart = workflow.indexOf("name: Push branch and open draft pull request");
  assert.ok(verifyStart >= 0);
  assert.ok(writeStart > verifyStart);
  assert.match(workflow.slice(verifyStart, writeStart), /pnpm check/u);
  assert.match(workflow.slice(writeStart), /gh workflow run ci\.yml/u);
});
