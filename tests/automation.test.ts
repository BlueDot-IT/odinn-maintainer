import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyMerge,
  applyRepair,
  buildPlan,
  capabilityAllowed,
  closeGuard,
  CLOSE_OPT_IN_LABEL,
  mergeGuard,
  MERGE_OPT_IN_LABEL,
  repairGuard,
  REPAIR_OPT_IN_LABEL,
  resolveLiveRepairBase,
  validatePlan,
  validateRepairPath
} from "../.github/maintainer/automation.mjs";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    repo: "jason-allen-oneal/Odinn",
    kind: "pull_request",
    number: 42,
    state: "open",
    complete: true,
    draft: false,
    labels: [],
    sourceSha: headSha,
    baseSha,
    baseRepo: "jason-allen-oneal/Odinn",
    headRepo: "jason-allen-oneal/Odinn",
    baseRef: "main",
    headRef: "feature",
    mergeable: true,
    mergeableState: "clean",
    checks: [{ name: "test", status: "completed", conclusion: "success" }],
    comments: [],
    allComments: [],
    completeness: {
      comments: true,
      files: true,
      reviews: true,
      reviewComments: true,
      checks: true,
      promptTruncated: false
    },
    ...overrides
  };
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    decision: "keep_open",
    confidence: "high",
    summary: "Ready.",
    reason: "Evidence is complete.",
    evidence: [
      { source: "checks", detail: "Required checks passed." },
      { source: "diff", detail: "The change is bounded." }
    ],
    recommendedNextStep: "Proceed.",
    closeReason: "none",
    relatedNumber: 0,
    repair: { requested: false, title: "", body: "", changes: [] },
    ...overrides
  };
}

function command(body: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    author: "alice",
    authorType: "User",
    authorAssociation: "MEMBER",
    body,
    updatedAt: "2026-07-25T00:00:00Z",
    ...overrides
  };
}

test("global kill switch and actor authorization gate every autonomous capability", () => {
  for (const capability of [false, true]) {
    assert.equal(
      capabilityAllowed({ global: false, capability, actorAuthorized: true }),
      false
    );
    assert.equal(
      capabilityAllowed({ global: true, capability, actorAuthorized: false }),
      false
    );
  }
  assert.equal(
    capabilityAllowed({ global: true, capability: true, actorAuthorized: true }),
    true
  );
});

test("close requires opt-in, strong evidence, and an authorized exact command from the event actor", () => {
  const item = snapshot({
    labels: [CLOSE_OPT_IN_LABEL],
    allComments: [command("/odinn-maintainer close")]
  });
  const closeReview = review({
    decision: "close_candidate",
    closeReason: "invalid"
  });
  assert.equal(closeGuard(item, closeReview, { allow: true, actor: "alice" }).allowed, true);
  assert.equal(closeGuard(item, closeReview, { allow: false, actor: "alice" }).allowed, false);
  assert.equal(closeGuard(item, closeReview, { allow: true, actor: "mallory" }).allowed, false);
  assert.equal(
    closeGuard(
      { ...item, allComments: [command("/odinn-maintainer close", { authorAssociation: "CONTRIBUTOR" })] },
      closeReview,
      { allow: true, actor: "alice" }
    ).allowed,
    false
  );
});

