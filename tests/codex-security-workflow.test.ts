import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/codex-security-daily.yml", import.meta.url),
  "utf8"
);

test("daily Codex Security scan is pinned and targets Odinn Forge", () => {
  assert.match(workflow, /CODEX_SECURITY_PACKAGE: "@openai\/codex-security@0\.1\.1"/u);
  assert.match(workflow, /TARGET_REPOSITORY: BlueDot-IT\/Odinn-Forge/u);
  assert.match(workflow, /repository: \$\{\{ env\.TARGET_REPOSITORY \}\}/u);
  assert.match(workflow, /ref: \$\{\{ env\.TARGET_REF \}\}/u);
  assert.match(workflow, /path: odinn-forge/u);
  assert.match(workflow, /scan "\$TARGET_DIR"/u);
  assert.doesNotMatch(workflow, /scan \. \\/u);
});

test("centralized scan preserves Forge results without mispublishing SARIF", () => {
  assert.match(workflow, /--source-root "\$TARGET_DIR"/u);
  assert.match(workflow, /\$\{\{ runner\.temp \}\}\/codex-security\.sarif/u);
  assert.doesNotMatch(workflow, /security-events: write/u);
  assert.doesNotMatch(workflow, /github\/codeql-action\/upload-sarif/u);
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

test("Forge scan uses the scheduled-scan model with a bounded cost ceiling", () => {
  assert.match(workflow, /--model gpt-5\.6-terra/u);
  assert.match(workflow, /--max-cost 20/u);
});
