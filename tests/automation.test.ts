import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyMerge,
  applyRepair,
  bindOneShotAuthorization,
  buildPlan,
  capabilityAllowed,
  closeGuard,
  CLOSE_OPT_IN_LABEL,
  consumeOneShotAuthorization,
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
    createdAt: "2026-07-25T00:00:00Z",
    updatedAt: "2026-07-25T00:00:00Z",
    ...overrides
  };
}

function oneShot(
  item: ReturnType<typeof snapshot>,
  action: "close" | "repair",
  overrides: Record<string, unknown> = {}
) {
  const body = `/odinn-maintainer ${action}`;
  const commentValue = command(body, overrides);
  const now = Date.parse("2026-07-25T00:05:00Z");
  const authorization = bindOneShotAuthorization(item, {
    eventName: "issue_comment",
    actor: commentValue.author,
    now,
    payload: {
      action: "created",
      issue: {
        number: item.number,
        ...(item.kind === "pull_request" ? { pull_request: {} } : {})
      },
      comment: {
        id: commentValue.id,
        body,
        user: { login: commentValue.author },
        author_association: commentValue.authorAssociation,
        created_at: commentValue.createdAt,
        updated_at: commentValue.updatedAt
      }
    }
  });
  assert.ok(authorization);
  return { authorization, now };
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
  const bound = oneShot(item, "close");
  assert.equal(
    closeGuard(item, closeReview, {
      allow: true,
      actor: "alice",
      authorization: bound.authorization,
      now: bound.now
    }).allowed,
    true
  );
  assert.equal(closeGuard(item, closeReview, { allow: false, actor: "alice" }).allowed, false);
  assert.equal(
    closeGuard(item, closeReview, {
      allow: true,
      actor: "github-actions[bot]",
      authorization: bound.authorization,
      now: bound.now
    }).allowed,
    false
  );
  assert.equal(
    closeGuard(
      { ...item, allComments: [command("/odinn-maintainer close", { authorAssociation: "CONTRIBUTOR" })] },
      closeReview,
      { allow: true, actor: "alice", authorization: bound.authorization, now: bound.now }
    ).allowed,
    false
  );
  for (const changedCommand of [
    command("/odinn-maintainer repair"),
    command("/odinn-maintainer close", { updatedAt: "2026-07-25T00:00:01Z" })
  ]) {
    assert.equal(
      closeGuard(
        { ...item, allComments: [changedCommand] },
        closeReview,
        { allow: true, actor: "alice", authorization: bound.authorization, now: bound.now }
      ).allowed,
      false
    );
  }
});

test("merge is same-repository, success-only, squash-only, and exact-head commanded", async () => {
  const item = snapshot({
    labels: [MERGE_OPT_IN_LABEL],
    allComments: [command(`/odinn-maintainer merge ${headSha}`)]
  });
  assert.equal(mergeGuard(item, review(), { allow: true, actor: "alice" }).allowed, true);
  assert.equal(
    mergeGuard(
      { ...item, allComments: [command(`/odinn-maintainer automerge ${headSha}`)] },
      review(),
      { allow: true, actor: "github-actions[bot]" }
    ).allowed,
    true
  );
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
  const bound = oneShot(item, "repair");
  assert.equal(
    repairGuard(item, repairReview, {
      allow: true,
      actor: "alice",
      repairBase: { branch: "main", sha: baseSha },
      authorization: bound.authorization,
      now: bound.now
    }).allowed,
    true
  );
  assert.equal(
    repairGuard({ ...item, comments: [] }, repairReview, {
      allow: true,
      actor: "alice",
      repairBase: { branch: "main", sha: baseSha },
      authorization: bound.authorization,
      now: bound.now
    }).allowed,
    false
  );
});

