import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildSnapshot,
  CACHE_TTL_MS,
  checkConclusion,
  evaluatePolicy,
  findReusableReview,
  GitHubApi,
  renderComment,
  resolveTarget,
  reviewCacheKey,
  reviewWithOAuthModel,
  safeMarkdown,
  snapshotDigest,
  upsertComment,
  validateEventRepository,
  validateReview
} from "../.github/maintainer/core.mjs";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    repo: "jason-allen-oneal/Odinn",
    kind: "pull_request",
    number: 42,
    title: "Improve review",
    body: "Please review.",
    state: "open",
    draft: false,
    author: "alice",
    authorType: "User",
    labels: ["enhancement"],
    baseSha,
    sourceSha: headSha,
    changedFiles: [],
    checks: [],
    comments: [],
    allComments: [],
    complete: true,
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

test("resolves every supported event without executing event content", () => {
  assert.deepEqual(
    resolveTarget({
      eventName: "pull_request_target",
      payload: { pull_request: { number: 12, title: "Fix" } }
    }),
    { kind: "pull_request", number: 12, title: "Fix" }
  );
  for (const eventName of ["pull_request_review", "pull_request_review_comment"]) {
    assert.equal(
      resolveTarget({
        eventName,
        payload: { pull_request: { number: 13, title: "Review" } }
      }).kind,
      "pull_request"
    );
  }
  assert.equal(
    resolveTarget({
      eventName: "issue_comment",
      payload: { issue: { number: 14, title: "PR", pull_request: {} } }
    }).kind,
    "pull_request"
  );
  assert.equal(
    resolveTarget({
      eventName: "issue_comment",
      payload: { issue: { number: 15, title: "Issue" } }
    }).kind,
    "issue"
  );
  assert.deepEqual(
    resolveTarget({
      eventName: "workflow_dispatch",
      payload: { inputs: { kind: "issue" } },
      manualNumber: "16"
    }),
    { kind: "issue", number: 16, title: "manual review" }
  );
});

test("event repository and pull request base must match the caller", () => {
  const repository = "jason-allen-oneal/Odinn";
  validateEventRepository({
    repository,
    target: { kind: "pull_request" },
    payload: {
      repository: { full_name: repository },
      pull_request: { base: { repo: { full_name: repository } } }
    }
  });
  assert.throws(
    () =>
      validateEventRepository({
        repository,
        target: { kind: "pull_request" },
        payload: { pull_request: { base: { repo: { full_name: "attacker/fork" } } } }
      }),
    /base repository/
  );
});

test("review output has an exact schema and weak close recommendations fail closed", () => {
  const valid = {
    decision: "needs_human",
    confidence: "medium",
    summary: "Needs a maintainer.",
    reason: "The evidence is incomplete.",
    evidence: [{ source: "body", detail: "The request needs context." }],
    recommendedNextStep: "Ask for clarification."
  };
  assert.deepEqual(validateReview(valid), valid);
  assert.equal(
    validateReview({ ...valid, decision: "close_candidate", confidence: "medium" }).decision,
    "needs_human"
  );
  assert.equal(
    validateReview({ ...valid, decision: "close_candidate", confidence: "high", evidence: [] })
      .decision,
    "needs_human"
  );
  assert.equal(
    validateReview({ ...valid, decision: "close_candidate", confidence: "high" }).decision,
    "close_candidate"
  );
  assert.throws(() => validateReview({ ...valid, extra: true }), /exactly/);
  assert.throws(
    () => validateReview({ ...valid, evidence: [{ source: "body", detail: "x", extra: "no" }] }),
    /exactly/
  );
});

