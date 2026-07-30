import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/codex-security-daily.yml", import.meta.url),
  "utf8"
);

test("daily Codex Security scan is pinned and defaults to Odinn Forge", () => {
  assert.match(workflow, /CODEX_SECURITY_PACKAGE: "@openai\/codex-security@0\.1\.3"/u);
  assert.match(
    workflow,
    /TARGET_REPOSITORY: \$\{\{ inputs\.target_repository \|\| 'BlueDot-IT\/Odinn-Forge' \}\}/u
  );
  assert.match(workflow, /repository: \$\{\{ env\.TARGET_REPOSITORY \}\}/u);
  assert.match(workflow, /ref: \$\{\{ env\.TARGET_REF \}\}/u);
  assert.match(workflow, /path: target-repository/u);
  assert.match(workflow, /name: Bind scan to an immutable worktree snapshot/u);
  assert.match(workflow, /\.codex-security-ci-snapshot/u);
  assert.match(workflow, /scan "\$TARGET_DIR"/u);
  assert.doesNotMatch(workflow, /scan \. \\/u);
});

test("reusable callers are restricted to BlueDot and provide explicit secrets", () => {
  assert.match(workflow, /^\s{2}workflow_call:$/mu);
  assert.match(workflow, /target_repository:[\s\S]*?default: BlueDot-IT\/Odinn-Forge/u);
  assert.match(workflow, /target_ref:[\s\S]*?default: main/u);
  assert.match(workflow, /ODINN_OPENAI_OAUTH_JSON:[\s\S]*?required: true/u);
  assert.match(workflow, /ODINN_SECURITY_ARTIFACT_KEY:[\s\S]*?required: true/u);
  assert.match(workflow, /if: github\.repository_owner == 'BlueDot-IT'/u);
  assert.match(
    workflow,
    /group: codex-security-daily-\$\{\{ inputs\.target_repository \|\| 'BlueDot-IT\/Odinn-Forge' \}\}/u
  );
});

test("centralized scan preserves Forge results without mispublishing SARIF", () => {
  assert.match(workflow, /--source-root "\$TARGET_DIR"/u);
  assert.match(workflow, /\$\{\{ runner\.temp \}\}\/codex-security\.sarif/u);
  assert.doesNotMatch(workflow, /security-events: write/u);
  assert.doesNotMatch(workflow, /github\/codeql-action\/upload-sarif/u);
});

test("public-repository artifacts are encrypted before upload", () => {
  assert.match(workflow, /secrets\.ODINN_SECURITY_ARTIFACT_KEY/u);
  assert.match(workflow, /openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000/u);
  assert.match(workflow, /name: Preserve encrypted scan results/u);
  assert.match(
    workflow,
    /path: \$\{\{ runner\.temp \}\}\/codex-security-results-\$\{\{ github\.run_id \}\}\.tar\.gz\.enc/u
  );
  assert.doesNotMatch(workflow, /name: Preserve scan results/u);
});

test("hosted Ubuntu runner proves the Codex sandbox before spending scan tokens", () => {
  assert.match(workflow, /name: Verify Codex Linux sandbox/u);
  assert.match(workflow, /kernel\.apparmor_restrict_unprivileged_userns=0/u);
  assert.match(workflow, /"\$CODEX_BIN" sandbox true/u);
  assert.ok(
    workflow.indexOf("name: Verify Codex Linux sandbox") <
      workflow.indexOf("name: Scan repository")
  );
});

test("scheduled scans use the approved model with a bounded cost ceiling", () => {
  assert.match(workflow, /--model gpt-5\.6-terra/u);
});