test("merge is same-repository, success-only, squash-only, and exact-head commanded", async () => {
  const item = snapshot({
    labels: [MERGE_OPT_IN_LABEL],
    allComments: [command(`/odinn-maintainer merge ${headSha}`)]
  });
  assert.equal(mergeGuard(item, review(), { allow: true, actor: "alice" }).allowed, true);
  assert.equal(
    mergeGuard(
      { ...item, checks: [{ name: "test", status: "completed", conclusion: "neutral" }] },
      review(),
      { allow: true, actor: "alice" }
    ).allowed,
    true
  );
  assert.equal(
    mergeGuard(
      { ...item, checks: [{ name: "test", status: "completed", conclusion: "failure" }] },
      review(),
      { allow: true, actor: "alice" }
    ).allowed,
    false
  );
  assert.equal(
    mergeGuard(
      { ...item, headRepo: "contributor/fork" },
      review(),
      { allow: true, actor: "alice" }
    ).allowed,
    false
  );
  const calls: string[] = [];
  const api = {
    pull: async () => ({
      head: { sha: headSha, repo: { full_name: item.repo } },
      base: { repo: { full_name: item.repo } },
      draft: false,
      mergeable: true,
      mergeable_state: "clean"
    }),
    checks: async () => ({
      complete: true,
      items: [{
        name: "test",
        status: "completed",
        conclusion: "success",
        app: { id: 15368 }
      }]
    }),
    branchProtection: async () => ({
      required_status_checks: {
        strict: true,
        contexts: ["test"],
        checks: [{ context: "test", app_id: 15368 }]
      }
    }),
    mergePull: async (_number: number, input: { method: string }) => {
      calls.push(input.method);
      return { merged: true };
    }
  };
  await applyMerge(api, item, "squash");
  assert.deepEqual(calls, ["squash"]);
  await assert.rejects(applyMerge(api, item, "merge"), /squash-only/);
  await assert.rejects(
    applyMerge({
      ...api,
      checks: async () => ({
        complete: true,
        items: [{
          name: "test",
          status: "completed",
          conclusion: "success",
          app: { id: 999 }
        }]
      })
    }, item, "squash"),
    /required check is not successful/
  );
});

test("repair is command-gated and restricted to checked-in source, docs, and tests", () => {
  assert.equal(validateRepairPath("docs/guide.md"), "docs/guide.md");
  assert.equal(validateRepairPath("tests/review.test.ts"), "tests/review.test.ts");
  assert.equal(validateRepairPath("src/index.ts"), "src/index.ts");
  assert.equal(validateRepairPath("packages/channels/src/index.ts"), "packages/channels/src/index.ts");
  for (const path of [
    ".github/workflows/test.yml",
    "docs/security/policy.md",
    "tests/auth/token.test.ts",
    "tests/scripts/run.ts",
    ".odinn/config.json",
    ".forgejo/workflows/test.yml"
  ]) {
    assert.throws(() => validateRepairPath(path), /allowlist|denied|outside/);
  }
  const repairReview = review({
    repair: {
      requested: true,
      title: "Clarify the guide",
      body: "Updates documentation with bounded wording.",
      changes: [{
        path: "docs/guide.md",
        expectedSha: "c".repeat(40),
        mode: "replace_text",
        oldText: "Old",
        newText: "New",
        content: ""
      }]
    }
  });
  const item = snapshot({
    labels: [REPAIR_OPT_IN_LABEL],
    comments: [command("/odinn-maintainer repair")]
  });
  assert.equal(
    repairGuard(item, repairReview, {
      allow: true,
      actor: "alice",
      repairBase: { branch: "main", sha: baseSha }
    }).allowed,
    true
  );
  assert.equal(
    repairGuard({ ...item, comments: [] }, repairReview, {
      allow: true,
      actor: "alice",
      repairBase: { branch: "main", sha: baseSha }
    }).allowed,
    false
  );
});

test("planning and apply action boundaries keep OAuth away from the writer", () => {
  const planAction = readFileSync(".github/actions/plan/action.yml", "utf8");
  const applyAction = readFileSync(".github/actions/apply/action.yml", "utf8");
  assert.match(planAction, /ODINN_OPENAI_OAUTH_JSON/u);
  assert.doesNotMatch(planAction, /\n\s*GITHUB_TOKEN:/u);
  assert.match(applyAction, /\n\s*GITHUB_TOKEN:/u);
  assert.doesNotMatch(applyAction, /ODINN_OPENAI_OAUTH_JSON|OPENAI_API_KEY/u);
  assert.match(applyAction, /plan-path/u);
  assert.match(applyAction, /default: "false"/u);
});

