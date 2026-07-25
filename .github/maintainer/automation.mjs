import { createHash } from "node:crypto";
import {
  MAX_REPAIR_FILES,
  MAX_REPAIR_FILE_BYTES,
  MAX_REPAIR_TOTAL_BYTES,
  snapshotDigest,
  validateRepositoryPath,
  validateReview
} from "./core.mjs";

export const PLAN_VERSION = 1;
export const PLAN_TTL_MS = 15 * 60 * 1_000;
export const DECISION_LABELS = Object.freeze({
  keep_open: {
    name: "odinn:reviewed",
    color: "2da44e",
    description: "Odinn Maintainer completed a keep-open review."
  },
  needs_human: {
    name: "odinn:needs-human",
    color: "bf8700",
    description: "Odinn Maintainer requires a human decision."
  },
  close_candidate: {
    name: "odinn:close-candidate",
    color: "cf222e",
    description: "Odinn Maintainer found a guarded close candidate."
  }
});
export const CLOSE_OPT_IN_LABEL = "odinn:allow-close";
export const MERGE_OPT_IN_LABEL = "odinn:allow-merge";
export const REPAIR_OPT_IN_LABEL = "odinn:allow-repair";
const AUTHORIZED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const PLAN_KEYS = [
  "version",
  "repository",
  "target",
  "snapshotDigest",
  "sourceSha",
  "model",
  "createdAt",
  "mode",
  "decision",
  "confidence",
  "review",
  "repairBase"
];

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an unexpected schema`);
  }
}

function boundedString(value, label, limit, { empty = false } = {}) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > limit || (!empty && !value.trim())) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function hasLabel(snapshot, label) {
  return (snapshot.labels || []).some((value) => String(value).toLowerCase() === label);
}

function authorizedCommand(snapshot, action, actor) {
  if (snapshot.completeness?.comments === false) return null;
  const comments = [...(snapshot.allComments || []), ...(snapshot.comments || [])]
    .sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)));
  for (const comment of comments.reverse()) {
    if (!AUTHORIZED_ASSOCIATIONS.has(String(comment.authorAssociation || "").toUpperCase())) continue;
    if (String(comment.author || "").toLowerCase() !== String(actor || "").toLowerCase()) continue;
    const body = String(comment.body || "").trim();
    if (action === "close" && /^\/odinn-maintainer close$/iu.test(body)) return comment;
    if (action === "repair" && /^\/odinn-maintainer repair$/iu.test(body)) return comment;
    const merge = /^\/odinn-maintainer merge ([0-9a-f]{40})$/iu.exec(body);
    if (action === "merge" && merge?.[1]?.toLowerCase() === String(snapshot.sourceSha).toLowerCase()) {
      return comment;
    }
  }
  return null;
}

export function validateRepairPath(value) {
  const path = validateRepositoryPath(value);
  const lower = path.toLowerCase();
  if (!/^(docs|test|tests)\//u.test(lower)) {
    throw new Error("phase-one repair path is not in the checked-in docs/tests allowlist");
  }
  if (
    lower.startsWith(".forgejo/") ||
    lower.startsWith(".odinn/") ||
    /(^|\/)(manifests?|locks?|scripts?|security|auth|policy)(\/|$)/u.test(lower) ||
    /(^|\/)\.git[^/]*(\/|$)/u.test(lower)
  ) {
    throw new Error("repair path is denied by safety policy");
  }
  return path;
}

function validateRepairProse(value, label, limit) {
  const text = boundedString(value, label, limit);
  if (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(text) ||
    /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[opsu]_|sk-)[a-zA-Z0-9_-]{12,}|\b(?:password|secret|token)\s*[:=])/iu.test(text) ||
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+/iu.test(text)
  ) {
    throw new Error(`${label} contains forbidden control, credential, or closing text`);
  }
  return text;
}

export function enabled(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false" || value === "" || value == null) return false;
  throw new Error("automation inputs must be true or false");
}

export function capabilityAllowed({ global, capability, actorAuthorized }) {
  return Boolean(global && capability && actorAuthorized);
}

export function buildPlan({
  repository,
  snapshot,
  model,
  mode,
  decision,
  confidence,
  review = null,
  repairBase = null,
  createdAt = new Date().toISOString()
}) {
  return validatePlan({
    version: PLAN_VERSION,
    repository,
    target: { kind: snapshot.kind, number: snapshot.number },
    snapshotDigest: snapshotDigest(snapshot),
    sourceSha: snapshot.sourceSha,
    model,
    createdAt,
    mode,
    decision,
    confidence,
    review,
    repairBase
  }, { now: Date.parse(createdAt) });
}

export function validatePlan(value, { now = Date.now() } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plan must be an object");
  exactKeys(value, PLAN_KEYS, "plan");
  if (value.version !== PLAN_VERSION) throw new Error("plan version is unsupported");
  const repository = boundedString(value.repository, "plan repository", 240);
  if (!/^[^/]+\/[^/]+$/u.test(repository)) throw new Error("plan repository is invalid");
  if (!value.target || typeof value.target !== "object" || Array.isArray(value.target)) {
    throw new Error("plan target is invalid");
  }
  exactKeys(value.target, ["kind", "number"], "plan target");
  if (!["issue", "pull_request"].includes(value.target.kind)) throw new Error("plan target kind is invalid");
  if (!Number.isInteger(value.target.number) || value.target.number <= 0) throw new Error("plan target number is invalid");
  const digest = boundedString(value.snapshotDigest, "plan digest", 64);
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error("plan digest is invalid");
  boundedString(value.sourceSha, "plan source", 100);
  boundedString(value.model, "plan model", 100);
  const created = Date.parse(value.createdAt);
  if (!Number.isFinite(created) || created > now + 60_000 || now - created > PLAN_TTL_MS) {
    throw new Error("plan is expired or future-dated");
  }
  if (!["skipped", "cached", "review"].includes(value.mode)) throw new Error("plan mode is invalid");
  if (!["skipped", "keep_open", "needs_human", "close_candidate"].includes(value.decision)) {
    throw new Error("plan decision is invalid");
  }
  boundedString(value.confidence, "plan confidence", 40);
  const review = value.review === null
    ? null
    : validateReview(value.review, { requireOfferedRepair: false });
  if ((value.mode === "review") !== Boolean(review)) throw new Error("review plan must contain exactly one review");
  if (review && (review.decision !== value.decision || review.confidence !== value.confidence)) {
    throw new Error("plan review summary does not match its review");
  }
  let repairBase = null;
  if (value.repairBase !== null) {
    if (!value.repairBase || typeof value.repairBase !== "object" || Array.isArray(value.repairBase)) {
      throw new Error("repair base is invalid");
    }
    exactKeys(value.repairBase, ["branch", "sha"], "repair base");
    const branch = boundedString(value.repairBase.branch, "repair base branch", 240);
    if (!/^[a-zA-Z0-9._/-]+$/u.test(branch) || branch.includes("..") || branch.startsWith("/")) {
      throw new Error("repair base branch is invalid");
    }
    const sha = boundedString(value.repairBase.sha, "repair base SHA", 40);
    if (!/^[0-9a-f]{40}$/iu.test(sha)) throw new Error("repair base SHA is invalid");
    repairBase = { branch, sha: sha.toLowerCase() };
  }
  if (review?.repair.requested && !repairBase) throw new Error("requested repair has no base");
  if (review?.repair.requested) {
    validateRepairProse(review.repair.title, "repair title", 120);
    validateRepairProse(review.repair.body, "repair body", 2_000);
  }
  for (const change of review?.repair.changes || []) {
    validateRepairPath(change.path);
    validateRepairProse(
      `${change.oldText}${change.newText}${change.content}`,
      "repair change",
      MAX_REPAIR_FILE_BYTES * 3
    );
  }
  return {
    ...value,
    repository,
    snapshotDigest: digest,
    review,
    repairBase
  };
}

function candidatePaths(snapshot) {
  const paths = [];
  if (snapshot.kind === "pull_request") {
    paths.push(...(snapshot.changedFiles || []).map((file) => file.filename));
  }
  const prose = `${snapshot.title || ""}\n${snapshot.body || ""}`;
  for (const match of prose.matchAll(/`([a-zA-Z0-9._/-]{1,240})`/gu)) paths.push(match[1]);
  const unique = [];
  for (const candidate of paths) {
    try {
      const path = validateRepairPath(candidate);
      if (!unique.includes(path)) unique.push(path);
    } catch {
      // Untrusted path-like text is ignored.
    }
  }
  return unique.slice(0, MAX_REPAIR_FILES);
}

export async function collectRepairCandidates(api, snapshot, { enabled: allowRepair }) {
  if (!allowRepair || !hasLabel(snapshot, REPAIR_OPT_IN_LABEL)) {
    return { candidates: [], base: null };
  }
  const paths = candidatePaths(snapshot);
  if (!paths.length) return { candidates: [], base: null };
  const repository = await api.repositoryInfo();
  const branch = snapshot.kind === "pull_request"
    ? snapshot.baseRef
    : String(repository?.default_branch || "");
  const sha = snapshot.kind === "pull_request"
    ? snapshot.baseSha
    : String((await api.gitRef(`heads/${branch}`))?.object?.sha || "");
  if (!branch || !/^[0-9a-f]{40}$/iu.test(sha)) throw new Error("repair base could not be resolved");
  const candidates = [];
  let totalBytes = 0;
  for (const path of paths) {
    const file = await api.content(path, sha);
    if (file?.type !== "file" || file?.encoding !== "base64" || !/^[0-9a-f]{40}$/iu.test(String(file.sha || ""))) {
      throw new Error("repair candidate was not a regular Git blob");
    }
    const bytes = Buffer.from(String(file.content || "").replace(/\s/gu, ""), "base64");
    if (bytes.length > MAX_REPAIR_FILE_BYTES || bytes.includes(0)) {
      throw new Error("repair candidate is binary or exceeds its bound");
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_REPAIR_TOTAL_BYTES) throw new Error("repair candidates exceed their total bound");
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error("repair candidate is not UTF-8 text");
    candidates.push({ path, sha: String(file.sha).toLowerCase(), content });
  }
  return { candidates, base: { branch, sha: sha.toLowerCase() } };
}

export function closeGuard(snapshot, review, { allow, actor }) {
  if (!allow) return { allowed: false, reason: "close capability disabled" };
  if (!hasLabel(snapshot, CLOSE_OPT_IN_LABEL)) return { allowed: false, reason: "close opt-in label absent" };
  if (!snapshot.complete || snapshot.state !== "open") return { allowed: false, reason: "item is not complete and open" };
  if (!authorizedCommand(snapshot, "close", actor)) return { allowed: false, reason: "authorized close command absent" };
  if (review.decision !== "close_candidate" || review.confidence !== "high" || review.evidence.length < 2) {
    return { allowed: false, reason: "review does not satisfy close evidence policy" };
  }
  if (review.closeReason === "duplicate" && review.relatedNumber === snapshot.number) {
    return { allowed: false, reason: "duplicate target cannot reference itself" };
  }
  return { allowed: true, reason: review.closeReason };
}

export function mergeGuard(snapshot, review, { allow, actor }) {
  if (!allow) return { allowed: false, reason: "merge capability disabled" };
  if (!hasLabel(snapshot, MERGE_OPT_IN_LABEL)) return { allowed: false, reason: "merge opt-in label absent" };
  if (snapshot.kind !== "pull_request" || !snapshot.complete || snapshot.state !== "open" || snapshot.draft) {
    return { allowed: false, reason: "pull request is not complete, open, and ready" };
  }
  if (
    String(snapshot.headRepo).toLowerCase() !== String(snapshot.repo).toLowerCase() ||
    String(snapshot.baseRepo).toLowerCase() !== String(snapshot.repo).toLowerCase()
  ) {
    return { allowed: false, reason: "pull request is not same-repository" };
  }
  if (!snapshot.mergeable || snapshot.mergeableState !== "clean") {
    return { allowed: false, reason: "GitHub does not report a clean merge" };
  }
  if (!authorizedCommand(snapshot, "merge", actor)) {
    return { allowed: false, reason: "authorized exact-head merge command absent" };
  }
  if (!snapshot.checks.length || snapshot.checks.some((check) =>
    check.status !== "completed" || !["success", "neutral", "skipped"].includes(check.conclusion)
  )) {
    return { allowed: false, reason: "checks are not complete or contain a failure" };
  }
  if (review.decision !== "keep_open" || review.confidence !== "high") {
    return { allowed: false, reason: "review does not satisfy merge policy" };
  }
  return { allowed: true, reason: "same-repository guarded merge" };
}

export function repairGuard(snapshot, review, { allow, repairBase, actor }) {
  if (!allow) return { allowed: false, reason: "repair capability disabled" };
  if (!hasLabel(snapshot, REPAIR_OPT_IN_LABEL)) return { allowed: false, reason: "repair opt-in label absent" };
  if (!snapshot.complete || snapshot.state !== "open") return { allowed: false, reason: "item is not complete and open" };
  if (!authorizedCommand(snapshot, "repair", actor)) {
    return { allowed: false, reason: "authorized repair command absent" };
  }
  if (!repairBase || !review.repair.requested) return { allowed: false, reason: "no bounded repair was requested" };
  return { allowed: true, reason: "bounded repair plan" };
}

export async function actorCanMutate(api, actor) {
  if (!/^[a-zA-Z0-9-]{1,100}$/u.test(String(actor || ""))) return false;
  const result = await api.collaboratorPermission(actor);
  return ["admin", "maintain", "write"].includes(String(result?.permission || "").toLowerCase());
}

export async function resolveLiveRepairBase(api, snapshot, plannedBase) {
  if (!plannedBase) throw new Error("repair plan has no recorded base");
  const repository = await api.repositoryInfo();
  const branch = snapshot.kind === "pull_request"
    ? snapshot.baseRef
    : String(repository?.default_branch || "");
  const tip = await api.gitRef(`heads/${branch}`);
  const sha = String(tip?.object?.sha || "").toLowerCase();
  if (!branch || !/^[0-9a-f]{40}$/iu.test(sha) || sha !== plannedBase.sha) {
    throw new Error("repair base branch tip changed after planning");
  }
  return { branch, sha };
}

export async function syncDecisionLabel(api, snapshot, decision) {
  const desired = DECISION_LABELS[decision] || DECISION_LABELS.needs_human;
  const definitions = await api.repositoryLabels();
  if (!definitions.complete) throw new Error("repository label inventory is incomplete");
  const known = new Set(definitions.items.map((label) => String(label.name).toLowerCase()));
  if (!known.has(desired.name)) await api.createRepositoryLabel(desired);
  const current = new Set((snapshot.labels || []).map((label) => String(label).toLowerCase()));
  for (const definition of Object.values(DECISION_LABELS)) {
    if (definition.name !== desired.name && current.has(definition.name)) {
      await api.removeLabel(snapshot.number, definition.name);
    }
  }
  if (!current.has(desired.name)) await api.addLabels(snapshot.number, [desired.name]);
  return desired.name;
}

export async function applyClose(api, snapshot, review) {
  if (snapshot.kind === "pull_request") return api.closePull(snapshot.number);
  const reason = review.closeReason === "resolved" ? "completed" : "not_planned";
  return api.closeIssue(snapshot.number, reason);
}

export async function applyMerge(api, snapshot, method) {
  if (method !== "squash") throw new Error("guarded merges are squash-only");
  const pull = await api.pull(snapshot.number);
  if (
    String(pull?.head?.sha).toLowerCase() !== String(snapshot.sourceSha).toLowerCase() ||
    String(pull?.head?.repo?.full_name).toLowerCase() !== String(snapshot.repo).toLowerCase() ||
    String(pull?.base?.repo?.full_name).toLowerCase() !== String(snapshot.repo).toLowerCase() ||
    pull?.draft ||
    pull?.mergeable !== true ||
    pull?.mergeable_state !== "clean"
  ) {
    throw new Error("pull request changed or is no longer a clean same-repository merge");
  }
  const [checks, protection] = await Promise.all([
    api.checks(snapshot.sourceSha),
    api.branchProtection(snapshot.baseRef)
  ]);
  if (!checks.complete) throw new Error("live check inventory is incomplete");
  const required = protection?.required_status_checks;
  const requiredChecks = Array.isArray(required?.checks) && required.checks.length
    ? required.checks.map((check) => ({
      context: String(check?.context || ""),
      appId: check?.app_id == null
        ? null
        : Number.isInteger(Number(check.app_id))
          ? Number(check.app_id)
          : null
    }))
    : (Array.isArray(required?.contexts) ? required.contexts : []).map((context) => ({
      context: String(context || ""),
      appId: null
    }));
  if (required?.strict !== true || !requiredChecks.length || requiredChecks.some((check) => !check.context)) {
    throw new Error("strict branch protection with required checks is mandatory");
  }
  for (const requiredCheck of requiredChecks) {
    const check = checks.items.find((item) =>
      item.name === requiredCheck.context &&
      (requiredCheck.appId === null || Number(item?.app?.id) === requiredCheck.appId)
    );
    if (check?.status !== "completed" || check?.conclusion !== "success") {
      throw new Error("a branch-protection required check is not successful");
    }
  }
  const result = await api.mergePull(snapshot.number, { sha: snapshot.sourceSha, method: "squash" });
  if (result?.merged !== true) throw new Error("GitHub did not confirm the guarded merge");
  return result;
}

function applyReplacement(original, change) {
  if (change.mode === "replace_file") return change.content;
  const first = original.indexOf(change.oldText);
  if (first < 0 || original.indexOf(change.oldText, first + change.oldText.length) >= 0) {
    throw new Error("repair text anchor must occur exactly once");
  }
  return `${original.slice(0, first)}${change.newText}${original.slice(first + change.oldText.length)}`;
}

export async function applyRepair(api, snapshot, review, repairBase) {
  const prepared = [];
  let totalBytes = 0;
  for (const change of review.repair.changes) {
    validateRepairPath(change.path);
    const current = await api.content(change.path, repairBase.sha);
    if (current?.type !== "file" || current?.encoding !== "base64" || String(current.sha).toLowerCase() !== change.expectedSha) {
      throw new Error("repair file changed after planning");
    }
    const original = Buffer.from(String(current.content || "").replace(/\s/gu, ""), "base64").toString("utf8");
    const content = applyReplacement(original, change);
    const changedLines = change.mode === "replace_text"
      ? Math.max(change.oldText.split("\n").length, change.newText.split("\n").length)
      : Math.max(original.split("\n").length, content.split("\n").length);
    if (changedLines > 200) throw new Error("repair change exceeds the line bound");
    if (content.split("\n").some((line) => line.length > 2_000)) {
      throw new Error("repair output exceeds the line-length bound");
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (!bytes || bytes > MAX_REPAIR_FILE_BYTES) throw new Error("repair output exceeds its file bound");
    totalBytes += bytes;
    if (totalBytes > MAX_REPAIR_TOTAL_BYTES) throw new Error("repair output exceeds its total bound");
    prepared.push({ path: change.path, content });
  }

  const baseCommit = await api.gitCommit(repairBase.sha);
  const baseTree = String(baseCommit?.tree?.sha || "");
  if (!/^[0-9a-f]{40}$/iu.test(baseTree)) throw new Error("repair base tree is invalid");
  const tree = [];
  for (const file of prepared) {
    const blob = await api.createGitBlob(file.content);
    if (!/^[0-9a-f]{40}$/iu.test(String(blob?.sha || ""))) throw new Error("repair blob creation failed");
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await api.createGitTree(baseTree, tree);
  const newTreeSha = String(newTree?.sha || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(newTreeSha)) throw new Error("repair tree creation failed");

  const repairDigest = createHash("sha256")
    .update(`${repairBase.sha}:${newTreeSha}`)
    .digest("hex")
    .slice(0, 12);
  const branch = `odinn-maintainer/repair-${snapshot.number}-${repairDigest}`;
  const owner = String(snapshot.repo).split("/")[0];
  const pullTitle = `docs: bounded maintainer repair for #${snapshot.number}`;
  const pullBody = [
    `Proposed bounded Odinn Maintainer repair for #${snapshot.number}.`,
    "",
    "This branch was created after an authorized maintainer repair command.",
    "Review the exact diff and approve its workflows before merging."
  ].join("\n");

  const verifyRef = async (ref) => {
    const sha = String(ref?.object?.sha || "").toLowerCase();
    if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("existing repair branch has an invalid tip");
    const commit = await api.gitCommit(sha);
    const parentShas = Array.isArray(commit?.parents)
      ? commit.parents.map((parent) => String(parent?.sha || "").toLowerCase())
      : [];
    if (
      String(commit?.tree?.sha || "").toLowerCase() !== newTreeSha ||
      parentShas.length !== 1 ||
      parentShas[0] !== repairBase.sha
    ) {
      throw new Error("existing repair branch does not match the exact planned tree and parent");
    }
    return sha;
  };

  const verifyPull = (pull, refSha) => {
    if (
      !pull?.html_url ||
      !Number.isInteger(Number(pull.number)) ||
      String(pull?.head?.ref || "") !== branch ||
      String(pull?.head?.sha || "").toLowerCase() !== refSha ||
      String(pull?.head?.repo?.full_name || "").toLowerCase() !== String(snapshot.repo).toLowerCase() ||
      String(pull?.base?.ref || "") !== repairBase.branch ||
      String(pull?.base?.repo?.full_name || "").toLowerCase() !== String(snapshot.repo).toLowerCase()
    ) {
      throw new Error("existing repair pull request does not match the exact planned branch");
    }
    return {
      branch,
      number: Number(pull.number),
      url: String(pull.html_url)
    };
  };

  let existingRef = null;
  try {
    existingRef = await api.gitRef(`heads/${branch}`);
  } catch (error) {
    if (!/HTTP 404/u.test(String(error instanceof Error ? error.message : error))) throw error;
  }
  if (existingRef?.object?.sha) {
    const refSha = await verifyRef(existingRef);
    const existingPulls = await api.pullsForHead(owner, branch);
    if (Array.isArray(existingPulls) && existingPulls.length) {
      return verifyPull(existingPulls[0], refSha);
    }
    const pull = await api.createPull({ title: pullTitle, body: pullBody, head: branch, base: repairBase.branch });
    return verifyPull(pull, refSha);
  }

  const commit = await api.createGitCommit({
    message: `fix: apply bounded maintainer repair for #${snapshot.number}`,
    tree: newTreeSha,
    parents: [repairBase.sha]
  });
  const commitSha = String(commit?.sha || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error("repair commit creation failed");
  try {
    await api.createGitRef(`refs/heads/${branch}`, commitSha);
  } catch (error) {
    const reconciled = await api.gitRef(`heads/${branch}`);
    const reconciledSha = await verifyRef(reconciled);
    if (reconciledSha !== commitSha) throw error;
  }
  try {
    const pull = await api.createPull({ title: pullTitle, body: pullBody, head: branch, base: repairBase.branch });
    return verifyPull(pull, commitSha);
  } catch (error) {
    const existingPulls = await api.pullsForHead(owner, branch);
    if (!Array.isArray(existingPulls) || !existingPulls.length) throw error;
    return verifyPull(existingPulls[0], commitSha);
  }
}
