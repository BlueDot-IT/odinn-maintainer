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

test("scanner installation verifies the committed resolved dependency graph", () => {
  assert.match(workflow, /repository: BlueDot-IT\/odinn-maintainer[\s\S]*?ref: main/u);
  assert.match(workflow, /cp "\$LOCK_DIR\/package\.json" "\$LOCK_DIR\/package-lock\.json" "\$INSTALL_DIR\/"/u);
  assert.match(workflow, /EXPECTED_PACKAGE_SHA256: c1fd3a5274c542b1c1342a8b40711d9a70b802d9810b9e87e875eae3b911da5e/u);
  assert.match(workflow, /EXPECTED_LOCK_SHA256: c036a0a182450fe0e908a8eea82143fe55e7603e58b691d69c020785acb1cbc7/u);
  assert.match(workflow, /sha256sum --check --strict/u);
  assert.match(workflow, /npm ci/u);
  assert.match(workflow, /--ignore-scripts/u);
  assert.doesNotMatch(workflow, /--package-lock-only|\bnpm install\b/u);
});

test("model, validation, and publication occupy separate credential domains", () => {
  const prepareStart = workflow.indexOf("\n  prepare:");
  const validateStart = workflow.indexOf("\n  validate:");
  const publishStart = workflow.indexOf("\n  publish:");
  assert.ok(prepareStart >= 0);
  assert.ok(validateStart > prepareStart);
  assert.ok(publishStart > validateStart);

  const prepareJob = workflow.slice(prepareStart, validateStart);
  assert.match(prepareJob, /CODEX_HOME:/u);
  assert.match(prepareJob, /permissions:\s*\n\s*contents: read/u);
  assert.doesNotMatch(prepareJob, /GH_TOKEN:|contents: write|pull-requests: write/u);
  assert.match(prepareJob, /name: Remove model credentials/u);
  assert.match(prepareJob, /rm -rf -- "\$RUNNER_TEMP\/codex-home"/u);
  assert.match(prepareJob, /rm -f -- "\$TARGET_DIR\/\.codex-security-ci-snapshot"/u);

  const validateJob = workflow.slice(validateStart, publishStart);
  assert.match(validateJob, /pnpm check/u);
  assert.match(validateJob, /permissions:\s*\n\s*contents: read/u);
  assert.doesNotMatch(validateJob, /CODEX_HOME:|oauth_json|GH_TOKEN:|contents: write/u);

  const publishJob = workflow.slice(publishStart);
  assert.match(publishJob, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.doesNotMatch(publishJob, /CODEX_HOME:|oauth_json|pnpm check/u);
});

test("candidate remediation is base-bound, bounded, and path restricted", () => {
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$BASE_SHA"/u);
  assert.match(workflow, /test "\$\{#changed\[@\]\}" -le 20/u);
  assert.match(workflow, /test "\$diff_bytes" -le 300000/u);
  assert.match(workflow, /git diff --check/u);
  assert.match(workflow, /Candidate touches a denied path/u);
  assert.match(workflow, /fingerprints\.primary/u);
  assert.match(workflow, /test "\$\(git rev-parse origin\/main\)" = "\$BASE_SHA"/u);
  assert.match(workflow, /test "\$TARGET_REF" = "main"/u);
  assert.match(workflow, /sha256sum --check candidate\.patch\.sha256/u);
});

test("candidate is verified in a dependency job before publication and CI is explicitly dispatched", () => {
  const verifyStart = workflow.indexOf("name: Verify candidate against Forge checks");
  const publishJob = workflow.indexOf("\n  publish:");
  const writeStart = workflow.indexOf("name: Push branch and open draft pull request");
  assert.ok(verifyStart >= 0);
  assert.ok(publishJob > verifyStart);
  assert.ok(writeStart > verifyStart);
  assert.match(workflow.slice(verifyStart, publishJob), /pnpm check/u);
  assert.match(workflow.slice(publishJob, writeStart), /needs: \[prepare, validate\]/u);
  assert.match(workflow.slice(publishJob, writeStart), /needs\.validate\.result == 'success'/u);
  assert.match(workflow.slice(writeStart), /gh workflow run ci\.yml/u);
});
