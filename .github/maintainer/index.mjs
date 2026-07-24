import { appendFile, readFile } from "node:fs/promises";
import { buildSnapshot, CHECK_NAME, checkConclusion, evaluatePolicy, findReusableReview, GitHubApi, renderComment, resolveTarget, reviewWithOAuthModel, upsertComment } from "./core.mjs";

function output(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  return appendFile(path, `${name}=${String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}\n`);
}

function runUrl() {
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const runId = process.env.GITHUB_RUN_ID;
  return runId ? `${server}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}` : undefined;
}

async function publishCheck(api, snapshot, { decision, summary, details }) {
  if (snapshot.kind !== "pull_request" || !/^[0-9a-f]{40}$/u.test(snapshot.sourceSha)) return null;
  const body = {
    name: CHECK_NAME,
    head_sha: snapshot.sourceSha,
    status: "completed",
    conclusion: checkConclusion(decision),
    ...(runUrl() ? { details_url: runUrl() } : {}),
    output: {
      title: `Odinn Maintainer: ${decision.replaceAll("_", " ")}`,
      summary: String(summary || "").slice(0, 65_000),
      text: String(details || "").slice(0, 65_000)
    }
  };
  const existing = snapshot.checks.find((check) => check.name === CHECK_NAME && check.id);
  return existing ? api.updateCheckRun(existing.id, body) : api.createCheckRun(body);
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const payload = eventPath ? JSON.parse(await readFile(eventPath, "utf8")) : {};
  const repository = process.env.GITHUB_REPOSITORY;
  const target = resolveTarget({ eventName, payload, manualNumber: process.env.ODINN_MAINTAINER_NUMBER });
  const api = new GitHubApi({ token: process.env.GITHUB_TOKEN, repository });
  const snapshot = await buildSnapshot(api, target);
  const policy = evaluatePolicy(snapshot, { force: eventName === "workflow_dispatch" });
  if (!policy.reviewable) {
    await publishCheck(api, snapshot, { decision: "skipped", summary: `Skipped before model spend: ${policy.reason}.`, details: "No model call or GitHub mutation was requested." });
    await output("skipped", true);
    console.log(JSON.stringify({ ok: true, repository, number: snapshot.number, kind: snapshot.kind, skipped: true, reason: policy.reason }));
    return;
  }
  const cached = findReusableReview(snapshot);
  if (cached) {
    await publishCheck(api, snapshot, { decision: cached.decision, summary: "Reused the prior keep-open review for the unchanged item revision.", details: "The review cache is keyed by item kind, number, and source revision. No model call was made." });
    await output("cached", true);
    await output("decision", cached.decision);
    await output("confidence", "cached");
    await output("number", snapshot.number);
    console.log(JSON.stringify({ ok: true, repository, number: snapshot.number, kind: snapshot.kind, cached: true, decision: cached.decision }));
    return;
  }
  const model = process.env.ODINN_MAINTAINER_MODEL || "gpt-5.5";
  const review = await reviewWithOAuthModel(snapshot, {
    oauthJson: process.env.ODINN_OPENAI_OAUTH_JSON,
    model,
    tokenUrl: process.env.ODINN_OPENAI_OAUTH_TOKEN_URL || "https://auth.openai.com/oauth/token",
    clientId: process.env.ODINN_OPENAI_OAUTH_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann",
    baseUrl: process.env.ODINN_OPENAI_CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex",
    originator: process.env.ODINN_OPENAI_ORIGINATOR || "openclaw",
    clientVersion: process.env.ODINN_OPENAI_CLIENT_VERSION || "2026.6.11"
  });
  await upsertComment(api, snapshot, renderComment(snapshot, review, { model }));
  await publishCheck(api, snapshot, { decision: review.decision, summary: review.summary, details: `${review.reason}\n\nRecommended next step: ${review.recommendedNextStep}` });
  await output("decision", review.decision);
  await output("confidence", review.confidence);
  await output("cached", false);
  await output("skipped", false);
  await output("number", snapshot.number);
  console.log(JSON.stringify({ ok: true, repository, number: snapshot.number, kind: snapshot.kind, decision: review.decision, confidence: review.confidence }));
}

main().catch((error) => {
  console.error(`Odinn Maintainer failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
