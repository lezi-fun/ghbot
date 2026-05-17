# ghbot

GitHub Actions bot that reviews pull requests by calling Codex CLI, leaves inline review comments for problems, approves clean PRs, and can merge them when repository checks are green.

## Behavior

- Triggers on `pull_request_target`: `opened`, `synchronize`, `reopened`, `ready_for_review`.
- When a new PR is opened, posts an immediate comment that review has started.
- Fetches changed files and patches from the pull request.
- Asks Codex CLI to review the PR and write a structured JSON result to `.review-result.json`:
  - `safeToMerge=true` only when there are no blocking findings.
  - `blocking` findings become request-changes reviews.
  - `suggestion` findings are included as non-blocking suggestions.
- Supports a lenient pass when a repository administrator comments `/lenient-check`.
- If no repository administrator has commented or reviewed within the last 24 hours, the lenient trigger automatically broadens to users with `write`, `maintain`, or `admin` permission.
- In lenient mode, only blocks dangerous changes, runtime-impacting issues, errors, crashes, broken builds, data-loss risks, and security risks.
- A PR that passes lenient mode is not auto-merged until `@lezi-fun` approves the current head commit.
- If the reviewer detects clearly malicious code, the bot comments with the reason and closes the pull request.
- Posts inline comments only on valid added diff lines.
- Approves clean pull requests.
- Retries transient Codex CLI and GitHub API request failures up to 5 times before giving up.
- Deletes any stale `.review-result.json` before each run and again after each review attempt.
- If `AUTO_MERGE=true`, merges only after:
  - the AI reviewer says the PR is safe,
  - GitHub reports the PR as mergeable,
  - checks/statuses are green when `REQUIRE_CHECKS=true`.

## GitHub Actions setup

Add these repository secrets:

- `CODEX_API_KEY`

Optional repository variables:

- `CODEX_BASE_URL`: defaults to `https://api.openai.com/v1`
- `CODEX_MODEL`: defaults to `gpt-5.4`
- `CODEX_REASONING_EFFORT`: `minimal`, `low`, `medium`, `high`, or `xhigh`, defaults to `high`
- `AUTO_MERGE`: defaults to `false`
- `MERGE_METHOD`: `merge`, `squash`, or `rebase`, defaults to `squash`
- `REQUIRE_CHECKS`: defaults to `true`
- `MAX_PATCH_CHARS`: defaults to `120000`

The workflow uses the repository `GITHUB_TOKEN`, so you do not need a GitHub App, webhook endpoint, Vercel deployment, or a self-hosted listener.
It installs Codex CLI inside the GitHub Actions runner and uses that CLI for the review itself. The workflow writes an isolated Codex `config.toml` at runtime with the configured model, provider base URL, and reasoning setting, then asks Codex CLI to persist its final review result into `.review-result.json`.

## Required workflow permissions

Repository Actions permissions must allow the workflow token to:

- `contents: write`
- `pull-requests: write`
- `checks: write`
- `issues: write`
- `statuses: read`

These permissions are declared in [.github/workflows/review.yml](/Users/home/Projects/ghbot/.github/workflows/review.yml:1).

## Lenient check

If a strict review leaves findings that are not practical to change, a repository administrator can comment this on the PR:

```text
/lenient-check
```

That reruns the AI in lenient mode.

If no administrator has commented or reviewed within the last 24 hours on that PR, the command is also accepted from users with `write` or `maintain` permission.

If lenient mode passes, the bot still requires `@lezi-fun` to approve the current head commit before merge.

## Local development

```bash
npm install
npm run build
npm run typecheck
```

To simulate the workflow locally, export the same env vars that the GitHub Action uses and run:

```bash
node dist/src/actions/runReview.js
```

You must also provide:

- `GITHUB_EVENT_NAME`
- `GITHUB_EVENT_PATH`
- `GITHUB_TOKEN`

## Configuration

See [.env.example](/Users/home/Projects/ghbot/.env.example:1) for local testing values.

Important variables:

- `GITHUB_TOKEN`: GitHub token used by the workflow or local simulation
- `CODEX_API_KEY`: API key used by Codex CLI
- `CODEX_BASE_URL`: optional Codex/OpenAI-compatible base URL
- `CODEX_MODEL`: defaults to `gpt-5.4`
- `CODEX_REASONING_EFFORT`: optional, one of `minimal`, `low`, `medium`, `high`, `xhigh`
- `BOT_NAME`: defaults to `ghbot`, but the workflow sets it to `github-actions[bot]`
- `LENIENT_APPROVAL_USER`: defaults to `lezi-fun`
- `AUTO_MERGE`: defaults to `false`
- `MERGE_METHOD`: defaults to `squash`
- `REQUIRE_CHECKS`: defaults to `true`
- `MAX_PATCH_CHARS`: defaults to `120000`

The generated Codex CLI config is intentionally close to a working local setup:

```toml
model = "gpt-5.4"
model_provider = "bot"
approvals_reviewer = "user"
model_reasoning_effort = "high"

[model_providers.bot]
name = "bot"
base_url = "https://api.openai.com/v1"
env_key = "CODEX_API_KEY"
wire_api = "responses"
```

The workflow invokes Codex CLI with `--dangerously-bypass-approvals-and-sandbox`, relies on `.review-result.json` for the final machine-readable result, and streams Codex CLI stdout/stderr into the GitHub Actions log for debugging.

## Safety notes

Start with `AUTO_MERGE=false`. Let the bot comment and approve first, then enable auto-merge after you trust the behavior on your repositories.

This bot does not execute untrusted PR code. It reviews diffs and checks GitHub check/status results. Keep repository branch protection enabled so required CI and human override rules still apply.