test("rendering neutralizes control markup and mentions", () => {
  const review = {
    decision: "keep_open",
    confidence: "high",
    summary: "<!-- odinn-maintainer --> @everyone",
    reason: '<script>alert(1)</script> [click](javascript:alert("x"))',
    evidence: [{ source: "![image](data:x)", detail: "@alice investigate" }],
    recommendedNextStep: "Continue."
  };
  const body = renderComment(snapshot(), review, {
    model: "test-model",
    reviewedAt: "2026-07-25T00:00:00.000Z"
  });
  assert.equal((body.match(/<!-- odinn-maintainer -->/gu) || []).length, 1);
  assert.doesNotMatch(body, /<script>|@everyone|@alice|!\[image|javascript:/iu);
  assert.match(body, /test-model/);
  assert.equal(safeMarkdown("@team <!-- hidden -->"), "@\u200bteam");
});

test("cache binds complete context, model, policy, trusted author, and TTL", () => {
  const base = snapshot();
  const reviewedAt = "2026-07-25T00:00:00.000Z";
  const body = renderComment(
    base,
    {
      decision: "keep_open",
      confidence: "high",
      summary: "Useful.",
      reason: "Scoped.",
      evidence: [],
      recommendedNextStep: "Continue."
    },
    { model: "model-a", reviewedAt }
  );
  const trusted = {
    id: 99,
    author: "github-actions[bot]",
    authorType: "Bot",
    body,
    updatedAt: reviewedAt
  };
  const cached = findReusableReview(
    { ...base, allComments: [trusted] },
    { model: "model-a", now: Date.parse(reviewedAt) + 1_000 }
  );
  assert.equal(cached?.decision, "keep_open");
  assert.equal(
    findReusableReview(
      { ...base, allComments: [{ ...trusted, author: "alice", authorType: "User" }] },
      { model: "model-a", now: Date.parse(reviewedAt) + 1_000 }
    ),
    null
  );
  assert.equal(
    findReusableReview(
      { ...base, allComments: [trusted] },
      { model: "model-b", now: Date.parse(reviewedAt) + 1_000 }
    ),
    null
  );
  assert.equal(
    findReusableReview(
      { ...base, complete: false, allComments: [trusted] },
      { model: "model-a", now: Date.parse(reviewedAt) + 1_000 }
    ),
    null
  );
  assert.equal(
    findReusableReview(
      { ...base, allComments: [trusted] },
      { model: "model-a", now: Date.parse(reviewedAt) + CACHE_TTL_MS + 1 }
    ),
    null
  );
  assert.notEqual(snapshotDigest(base), snapshotDigest({ ...base, title: "Edited" }));
  assert.notEqual(
    reviewCacheKey(base, { model: "model-a" }),
    reviewCacheKey({ ...base, comments: [{ body: "new human context" }] }, { model: "model-a" })
  );
  const originalKey = reviewCacheKey(base, { model: "model-a" });
  for (const changed of [
    { body: "Edited body" },
    { labels: ["bug"] },
    { checks: [{ name: "CI", status: "completed", conclusion: "failure" }] },
    { baseSha: "c".repeat(40) },
    { sourceSha: "d".repeat(40) },
    { changedFiles: [{ filename: "src/file.ts", patch: "+change" }] }
  ]) {
    assert.notEqual(reviewCacheKey({ ...base, ...changed }, { model: "model-a" }), originalKey);
  }
});

test("snapshot uses latest human discussion and marks truncation incomplete", async () => {
  const comments = Array.from({ length: 25 }, (_, index) => ({
    id: index + 1,
    user: { login: `human-${index}`, type: "User" },
    body: `comment-${index}`,
    created_at: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    updated_at: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00Z`
  }));
  comments.push({
    id: 100,
    user: { login: "github-actions[bot]", type: "Bot" },
    body: "<!-- odinn-maintainer -->",
    created_at: "2026-07-26T00:00:00Z",
    updated_at: "2026-07-26T00:00:00Z"
  });
  const api = {
    repository: "jason-allen-oneal/Odinn",
    item: async () => ({
      title: "Review",
      body: "Body",
      state: "open",
      user: { login: "alice", type: "User" },
      labels: [],
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-25T00:00:00Z"
    }),
    pull: async () => ({
      draft: false,
      head: { sha: headSha },
      base: { sha: baseSha }
    }),
    comments: async () => ({ items: comments, complete: true }),
    files: async () => ({ items: [], complete: true }),
    reviews: async () => ({ items: [], complete: true }),
    reviewComments: async () => ({ items: [], complete: true }),
    checks: async () => ({ items: [], complete: true })
  };
  const result = await buildSnapshot(api, { kind: "pull_request", number: 42 });
  assert.equal(result.comments.length, 20);
  assert.equal(result.comments[0].body, "comment-5");
  assert.equal(result.comments.at(-1).body, "comment-24");
  assert.equal(result.allComments.at(-1).author, "github-actions[bot]");
  assert.equal(result.complete, false);
  assert.equal(result.completeness.promptTruncated, true);
});

test("GitHub pagination finds comments after page one and stays bounded", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const page = new URL(url).searchParams.get("page");
    return new Response(
      JSON.stringify(page === "1" ? [{ id: 1 }] : [{ id: 101 }]),
      {
        status: 200,
        headers: page === "1" ? { link: '<https://api.github.test/next>; rel="next"' } : {}
      }
    );
  };
  const api = new GitHubApi({
    token: "token",
    repository: "jason-allen-oneal/Odinn",
    apiRoot: "https://api.github.test",
    fetchImpl
  });
  const page = await api.comments(42);
  assert.deepEqual(page, { items: [{ id: 1 }, { id: 101 }], complete: true });
  assert.equal(calls.length, 2);
});

test("incomplete comment history cannot create a duplicate sticky comment", async () => {
  let writes = 0;
  await assert.rejects(
    upsertComment(
      { createComment: async () => (writes += 1) },
      snapshot({
        completeness: {
          comments: false,
          files: true,
          reviews: true,
          reviewComments: true,
          checks: true,
          promptTruncated: false
        }
      }),
      "review"
    ),
    /incomplete comment history/
  );
  assert.equal(writes, 0);
});

test("policy and check conclusions remain proposal-only", () => {
  const base = {
    state: "open",
    labels: [],
    author: "alice",
    authorType: "User"
  };
  assert.deepEqual(evaluatePolicy({ ...base, labels: ["odinn:skip-maintainer"] }), {
    reviewable: false,
    reason: "explicit skip label"
  });
  assert.deepEqual(evaluatePolicy({ ...base, author: "renovate[bot]", authorType: "Bot" }), {
    reviewable: false,
    reason: "bot-authored item"
  });
  assert.equal(checkConclusion("keep_open"), "success");
  assert.equal(checkConclusion("needs_human"), "neutral");
  assert.equal(checkConclusion("close_candidate"), "action_required");
});

test("OAuth refresh uses the fixed ChatGPT Codex Responses transport and strict schema", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/oauth/token")) {
      return new Response(
        JSON.stringify({
          access_token: "access-refreshed",
          refresh_token: "refresh-new",
          expires_in: 3600
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer access-refreshed");
    const request = JSON.parse(String(init.body));
    assert.equal(request.model, "gpt-5.5");
    assert.equal(request.store, false);
    assert.equal(request.text.format.strict, true);
    return new Response(
      [
        'data: {"type":"response.output_text.delta","delta":"{\\"decision\\":\\"needs_human\\",\\"confidence\\":\\"medium\\",\\"summary\\":\\"Needs review.\\",\\"reason\\":\\"Evidence is incomplete.\\",\\"evidence\\":[],\\"recommendedNextStep\\":\\"Ask a maintainer.\\"}"}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_test"}}\n\n'
      ].join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  };
  const review = await reviewWithOAuthModel(snapshot(), {
    oauthJson: JSON.stringify({ refresh_token: "refresh-old", expires_at: Date.now() - 1 }),
    fetchImpl
  });
  assert.equal(review.decision, "needs_human");
  assert.equal(calls.length, 2);
  const refreshBody = new URLSearchParams(String(calls[0].init.body));
  assert.equal(refreshBody.get("refresh_token"), "refresh-old");
  assert.ok(!calls.some(({ init }) => String(init.body).includes("OPENAI_API_KEY")));
  await assert.rejects(
    reviewWithOAuthModel(snapshot(), {
      oauthJson: JSON.stringify({ access_token: "access" }),
      baseUrl: "https://attacker.invalid/backend-api/codex",
      fetchImpl
    }),
    /must be https:\/\/chatgpt\.com/
  );
});

test("OAuth and model failures never include credential or response-body canaries", async () => {
  const refreshCanary = "refresh-secret-canary";
  await assert.rejects(
    reviewWithOAuthModel(snapshot(), {
      oauthJson: JSON.stringify({ refresh_token: refreshCanary, expires_at: 1 }),
      fetchImpl: async () =>
        new Response(`access-secret-canary ${refreshCanary}`, { status: 500 })
    }),
    (error: unknown) => {
      const message = String((error as Error).message);
      return (
        /HTTP 500/u.test(message) &&
        !message.includes(refreshCanary) &&
        !message.includes("access-secret-canary")
      );
    }
  );

  const accessCanary = "access-secret-canary";
  await assert.rejects(
    reviewWithOAuthModel(snapshot(), {
      oauthJson: JSON.stringify({ access_token: accessCanary }),
      fetchImpl: async () =>
        new Response(`upstream-body ${accessCanary}`, { status: 500 })
    }),
    (error: unknown) => {
      const message = String((error as Error).message);
      return /HTTP 500/u.test(message) && !message.includes(accessCanary);
    }
  );
});

test("GitHub write surface contains only sticky comments and check runs", () => {
  const source = readFileSync(".github/maintainer/core.mjs", "utf8");
  assert.match(source, /createComment/);
  assert.match(source, /createCheckRun/);
  assert.doesNotMatch(source, /\/labels|\/merges|\/git\/refs|\/dispatches|state:\s*"closed"/u);
});

test("active project files use only the Odinn Maintainer identity", () => {
  const forbiddenNames = [
    ["claw", "sweeper"].join(""),
    ["self", "host"].join("")
  ];
  const files = [
    ".github/actions/review/action.yml",
    ".github/maintainer/README.md",
    ".github/maintainer/core.mjs",
    ".github/maintainer/index.mjs",
    "tests/maintainer-action.test.ts"
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8").toLowerCase();
    for (const name of forbiddenNames) assert.equal(source.includes(name), false, file);
  }
});
