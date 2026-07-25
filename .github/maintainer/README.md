# Odinn Maintainer GitHub Action

This repository owns the separate, reusable GitHub Action used by Odinn. It is
a GitHub-native Odinn Maintainer review lane: the caller repository reacts to
pull requests and issues, while this repository collects a bounded snapshot,
asks the configured Codex model for a conservative structured review, and
upserts one sticky review comment. It does not execute pull-request code,
merge, close, label, push, repair, or modify the Odinn application.

Before model spend it applies deterministic policy gates for explicit opt-out
labels, bot-authored items, and closed items. It reuses only a recent
`keep_open` result for the same complete repository context. The cache digest
binds the title, body, labels, human discussion, reviews, changed-file patches,
checks, base and head revisions, policy, prompt, and model. Incomplete context
always requires human review and is never cached.

Every pull request review publishes or updates an `Odinn Maintainer` GitHub
Check. The action re-fetches the complete context before publishing model
output; any drift blocks the sticky comment and produces a neutral result.
`needs_human` is neutral and `close_candidate` is action-required. These are
recommendations only.

## Caller workflow

The Odinn repository keeps only a thin event workflow and pins this action to
an immutable commit:

```yaml
- uses: jason-allen-oneal/odinn-maintainer/.github/actions/review@COMMIT_SHA
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    oauth-json: ${{ secrets.ODINN_OPENAI_OAUTH_JSON }}
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

The GitHub API write surface is deliberately limited to creating or updating
the one sticky issue comment and the named Check Run.
