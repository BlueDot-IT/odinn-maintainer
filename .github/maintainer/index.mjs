import { appendFile, readFile } from "node:fs/promises";
import {
  buildSnapshot,
  CHECK_NAME,
  checkConclusion,
  evaluatePolicy,
  findReusableReview,
  GitHubApi,
  renderComment,
  resolveTarget,
  reviewWithOAuthModel,
  safeMarkdown,
  snapshotDigest,
  upsertComment,
  validateEventRepository
} from "./core.mjs";

function output(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return Promise.resolve();
  return appendFile(
    path,
    `${name}=${String(value).replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A")}\n`
  );
}

async function outputs(values = {}) {
  const defaults = {
    decision: "",
    confidence: "",
    number: "",
    cached: false,
    skipped: false,
    stale: false
  };
  await Promise.all(Object.entries({ ...defaults, ...values }).map(([name, value]) => output(name, value)));
}

function runUrl() {
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return repository && runId ? `${server}/${repository}/actions/runs/${runId}` : undefined;
}

async function publishCheck(api, snapshot, {
  status = "completed",
  decision = "needs_human",
  summary,
  details,
  checkId
}) {
  if (snapshot.kind !== "pull_request" || !/^[0-9a-f]{40}$/u.test(snapshot.sourceSha)) return null;
  const body = {
    name: CHECK_NAME,
    head_sha: snapshot.sourceSha,
    status,
    ...(status === "completed" ? { conclusion: checkConclusion(decision) } : {}),
    ...(runUrl() ? { details_url: runUrl() } : {}),
    output: {
      title: `Odinn Maintainer: ${safeMarkdown(status === "completed" ? decision.replaceAll("_", " ") : "reviewing", 100)}`,
      summary: safeMarkdown(summary || "", 65_000),
      text: safeMarkdown(details || "", 65_000)
    }
  };
  const existingId =
    Number(checkId || 0) ||
    Number([...(snapshot.maintainerChecks || [])].reverse().find((check) => check.id)?.id || 0);
  return existingId ? api.updateCheckRun(existingId, body) : api.createCheckRun(body);
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const payload = eventPath ? JSON.parse(await readFile(eventPath, "utf8")) : {};
  const repository = process.env.GITHUB_REPOSITORY;
  const target = resolveTarget({
    eventName,
    payload,
    manualNumber: process.env.ODINN_MAINTAINER_NUMBER
  });
  validateEventRepository({ payload, repository, target });
  const api = new GitHubApi({ token: process.env.GITHUB_TOKEN, repository });
  const model = process.env.ODINN_MAINTAINER_MODEL || "gpt-5.5";
  const trustedLogin = process.env.ODINN_MAINTAINER_BOT_LOGIN || "github-actions[bot]";
  const snapshot = await buildSnapshot(api, target);
  const policy = evaluatePolicy(snapshot, { force: eventName === "workflow_dispatch" });

  if (!policy.reviewable) {
    await publishCheck(api, snapshot, {
      decision: "skipped",
      summary: `Skipped before model spend: ${policy.reason}.`,
      details: "The maintainer published this deterministic skipped result without calling the model."
    });
    await outputs({ skipped: true, number: snapshot.number, decision: "skipped", confidence: "not_applicable" });
    console.log(JSON.stringify({
      ok: true,
      repository,
      number: snapshot.number,
      kind: snapshot.kind,
      skipped: true,
      reason: policy.reason
    }));
    return;
  }

  const cached = findReusableReview(snapshot, { model, trustedLogin });
  if (cached) {
    await publishCheck(api, snapshot, {
      decision: cached.decision,
      summary: "Reused the prior keep-open review for the unchanged complete context.",
      details: "The cache is bound to repository content, discussion, files, checks, policy, prompt, and model with a seven-day expiry."
    });
    await outputs({
      cached: true,
      decision: cached.decision,
      confidence: "cached",
      number: snapshot.number
    });
    console.log(JSON.stringify({
      ok: true,
      repository,
      number: snapshot.number,
      kind: snapshot.kind,
      cached: true,
      decision: cached.decision
    }));
    return;
  }

  const activeCheck = await publishCheck(api, snapshot, {
    status: "in_progress",
    summary: "Reviewing the current complete GitHub context.",
    details: snapshot.complete
      ? "The review is bound to the current item state."
      : "The available context is incomplete; the result will require human review."
  });
  const activeCheckId = Number(activeCheck?.id || 0);

  let review;
  try {
    review = await reviewWithOAuthModel(snapshot, {
      oauthJson: process.env.ODINN_OPENAI_OAUTH_JSON,
      model,
      tokenUrl: process.env.ODINN_OPENAI_OAUTH_TOKEN_URL || "https://auth.openai.com/oauth/token",
      clientId: process.env.ODINN_OPENAI_OAUTH_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann",
      baseUrl: process.env.ODINN_OPENAI_CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex",
      originator: process.env.ODINN_OPENAI_ORIGINATOR || "odinn-maintainer",
      clientVersion: process.env.ODINN_OPENAI_CLIENT_VERSION || "4.0.3"
    });
  } catch (error) {
    await publishCheck(api, snapshot, {
      decision: "needs_human",
      summary: "The automated review did not complete.",
      details: `Failure class: ${safeMarkdown(error instanceof Error ? error.name : "Error", 80)}. Use the workflow run for trusted diagnostics.`,
      checkId: activeCheckId
    });
    throw error;
  }

  const liveSnapshot = await buildSnapshot(api, target);
  if (snapshotDigest(snapshot) !== snapshotDigest(liveSnapshot)) {
    await publishCheck(api, snapshot, {
      decision: "needs_human",
      summary: "The item changed while it was being reviewed.",
      details: "No model-authored comment was published. A fresh event will review the current state.",
      checkId: activeCheckId
    });
    await outputs({
      stale: true,
      number: snapshot.number,
      decision: "needs_human",
      confidence: "stale"
    });
    console.log(JSON.stringify({
      ok: true,
      repository,
      number: snapshot.number,
      kind: snapshot.kind,
      stale: true,
      reason: "item changed during review",
      published: false
    }));
    return;
  }

  try {
    await upsertComment(
      api,
      liveSnapshot,
      renderComment(liveSnapshot, review, { model }),
      { trustedLogin }
    );
    await publishCheck(api, liveSnapshot, {
      decision: review.decision,
      summary: review.summary,
      details: `${review.reason}\n\nRecommended next step: ${review.recommendedNextStep}`,
      checkId: activeCheckId
    });
  } catch (error) {
    await publishCheck(api, snapshot, {
      decision: "needs_human",
      summary: "The review result could not be published safely.",
      details: `Failure class: ${safeMarkdown(error instanceof Error ? error.name : "Error", 80)}. No close, label, branch, or merge action was attempted.`,
      checkId: activeCheckId
    });
    throw error;
  }
  await outputs({
    decision: review.decision,
    confidence: review.confidence,
    number: liveSnapshot.number
  });
  console.log(JSON.stringify({
    ok: true,
    repository,
    number: liveSnapshot.number,
    kind: liveSnapshot.kind,
    decision: review.decision,
    confidence: review.confidence
  }));
}

main().catch((error) => {
  console.error(`Odinn Maintainer failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
