# Odinn Maintainer GitHub Action

This repository owns the separate, reusable GitHub Action used by Odinn. It is
a GitHub-native Odinn Maintainer review lane: the caller repository reacts to
pull requests and issues, while this repository collects a bounded snapshot,
asks the configured Codex model for a conservative structured review, and
upserts one sticky review comment. It never checks out or executes target
repository code.

Before model spend it applies deterministic policy gates for explicit opt-out
labels, bot-authored items, and closed items. It reuses only a recent
`keep_open` result for the same complete repository context. The cache digest
binds the title, body, labels, human discussion, reviews, changed-file patches,
checks, base and head revisions, policy, prompt, and model. Incomplete context
always requires human review and is never cached.

Every pull request review publishes or updates an `Odinn Maintainer` GitHub
Check. The action re-fetches the complete context before publishing model
output; any drift blocks the sticky comment and produces a neutral result.
`needs_human` is neutral and `close_candidate` is action-required.

## Guarded automation

The original `review` action remains a review-only compatibility surface.
Guarded mutations use two separate actions and two separate jobs:

1. `plan` receives OAuth plus an anonymous or read-only GitHub credential. It
   writes a strict, size-bounded JSON plan and cannot receive `GITHUB_TOKEN`.
2. The caller uploads that plan as an artifact. A later job downloads it.
3. `apply` receives the downloaded plan and the job-scoped write token. It
   rejects OAuth and API-key environment variables, validates the plan's
   schema and 15-minute lifetime, then re-fetches the exact live item before
   any planned mutation.

All autonomous switches default to `false`. `allow-automation` is the global
kill switch; the matching per-capability switch must also be enabled. The event
actor must have `write`, `maintain`, or `admin` permission.

Additional item-level gates are mandatory:

- Close requires `odinn:allow-close`, high-confidence evidence, and an exact
  `/odinn-maintainer close` command from the authorized event actor.
- Merge requires `odinn:allow-merge` and
  `/odinn-maintainer merge HEAD_SHA` from that actor. Only same-repository,
  non-draft pull requests with strict branch protection and successful live
  required checks can be squash-merged.
- Repair requires `odinn:allow-repair` and
  `/odinn-maintainer repair`. Phase one can modify only bounded UTF-8 files
  under `docs/`, `test/`, or `tests/`; workflow, policy, authentication,
  security, scripts, manifests, lock, hidden forge, and Odinn state paths are
  denied. Repairs use GitHub's Git Data API to create an internal branch and
  pull request. They never run a checkout, shell command, package script, or
  repository test.
- Label reconciliation uses only the fixed `odinn:reviewed`,
  `odinn:needs-human`, and `odinn:close-candidate` labels.

The apply job refuses stale item context, a changed repair base tip, ambiguous
multiple actions, incomplete API pagination, and expired plans. Repair branch
names and commit messages are executor-derived; an existing matching branch or
pull request is reconciled on retry.

## Caller workflow

The Odinn repository keeps only a thin event workflow and pins this action to
an immutable commit:

```yaml
- uses: jason-allen-oneal/odinn-maintainer/.github/actions/review@COMMIT_SHA
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
        uses: jason-allen-oneal/odinn-maintainer/.github/actions/plan@COMMIT_SHA
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
      - uses: jason-allen-oneal/odinn-maintainer/.github/actions/apply@COMMIT_SHA
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

The compatibility action's write surface remains limited to its sticky comment
and named Check. The guarded apply action exposes only fixed label operations,
guarded close/squash merge, and bounded Git Data and pull-request writes.