test("plans expire and repair apply rechecks the executor-derived default branch tip", async () => {
  const item = snapshot({ kind: "issue", sourceSha: "2026-07-25T00:00:00Z" });
  const createdAt = "2026-07-25T00:00:00.000Z";
  const plan = buildPlan({
    repository: item.repo,
    snapshot: item,
    model: "test-model",
    mode: "cached",
    decision: "keep_open",
    confidence: "cached",
    createdAt
  });
  assert.throws(
    () => validatePlan(plan, { now: Date.parse(createdAt) + 16 * 60 * 1_000 }),
    /expired/
  );
  const api = {
    repositoryInfo: async () => ({ default_branch: "main" }),
    gitRef: async () => ({ object: { sha: baseSha } })
  };
  assert.deepEqual(
    await resolveLiveRepairBase(api, item, { branch: "ignored", sha: baseSha }),
    { branch: "main", sha: baseSha }
  );
  await assert.rejects(
    resolveLiveRepairBase(
      { ...api, gitRef: async () => ({ object: { sha: "c".repeat(40) } }) },
      item,
      { branch: "ignored", sha: baseSha }
    ),
    /changed after planning/
  );
});

test("repair retries reconcile an existing exact-plan pull request without another branch write", async () => {
  let writes = 0;
  const baseTreeSha = "d".repeat(40);
  const newTreeSha = "e".repeat(40);
  const existingCommitSha = "f".repeat(40);
  const repairReview = review({
    repair: {
      requested: true,
      title: "Clarify the guide",
      body: "Updates bounded documentation wording.",
      changes: [{
        path: "docs/guide.md",
        expectedSha: "c".repeat(40),
        mode: "replace_text",
        oldText: "Old",
        newText: "New",
        content: ""
      }]
    }
  });
  const result = await applyRepair(
    {
      content: async () => ({
        type: "file",
        encoding: "base64",
        sha: "c".repeat(40),
        content: Buffer.from("Old").toString("base64")
      }),
      gitCommit: async (sha: string) => sha === baseSha
        ? { tree: { sha: baseTreeSha } }
        : { tree: { sha: newTreeSha }, parents: [{ sha: baseSha }] },
      createGitBlob: async () => ({ sha: "1".repeat(40) }),
      createGitTree: async () => ({ sha: newTreeSha }),
      gitRef: async () => ({ object: { sha: existingCommitSha } }),
      pullsForHead: async (_owner: string, branch: string) => [{
        number: 88,
        html_url: "https://github.test/Odinn/pull/88",
        head: {
          ref: branch,
          sha: existingCommitSha,
          repo: { full_name: "jason-allen-oneal/Odinn" }
        },
        base: {
          ref: "main",
          repo: { full_name: "jason-allen-oneal/Odinn" }
        }
      }],
      createGitRef: async () => {
        writes += 1;
      }
    },
    snapshot(),
    repairReview,
    { branch: "main", sha: baseSha }
  );
  assert.equal(result.number, 88);
  assert.equal(writes, 0);
});

test("repair reconciliation rejects a same-name branch with a different tree", async () => {
  const repairReview = review({
    repair: {
      requested: true,
      title: "Clarify the guide",
      body: "Updates bounded documentation wording.",
      changes: [{
        path: "docs/guide.md",
        expectedSha: "c".repeat(40),
        mode: "replace_text",
        oldText: "Old",
        newText: "New",
        content: ""
      }]
    }
  });
  await assert.rejects(
    applyRepair(
      {
        content: async () => ({
          type: "file",
          encoding: "base64",
          sha: "c".repeat(40),
          content: Buffer.from("Old").toString("base64")
        }),
        gitCommit: async (sha: string) => sha === baseSha
          ? { tree: { sha: "d".repeat(40) } }
          : { tree: { sha: "0".repeat(40) }, parents: [{ sha: baseSha }] },
        createGitBlob: async () => ({ sha: "1".repeat(40) }),
        createGitTree: async () => ({ sha: "e".repeat(40) }),
        gitRef: async () => ({ object: { sha: "f".repeat(40) } }),
        pullsForHead: async () => []
      },
      snapshot(),
      repairReview,
      { branch: "main", sha: baseSha }
    ),
    /does not match the exact planned tree and parent/
  );
});
