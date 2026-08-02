# Odinn Maintainer GitHub Action

This repository owns the separate, reusable GitHub Action used by Odinn. It is
a GitHub-native Odinn Maintainer control plane. The caller repository reacts to
pull requests, issues, completed CI workflows, commands, and a scheduled
reconciliation sweep. This repository discovers a bounded work queue, collects
each target snapshot, asks the configured Codex model for a conservative
structured review, and persists the current decision in one sticky review
comment and one named Check. It never checks out or executes target repository
code.

Before model spend it applies deterministic policy gates for explicit opt-out
labels, bot-authored items, and closed items. It reuses only a recent
`keep_open` result for the same complete repository context. The cache digest
binds the title, body, labels, human discussion, reviews, changed-file patches,
checks, base and head revisions, policy, prompt, and model. Incomplete context
always requires human review and is never cached.

Every pull request review publishes or updates an `Odinn Maintainer` GitHub
Check. The action re-fetches the complete context before publishing model
output. Human-authored or source drift blocks the sticky comment and produces a
neutral result. Volatile check/mergeability drift may update the sticky
decision but can never authorize a mutation; completed-workflow and scheduled
reconciliation then produce a fresh decision from current state.
`needs_human` is neutral and `close_candidate` is action-required.

## Reconciliation and durable state

The `targets` action turns direct events into a one-item queue, maps completed
workflow runs back to their pull requests, and discovers up to 50 recently
updated open pull requests and issues during a scheduled sweep. Scheduled
queues alternate pull requests and issues before filling unused capacity, so
one item type cannot consume every slot. The workflow run number rotates the
starting window by 25 items per sweep, so older entries within each type are
eventually selected without a private cursor database. Caller workflow
concurrency serializes each target. A failed or interrupted run therefore
recovers on the next GitHub event or sweep without a private database.

The bot-owned sticky comment is the durable, repository-visible state record.
It contains the decision, evidence, live check summary, last reconciliation
time, immutable review cache marker, and command help. The named Check links
the decision to the exact head SHA. GitHub Actions runs, summaries, and
artifacts provide the bounded queue history and audit trail.

Supported commands from an owner, member, or collaborator are:

- `/odinn-maintainer review` and `/odinn-maintainer status` to request a fresh
  reconciliation.
- `/odinn-maintainer repair` to request a guarded source/docs/tests repair PR.
- `/odinn-maintainer merge HEAD_SHA` for a guarded one-time merge.
- `/odinn-maintainer automerge HEAD_SHA` to retain merge intent while later
  reconciliations wait for the gates.
- `/odinn-maintainer close` for a guarded close.

## Guarded automation

The original `review` action remains a review-only compatibility surface.
Guarded mutations use two separate actions and two separate jobs:

1. `plan` receives OAuth plus an anonymous or read-only GitHub credential. It
   writes a strict, size-bounded JSON plan and cannot receive `GITHUB_TOKEN`.
2. The caller uploads that plan as an artifact. A later job downloads it.
3. `apply` receives the downloaded plan and the job-scoped write token. It
   rejects OAuth and API-key environment variables, validates the plan's
   schema and 60-minute lifetime, then re-fetches the exact live item before
   any planned mutation.

All autonomous switches default to `false`. `allow-automation` is the global
kill switch; the matching per-capability switch must also be enabled. The event
actor must have `write`, `maintain`, or `admin` permission.

Additional item-level gates are mandatory:

- Close requires `odinn:allow-close`, high-confidence evidence, and an exact
  `/odinn-maintainer close` command created by the authorized event actor.
  Close and repair commands are bound to the exact unedited comment, target,
  source state, and plan snapshot for 60 minutes. Before mutation, `apply`
  writes and re-fetches a bot-authored repository-visible consumption receipt;
  reruns and later events fail closed rather than reuse that command.
- Merge requires `odinn:allow-merge` and
  `/odinn-maintainer merge HEAD_SHA` from that actor. Only same-repository,
  non-draft pull requests with strict branch protection and successful live
  required checks can be squash-merged.
- Repair requires `odinn:allow-repair` and
  `/odinn-maintainer repair`. It can modify only bounded UTF-8 files under
  checked-in `apps/`, `adapters/`, `packages/`, `src/`, `docs/`, `test/`, or
  `tests/`; workflow, policy, authentication, credentials, security, scripts,
  manifests, lock, hidden forge, and Odinn state paths are
  denied. Repairs use GitHub's Git Data API to create an internal branch and
  pull request. They never execute untrusted pull-request code in the
  privileged workflow; the repair PR runs ordinary unprivileged CI and is
  re-reviewed after CI completes.
- Label reconciliation uses only the fixed `odinn:reviewed`,
  `odinn:needs-human`, and `odinn:close-candidate` labels.

The apply job refuses stale item context, a changed repair base tip, ambiguous
multiple actions, incomplete API pagination, consumed or ambiguously claimed
one-shot commands, and expired plans. Repair branch
names and commit messages are executor-derived; an existing matching branch or
pull request is reconciled on retry.

## Codex Security remediation

The reusable `codex-security-remediation.yml` workflow gives Odinn Forge a
bounded automatic path from a complete Codex Security scan to a draft repair
pull request. The thin caller remains in Forge while the implementation and
policy stay in this repository.

