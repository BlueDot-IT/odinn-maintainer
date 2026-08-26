import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/codex-security-remediation.yml", import.meta.url),
  "utf8"
).replaceAll("\r\n", "\n");

test("remediation is caller-scoped to Odinn Forge and never auto-merges", () => {
  assert.match(workflow, /github\.repository == 'BlueDot-IT\/Odinn-Forge'/u);
  assert.match(workflow, /repository: BlueDot-IT\/Odinn-Forge/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /--draft/u);
  assert.doesNotMatch(workflow, /gh pr merge|mergePull|automerge/u);
});

test("scanner installation verifies the committed resolved dependency graph", () => {
  const scannerMaterialRevision = "bb1d0a74bc2d5076040af18312bc0a2cfc3a0045";
  assert.match(
    workflow,
    new RegExp(
      `repository: BlueDot-IT/odinn-maintainer[\\s\\S]*?ref: ${scannerMaterialRevision}`,
      "u"
    )
  );
  assert.doesNotMatch(
    workflow,
    /repository: BlueDot-IT\/odinn-maintainer(?:\n\s+#.*)*\n\s+ref: (?:main|master|HEAD)\b/u
  );
  assert.match(workflow, /cp "\$LOCK_DIR\/package\.json" "\$LOCK_DIR\/package-lock\.json" "\$INSTALL_DIR\/"/u);
  assert.match(workflow, /EXPECTED_PACKAGE_SHA256: 765c031b941ace16d816a3f0d3c9004556f3d67a26b9a446d36bd6b63edae01b/u);
  assert.match(workflow, /EXPECTED_LOCK_SHA256: b7745c09606d5a77bc3fb4b539066e9608a09c3adbc393b84460f9e8ac6320b1/u);
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
  assert.match(
    workflow,
    /cd "\$CANDIDATE_DIR"[\s\S]*?sha256sum candidate\.patch > candidate\.patch\.sha256/u
  );
  assert.doesNotMatch(
    workflow,
    /sha256sum "\$CANDIDATE_DIR\/candidate\.patch" > "\$CANDIDATE_DIR\/candidate\.patch\.sha256"/u
  );
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

test("controlled dry runs validate without entering the write-capable publication job", () => {
  assert.match(
    workflow,
    /dry_run:\s*\n\s+description:[^\n]+\n\s+required: false\n\s+type: boolean\n\s+default: false/u
  );

  const publishStart = workflow.indexOf("\n  publish:");
  const confirmStart = workflow.indexOf("\n  confirm-dry-run:");
  assert.ok(publishStart >= 0);
  assert.ok(confirmStart > publishStart);

  const publishJob = workflow.slice(publishStart, confirmStart);
  assert.match(publishJob, /!inputs\.dry_run/u);
  assert.match(publishJob, /contents: write/u);
  assert.match(publishJob, /pull-requests: write/u);

  const confirmationJob = workflow.slice(confirmStart);
  assert.match(confirmationJob, /if: \$\{\{ always\(\) && inputs\.dry_run \}\}/u);
  assert.match(confirmationJob, /permissions: \{\}/u);
  assert.match(confirmationJob, /test "\$PUBLISH_RESULT" = "skipped"/u);
  assert.match(confirmationJob, /test "\$VALIDATE_RESULT" = "success"/u);
  assert.doesNotMatch(
    confirmationJob,
    /oauth_json|CODEX_HOME|GH_TOKEN|contents: write|pull-requests: write/u
  );
});
