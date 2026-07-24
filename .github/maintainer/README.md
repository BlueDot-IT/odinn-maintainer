# Odinn Maintainer GitHub Action

This repository owns the separate, reusable GitHub Action used by Odinn. It is
a small, GitHub-native ClawSweeper-style review lane: the caller repository
reacts to pull requests and issues, while this repository collects a bounded
snapshot, asks the configured Codex model for a conservative structured review,
and upserts one sticky review comment. It does not execute pull-request code,
merge, close, or modify the Odinn web app.

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

The GitHub token is separate: `GITHUB_TOKEN` is only used to read the bounded
PR/issue context and publish the sticky review comment.