The workflow checks out only Forge's trusted default branch without persisted
Git credentials. Scan and patch steps receive ChatGPT OAuth but never receive
`GITHUB_TOKEN`. After Codex exits, deterministic gates bind the candidate to
the scanned default-branch revision, restrict changes to affected files plus
bounded tests/docs, deny GitHub workflows, scripts, manifests, credentials,
secrets, deletions, binaries, modes, symlinks, and submodules, and cap both
file count and diff size. The full Forge check suite must pass before a later
step receives the caller-scoped write token.

The write step rechecks the live default-branch tip, uses finding fingerprints
and the base revision for deterministic deduplication, opens only a draft pull
request, and explicitly dispatches Forge CI because events created with
`GITHUB_TOKEN` do not recursively trigger workflows. It never merges.

## Reusable Codex Security scans

The hardened daily scan workflow is also callable by other BlueDot
repositories. Each caller passes its own repository and trusted default branch,
supplies its own OAuth and artifact-encryption secrets, and retains the
encrypted result artifact in the caller repository. The implementation remains
pinned here so package, sandbox, completeness, privacy, and retention controls
do not drift across repositories.

Calls from outside the BlueDot organization are rejected. Reusable callers may
scan only their own `main` branch; the maintainer's internal scheduled run may
scan the fixed Odinn Forge target. The reusable workflow has read-only
repository permissions, does not publish SARIF, never uploads raw findings, and
does not modify the scanned repository. Encrypted artifacts include a keyed
SHA-256 authentication sidecar that must be verified before decryption.

Before scanning, the workflow installs target dependencies from a committed
pnpm or npm lockfile with lifecycle scripts disabled. Scanner exit `2` is
recorded as a completed partial-coverage result rather than mislabeled as an
infrastructure crash. Canonical results, SARIF, and the scanner log are
encrypted and uploaded before a final gate requires a completed manifest and
complete coverage; partial scans still fail closed with an explicit summary.
The scanner and its complete transitive dependency graph are likewise installed
with `npm ci` from the committed lock under `.github/codex-security/`; workflows
never regenerate that lock during a run.

## Caller workflow

The Odinn repository keeps only a thin discovery/matrix workflow and pins these
actions to an immutable commit. Its event surface should include direct
pull-request/issue events, `issue_comment`, completed `workflow_run` events,
manual dispatch, and a periodic `schedule`.

```yaml
- uses: BlueDot-IT/odinn-maintainer/.github/actions/review@COMMIT_SHA
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    oauth-json: ${{ secrets.ODINN_OPENAI_OAUTH_JSON }}
```

For guarded automation, use the separate actions in separate jobs. The plan
file is the only handoff:

```yaml
jobs:
  plan:
    permissions:
      contents: read
      issues: read
      pull-requests: read
      checks: read
    steps:
      - id: plan
        uses: BlueDot-IT/odinn-maintainer/.github/actions/plan@COMMIT_SHA
        with:
          github-read-token: ${{ github.token }}
          oauth-json: ${{ secrets.ODINN_OPENAI_OAUTH_JSON }}
          allow-automation: "false"
          allow-repair: "false"
      - uses: actions/upload-artifact@COMMIT_SHA
        with:
          name: odinn-maintainer-plan
          path: ${{ steps.plan.outputs.plan-path }}
          retention-days: 1

  apply:
    needs: plan
    # Do not use job-level continue-on-error on Plan. Apply must run only after
    # Plan produced and uploaded a valid artifact.
    if: ${{ needs.plan.result == 'success' }}
    permissions:
      contents: write
      issues: write
      pull-requests: write
      checks: write
    steps:
      - uses: actions/download-artifact@COMMIT_SHA
        with:
          name: odinn-maintainer-plan
          path: .odinn-maintainer-plan
      - uses: BlueDot-IT/odinn-maintainer/.github/actions/apply@COMMIT_SHA
        with:
          github-token: ${{ github.token }}
          plan-path: .odinn-maintainer-plan/plan.json
          allow-automation: "false"
          allow-labels: "false"
          allow-close: "false"
          allow-merge: "false"
          allow-repair: "false"
```

## OAuth setup

Create a repository Actions secret named `ODINN_OPENAI_OAUTH_JSON`. Its value
should be the contents of the local Odinn OAuth record from
`.odinn/oauth/openai.json`, for example an object containing `refreshToken` (or
`refresh_token`) and optionally `accessToken`/`expiresAt`. Do not commit that
file or paste its contents into an issue or pull request.

The action refreshes the OAuth access token when needed and calls the same
ChatGPT Codex Responses transport Odinn uses. It does not use
`OPENAI_API_KEY`, `api.openai.com`, or a generic chat-completions endpoint.
OAuth and model endpoints are fixed to their exact HTTPS paths, requests have
hard timeouts and byte limits, and token values are never placed in model
input, comments, checks, artifacts, or logs.

Before a non-cached model review, Plan validates the OAuth record and performs
at most one required refresh. An authentication failure produces one bounded,
redacted diagnostic and no plan artifact. Callers must not set job-level
`continue-on-error` on Plan, and Apply must require a successful Plan job. This
circuit breaker prevents a write-capable Apply job from starting without a
valid plan; it does not persist rotated refresh tokens. Deployments using
rotating refresh tokens still need a supported broker or another durable,
serialized credential store outside this action.

The compatibility action's write surface remains limited to its sticky comment
and named Check. The guarded apply action exposes only fixed label operations,
guarded close/squash merge, and bounded Git Data and pull-request writes.
