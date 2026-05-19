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
- A scheduled recheck runs hourly so the 24-hour fallback can take effect even if no new PR event arrives after the window expires.
- The hourly scheduled run also deletes merged branches immediately and deletes branches for closed PRs after 3 days.
- In lenient mode, only blocks dangerous changes, runtime-impacting issues, errors, crashes, broken builds, data-loss risks, and security risks.
- A PR that passes lenient mode is not auto-merged until an eligible reviewer approves the current head commit.
- Eligible reviewers for lenient merge approval are:
  - repository administrators when an administrator has commented or reviewed on the PR within the last 24 hours
  - otherwise any repository user with `write`, `maintain`, or `admin` permission
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
- Optional for GitHub App identity:
  - `GH_APP_ID`
  - `GH_APP_PRIVATE_KEY`
  - `GH_APP_INSTALLATION_ID`

Optional repository variables:

- `CODEX_BASE_URL`: defaults to `https://api.openai.com/v1`
- `CODEX_MODEL`: defaults to `gpt-5.4`
- `CODEX_REASONING_EFFORT`: `minimal`, `low`, `medium`, `high`, or `xhigh`, defaults to `high`
- `AUTO_MERGE`: defaults to `false`
- `MERGE_METHOD`: `merge`, `squash`, or `rebase`, defaults to `squash`
- `REQUIRE_CHECKS`: defaults to `true`
- `MAX_PATCH_CHARS`: defaults to `120000`
- `BRANCH_CLEANUP_SKIP_BRANCHES`: comma-separated branch patterns to keep, for example `main,develop,release/*`

The workflow automatically receives `github.token` from GitHub Actions, so you do not need to create a repository secret named `GITHUB_TOKEN`.
If you do nothing else, ghbot uses that workflow token for comments, reviews, checks, and merges.
If you configure a GitHub App, ghbot prefers the App installation token for those GitHub write operations and falls back to the workflow token if App auth fails.
It installs Codex CLI inside the GitHub Actions runner and uses that CLI for the review itself. The workflow writes an isolated Codex `config.toml` at runtime with the configured model, provider base URL, and reasoning setting, then asks Codex CLI to persist its final review result into `.review-result.json`.

## GitHub App setup

You only need this if you want the bot to act as your GitHub App instead of `github-actions[bot]`.

1. Create a GitHub App at `Settings -> Developer settings -> GitHub Apps -> New GitHub App`
2. Recommended fields:
   - `GitHub App name`: any unique name, for example `ghbot`
   - `Homepage URL`: your repository URL or project URL
   - `Webhook`: disabled, this workflow-based setup does not need a webhook
3. App permissions:
   - Repository permissions:
     - `Contents`: `Read and write`
     - `Pull requests`: `Read and write`
     - `Checks`: `Read and write`
     - `Issues`: `Read and write`
     - `Metadata`: `Read-only`
4. Subscribe to no webhook events unless you need them for something else
5. Create and download the private key
6. Install the App on the target repository
7. In the target repository, add these Actions secrets:
   - `GH_APP_ID`: the numeric App ID
   - `GH_APP_PRIVATE_KEY`: the full PEM private key content
   - Optional `GH_APP_INSTALLATION_ID`: the numeric installation ID

Notes:

- GitHub Actions secrets and variables cannot start with `GITHUB_`, so use the `GH_APP_*` names above in repository settings.
- `GH_APP_INSTALLATION_ID` is optional. ghbot can resolve it automatically from the repository if the App is installed there.
- Keep `CODEX_API_KEY` as a separate secret. The App only replaces GitHub write identity; it does not replace Codex authentication.
- The repository still gets `github.token` automatically from GitHub Actions, and ghbot uses it as a fallback if App authentication is unavailable or broken.
- The scheduled branch cleanup skips the repository default branch and any branches matched by `BRANCH_CLEANUP_SKIP_BRANCHES`. It also skips protected branches automatically.

## Reuse from another repository

This repository now exposes a reusable workflow at:

```text
lezi-fun/ghbot/.github/workflows/review-reusable.yml@main
```

In another repository, create a thin wrapper workflow such as:

```yaml
name: PR Review Bot

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

permissions:
  contents: write
  pull-requests: write
  checks: write
  statuses: read
  issues: write

jobs:
  review:
    if: |
      github.event_name == 'pull_request_target' ||
      (github.event_name == 'issue_comment' && github.event.issue.pull_request != null) ||
      github.event_name == 'pull_request_review'
    uses: lezi-fun/ghbot/.github/workflows/review-reusable.yml@main
    secrets:
      CODEX_API_KEY: ${{ secrets.CODEX_API_KEY }}
      GH_APP_ID: ${{ secrets.GH_APP_ID }}
      GH_APP_PRIVATE_KEY: ${{ secrets.GH_APP_PRIVATE_KEY }}
      GH_APP_INSTALLATION_ID: ${{ secrets.GH_APP_INSTALLATION_ID }}
    with:
      event_name: ${{ github.event_name }}
      event_action: ${{ github.event.action }}
      repository_owner: ${{ github.repository_owner }}
      repository_name: ${{ github.event.repository.name }}
      pull_number: ${{ github.event.pull_request.number || github.event.issue.number }}
      commenter_login: ${{ github.event.comment.user.login || '' }}
      comment_body: ${{ github.event.comment.body || '' }}
      reviewer_login: ${{ github.event.review.user.login || '' }}
      review_state: ${{ github.event.review.state || '' }}
      review_commit_id: ${{ github.event.review.commit_id || '' }}
      bot_name: github-actions[bot]
      codex_base_url: ${{ vars.CODEX_BASE_URL || 'https://api.openai.com/v1' }}
      codex_model: ${{ vars.CODEX_MODEL || 'gpt-5.4' }}
      codex_reasoning_effort: ${{ vars.CODEX_REASONING_EFFORT || 'high' }}
      auto_merge: ${{ vars.AUTO_MERGE || 'false' }}
      merge_method: ${{ vars.MERGE_METHOD || 'squash' }}
      require_checks: ${{ vars.REQUIRE_CHECKS || 'true' }}
      max_patch_chars: ${{ vars.MAX_PATCH_CHARS || '120000' }}
      branch_cleanup_skip_branches: ${{ vars.BRANCH_CLEANUP_SKIP_BRANCHES || '' }}
      log_level: info
```

The caller repository still needs to configure:

- `CODEX_API_KEY` as a secret
- optional `GH_APP_ID`, `GH_APP_PRIVATE_KEY`, and `GH_APP_INSTALLATION_ID` secrets if you want GitHub App identity
- `CODEX_BASE_URL`, `CODEX_MODEL`, `CODEX_REASONING_EFFORT`, `AUTO_MERGE`, `MERGE_METHOD`, `REQUIRE_CHECKS`, and `MAX_PATCH_CHARS` as repository variables as needed
- `BRANCH_CLEANUP_SKIP_BRANCHES` as a repository variable if you want to keep long-lived or shared branches out of scheduled cleanup

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

If lenient mode passes, the bot still requires an eligible reviewer to approve the current head commit before merge.

Approval eligibility follows the same rule as lenient triggering:

- if a repository administrator has commented or reviewed on that PR within the last 24 hours, only an administrator approval can unlock merge
- otherwise any user with `write`, `maintain`, or `admin` permission can unlock merge
- an hourly scheduled recheck reevaluates this fallback window for already-approved PRs

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
- either `GITHUB_TOKEN`, or `GH_APP_ID` plus `GH_APP_PRIVATE_KEY`

## Configuration

See [.env.example](/Users/home/Projects/ghbot/.env.example:1) for local testing values.

Important variables:

- `GITHUB_TOKEN`: optional in GitHub Actions because `github.token` is automatic; still useful for local simulation or as a fallback
- `GH_APP_ID`: optional GitHub App ID
- `GH_APP_PRIVATE_KEY`: optional GitHub App private key
- `GH_APP_INSTALLATION_ID`: optional GitHub App installation ID
- `CODEX_API_KEY`: API key used by Codex CLI
- `CODEX_BASE_URL`: optional Codex/OpenAI-compatible base URL
- `CODEX_MODEL`: defaults to `gpt-5.4`
- `CODEX_REASONING_EFFORT`: optional, one of `minimal`, `low`, `medium`, `high`, `xhigh`
- `BOT_NAME`: defaults to `ghbot`, but the workflow sets it to `github-actions[bot]`
- `AUTO_MERGE`: defaults to `false`
- `MERGE_METHOD`: defaults to `squash`
- `REQUIRE_CHECKS`: defaults to `true`
- `MAX_PATCH_CHARS`: defaults to `120000`
- `BRANCH_CLEANUP_SKIP_BRANCHES`: optional comma-separated list of branch patterns skipped by scheduled cleanup

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
