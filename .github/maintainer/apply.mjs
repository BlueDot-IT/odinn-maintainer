import { appendFile, readFile } from "node:fs/promises";
import {
  buildSnapshot,
  CHECK_NAME,
  checkConclusion,
  findReusableReview,
  GitHubApi,
  renderComment,
  safeMarkdown,
  snapshotDigest,
  upsertComment
} from "./core.mjs";
import {
  applyClose,
  applyMerge,
  applyRepair,
  actorCanMutate,
  capabilityAllowed,
  closeGuard,
  enabled,
  mergeGuard,
  repairGuard,
  resolveLiveRepairBase,
  syncDecisionLabel,
  validatePlan
} from "./automation.mjs";

async function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(
    process.env.GITHUB_OUTPUT,
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
    stale: false,
    action: "none",
    label: "",
    closed: false,
    merged: false,
    "repair-pull-request": "",
    "repair-branch": ""
  };
  await Promise.all(Object.entries({ ...defaults, ...values }).map(([name, value]) => output(name, value)));
}

function runUrl() {
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return repository && runId ? `${server}/${repository}/actions/runs/${runId}` : undefined;
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
      title: `Odinn Maintainer: ${safeMarkdown(decision.replaceAll("_", " "), 100)}`,
      summary: safeMarkdown(summary || "", 65_000),
      text: safeMarkdown(details || "", 65_000)
    }
  };
  const existingId = Number([...(snapshot.maintainerChecks || [])].reverse().find((check) => check.id)?.id || 0);
  return existingId ? api.updateCheckRun(existingId, body) : api.createCheckRun(body);
}

async function readPlan(path) {
  if (!path) throw new Error("plan artifact path is required");
  const raw = await readFile(path);
  if (raw.length > 150_000) throw new Error("plan artifact exceeds its bound");
  try {
    return validatePlan(JSON.parse(raw.toString("utf8")));
  } catch (error) {
    throw new Error(`plan artifact is invalid: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

async function main() {
  if (
    process.env.ODINN_OPENAI_OAUTH_JSON ||
    process.env.OPENAI_API_KEY ||
    process.env.CODEX_API_KEY
  ) {
    throw new Error("deterministic apply must not receive model credentials");
  }
  const plan = await readPlan(process.env.ODINN_MAINTAINER_PLAN_PATH);
  const repository = process.env.GITHUB_REPOSITORY;
  if (String(repository).toLowerCase() !== plan.repository.toLowerCase()) {
    throw new Error("plan repository does not match GITHUB_REPOSITORY");
  }
  const api = new GitHubApi({ token: process.env.GITHUB_TOKEN, repository });
  const automationEnabled = enabled(process.env.ODINN_MAINTAINER_ALLOW_AUTOMATION);
  const actor = process.env.GITHUB_ACTOR || "";
  const authorizedActor = automationEnabled ? await actorCanMutate(api, actor) : false;
  const live = await buildSnapshot(api, plan.target);
  if (snapshotDigest(live) !== plan.snapshotDigest || live.sourceSha !== plan.sourceSha) {
    await publishCheck(api, live, {
      decision: "needs_human",
      summary: "The item changed after planning.",
      details: "No planned label, close, merge, branch, commit, or pull request mutation was applied."
    });
    await outputs({
      decision: "needs_human",
      confidence: "stale",
      number: live.number,
      stale: true
    });
    return;
  }
  if (plan.mode === "skipped") {
    await publishCheck(api, live, {
      decision: "skipped",
      summary: "Skipped by deterministic review policy.",
      details: "No model-authored or autonomous mutation was applied."
    });
    await outputs({
      decision: "skipped",
      confidence: "not_applicable",
      number: live.number,
      skipped: true
    });
    return;
  }
  if (plan.mode === "cached") {
    const cached = findReusableReview(live, {
      model: plan.model,
      trustedLogin: process.env.ODINN_MAINTAINER_BOT_LOGIN || "github-actions[bot]"
    });
    if (!cached) throw new Error("cached plan no longer has a trusted live cache marker");
    let label = "";
    if (automationEnabled && authorizedActor && enabled(process.env.ODINN_MAINTAINER_ALLOW_LABELS)) {
      label = await syncDecisionLabel(api, live, "keep_open");
    }
    await publishCheck(api, live, {
      decision: "keep_open",
      summary: "Reused the prior keep-open review for unchanged complete context.",
      details: "No model call or autonomous close, merge, or repair was applied."
    });
    await outputs({
      decision: "keep_open",
      confidence: "cached",
      number: live.number,
      cached: true,
      label
    });
    return;
  }

  const review = plan.review;
  await upsertComment(
    api,
    live,
    renderComment(live, review, { model: plan.model, reviewedAt: plan.createdAt }),
    { trustedLogin: process.env.ODINN_MAINTAINER_BOT_LOGIN || "github-actions[bot]" }
  );

  const guards = [
    {
      action: "close",
      guard: closeGuard(live, review, {
        allow: capabilityAllowed({
          global: automationEnabled,
          capability: enabled(process.env.ODINN_MAINTAINER_ALLOW_CLOSE),
          actorAuthorized: authorizedActor
        }),
        actor
      })
    },
    {
      action: "merge",
      guard: mergeGuard(live, review, {
        allow: capabilityAllowed({
          global: automationEnabled,
          capability: enabled(process.env.ODINN_MAINTAINER_ALLOW_MERGE),
          actorAuthorized: authorizedActor
        }),
        actor
      })
    },
    {
      action: "repair",
      guard: repairGuard(live, review, {
        allow: capabilityAllowed({
          global: automationEnabled,
          capability: enabled(process.env.ODINN_MAINTAINER_ALLOW_REPAIR),
          actorAuthorized: authorizedActor
        }),
        repairBase: plan.repairBase,
        actor
      })
    }
  ].filter((entry) => entry.guard.allowed);
  if (guards.length > 1) throw new Error("multiple autonomous mutations are eligible; refusing ambiguous plan");

  let action = "none";
  let closed = false;
  let merged = false;
  let repairPullRequest = "";
  let repairBranch = "";
  if (guards[0]?.action === "close") {
    await applyClose(api, live, review);
    action = "close";
    closed = true;
  } else if (guards[0]?.action === "merge") {
    await applyMerge(api, live, "squash");
    action = "merge";
    merged = true;
  } else if (guards[0]?.action === "repair") {
    const repairBase = await resolveLiveRepairBase(api, live, plan.repairBase);
    const repair = await applyRepair(api, live, review, repairBase);
    action = "repair";
    repairPullRequest = repair.url;
    repairBranch = repair.branch;
  }

  let label = "";
  if (automationEnabled && authorizedActor && enabled(process.env.ODINN_MAINTAINER_ALLOW_LABELS)) {
    label = await syncDecisionLabel(api, live, review.decision);
  }
  await publishCheck(api, live, {
    decision: review.decision,
    summary: review.summary,
    details: `${review.reason}\n\nRecommended next step: ${review.recommendedNextStep}\n\nDeterministic action: ${action}.`
  });
  await outputs({
    decision: review.decision,
    confidence: review.confidence,
    number: live.number,
    action,
    label,
    closed,
    merged,
    "repair-pull-request": repairPullRequest,
    "repair-branch": repairBranch
  });
  console.log(JSON.stringify({
    ok: true,
    repository,
    number: live.number,
    kind: live.kind,
    decision: review.decision,
    action
  }));
}

main().catch((error) => {
  console.error(`Odinn Maintainer apply failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
