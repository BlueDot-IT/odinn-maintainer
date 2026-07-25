import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildSnapshot,
  evaluatePolicy,
  findReusableReview,
  GitHubApi,
  resolveTarget,
  reviewWithOAuthModel,
  validateEventRepository
} from "./core.mjs";
import {
  buildPlan,
  collectRepairCandidates,
  enabled,
  REPAIR_OPT_IN_LABEL
} from "./automation.mjs";

async function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `${name}=${String(value).replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A")}\n`
  );
}

async function main() {
  if (process.env.GITHUB_TOKEN) {
    throw new Error("planning must not receive the write-capable GitHub token");
  }
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const payload = eventPath ? JSON.parse(await readFile(eventPath, "utf8")) : {};
  const repository = process.env.GITHUB_REPOSITORY;
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const target = resolveTarget({
    eventName,
    payload,
    manualNumber: process.env.ODINN_MAINTAINER_NUMBER
  });
  validateEventRepository({ payload, repository, target });
  const api = new GitHubApi({
    token: process.env.GITHUB_READ_TOKEN,
    repository,
    allowAnonymous: !process.env.GITHUB_READ_TOKEN
  });
  let snapshot = await buildSnapshot(api, target);
  const model = process.env.ODINN_MAINTAINER_MODEL || "gpt-5.5";
  const policy = evaluatePolicy(snapshot, { force: eventName === "workflow_dispatch" });
  let plan;
  if (!policy.reviewable) {
    plan = buildPlan({
      repository,
      snapshot,
      model,
      mode: "skipped",
      decision: "skipped",
      confidence: "not_applicable"
    });
  } else {
    const repairOptedIn = (snapshot.labels || []).some(
      (label) => String(label).toLowerCase() === REPAIR_OPT_IN_LABEL
    );
    const cached = repairOptedIn
      ? null
      : findReusableReview(snapshot, {
        model,
        trustedLogin: process.env.ODINN_MAINTAINER_BOT_LOGIN || "github-actions[bot]"
      });
    if (cached) {
      plan = buildPlan({
        repository,
        snapshot,
        model,
        mode: "cached",
        decision: "keep_open",
        confidence: "cached"
      });
    } else {
      const repair = await collectRepairCandidates(api, snapshot, {
        enabled: enabled(process.env.ODINN_MAINTAINER_ALLOW_AUTOMATION)
          && enabled(process.env.ODINN_MAINTAINER_ALLOW_REPAIR)
      });
      snapshot = { ...snapshot, repairCandidates: repair.candidates };
      const review = await reviewWithOAuthModel(snapshot, {
        oauthJson: process.env.ODINN_OPENAI_OAUTH_JSON,
        model,
        tokenUrl: process.env.ODINN_OPENAI_OAUTH_TOKEN_URL || "https://auth.openai.com/oauth/token",
        clientId: process.env.ODINN_OPENAI_OAUTH_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann",
        baseUrl: process.env.ODINN_OPENAI_CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex",
        originator: process.env.ODINN_OPENAI_ORIGINATOR || "odinn-maintainer",
        clientVersion: process.env.ODINN_OPENAI_CLIENT_VERSION || "4.0.0"
      });
      plan = buildPlan({
        repository,
        snapshot,
        model,
        mode: "review",
        decision: review.decision,
        confidence: review.confidence,
        review,
        repairBase: review.repair.requested ? repair.base : null
      });
    }
  }
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP || "/tmp", "odinn-maintainer-plan-"));
  const planPath = join(directory, "plan.json");
  const serialized = `${JSON.stringify(plan)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 150_000) throw new Error("plan artifact exceeds its bound");
  await writeFile(planPath, serialized, { mode: 0o600, flag: "wx" });
  await output("plan-path", planPath);
  console.log(JSON.stringify({
    ok: true,
    repository,
    number: target.number,
    kind: target.kind,
    mode: plan.mode,
    decision: plan.decision
  }));
}

main().catch((error) => {
  console.error(`Odinn Maintainer planning failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