test("one-shot commands bind exact actor, event, timestamps, target, source, and plan digest", () => {
  const item = snapshot({
    labels: [CLOSE_OPT_IN_LABEL],
    allComments: [command("/odinn-maintainer close")]
  });
  const bound = oneShot(item, "close");
  assert.equal(
    bindOneShotAuthorization(item, {
      eventName: "schedule",
      actor: "github-actions[bot]",
      now: bound.now,
      payload: {}
    }),
    null
  );
  const eventComment = command("/odinn-maintainer close");
  const eventPayload = {
    action: "created",
    issue: { number: item.number, pull_request: {} },
    comment: {
      id: eventComment.id,
      body: eventComment.body,
      user: { login: eventComment.author },
      author_association: eventComment.authorAssociation,
      created_at: eventComment.createdAt,
      updated_at: eventComment.updatedAt
    }
  };
  assert.equal(
    bindOneShotAuthorization(item, {
      eventName: "issue_comment",
      actor: "alice",
      now: bound.now,
      payload: { ...eventPayload, issue: { number: item.number + 1, pull_request: {} } }
    }),
    null
  );
  assert.equal(
    bindOneShotAuthorization(item, {
      eventName: "issue_comment",
      actor: "alice",
      now: bound.now,
      payload: {
        ...eventPayload,
        comment: {
          ...eventPayload.comment,
          created_at: "2026-07-25T00:07:00Z",
          updated_at: "2026-07-25T00:07:00Z"
        }
      }
    }),
    null
  );
  for (const overrides of [
    { author: "bob" },
    { authorAssociation: "CONTRIBUTOR" },
    { updatedAt: "2026-07-25T00:00:01Z" },
    { createdAt: "2026-07-24T22:00:00Z", updatedAt: "2026-07-24T22:00:00Z" }
  ]) {
    const changed = command("/odinn-maintainer close", overrides);
    assert.equal(
      bindOneShotAuthorization(item, {
        eventName: "issue_comment",
        actor: "alice",
        now: bound.now,
        payload: {
          action: "created",
          issue: { number: item.number, pull_request: {} },
          comment: {
            id: changed.id,
            body: changed.body,
            user: { login: changed.author },
            author_association: changed.authorAssociation,
            created_at: changed.createdAt,
            updated_at: changed.updatedAt
          }
        }
      }),
      null
    );
  }
  const closeReview = review({ decision: "close_candidate", closeReason: "invalid" });
  assert.equal(
    closeGuard(
      { ...item, sourceSha: "c".repeat(40) },
      closeReview,
      { allow: true, actor: "alice", authorization: bound.authorization, now: bound.now }
    ).allowed,
    false
  );
  assert.throws(
    () => validatePlan({
      ...buildPlan({
        repository: item.repo,
        snapshot: item,
        model: "test",
        mode: "review",
        decision: closeReview.decision,
        confidence: closeReview.confidence,
        review: closeReview,
        oneShotAuthorization: bound.authorization,
        createdAt: "2026-07-25T00:05:00Z"
      }),
      snapshotDigest: "f".repeat(64)
    }, { now: bound.now }),
    /not bound/
  );
});

test("one-shot consumption creates one trusted durable receipt and rejects reruns or races", async () => {
  const item = snapshot({
    labels: [REPAIR_OPT_IN_LABEL],
    comments: [command("/odinn-maintainer repair")]
  });
  const { authorization } = oneShot(item, "repair");
  const comments: Record<string, unknown>[] = [];
  let nextId = 100;
  const api = {
    comments: async () => ({ items: [...comments], complete: true }),
    createComment: async (_number: number, body: string) => {
      const created = {
        id: nextId++,
        body,
        user: { login: "github-actions[bot]", type: "Bot" }
      };
      comments.push(created);
      return created;
    }
  };
  const receipt = await consumeOneShotAuthorization(api, authorization, {
    actor: "alice",
    runId: "1234",
    runAttempt: 1
  });
  assert.equal(receipt.commandId, 1);
  assert.equal(receipt.author, "alice");
  await assert.rejects(
    consumeOneShotAuthorization(api, authorization, {
      actor: "alice",
      runId: "1234",
      runAttempt: 2
    }),
    /already consumed/
  );
  await assert.rejects(
    consumeOneShotAuthorization(api, authorization, {
      actor: "github-actions[bot]",
      runId: "1235",
      runAttempt: 1
    }),
    /actor changed/
  );
  const marker = /payload=([A-Za-z0-9_-]+)/u.exec(String(comments[0].body));
  assert.ok(marker);
  const tamperedPayload = JSON.parse(Buffer.from(marker[1], "base64url").toString("utf8"));
  tamperedPayload.author = "mallory";
  const tamperedBody = String(comments[0].body).replace(
    marker[1],
    Buffer.from(JSON.stringify(tamperedPayload), "utf8").toString("base64url")
  );
  await assert.rejects(
    consumeOneShotAuthorization(
      {
        comments: async () => ({
          items: [{ ...comments[0], body: tamperedBody }],
          complete: true
        }),
        createComment: api.createComment
      },
      authorization,
      { actor: "alice", runId: "1235", runAttempt: 1 }
    ),
    /tampered/
  );
  await assert.rejects(
    consumeOneShotAuthorization(
      {
        comments: async () => ({ items: [], complete: false }),
        createComment: api.createComment
      },
      authorization,
      { actor: "alice", runId: "1236", runAttempt: 1 }
    ),
    /incomplete/
  );
  const racingComments: Record<string, unknown>[] = [];
  await assert.rejects(
    consumeOneShotAuthorization(
      {
        comments: async () => ({ items: [...racingComments], complete: true }),
        createComment: async (_number: number, body: string) => {
          const own = { id: 200, body, user: { login: "github-actions[bot]", type: "Bot" } };
          const rival = { id: 201, body, user: { login: "github-actions[bot]", type: "Bot" } };
          racingComments.push(own, rival);
          return own;
        }
      },
      authorization,
      { actor: "alice", runId: "1237", runAttempt: 1 }
    ),
    /raced or became ambiguous/
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

test("documented caller blocks Apply unless Plan succeeds", () => {
  const readme = readFileSync(".github/maintainer/README.md", "utf8");
  assert.doesNotMatch(readme, /continue-on-error:\s*true/u);
  assert.match(readme, /needs:\s*plan/u);
  assert.match(readme, /if:\s*\$\{\{ needs\.plan\.result == 'success' \}\}/u);
  assert.match(readme, /no plan artifact/u);
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
    () => validatePlan(plan, { now: Date.parse(createdAt) + 61 * 60 * 1_000 }),
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
