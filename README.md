# ghbot

GitHub App bot that reviews pull requests with an AI reviewer, leaves inline review comments for problems, approves clean PRs, and can merge them when repository checks are green.

## Behavior

- Listens for `pull_request` events: `opened`, `synchronize`, `reopened`, `ready_for_review`.
- Fetches changed files and patches from the pull request.
- Asks the reviewer for a structured decision:
  - `safeToMerge=true` only when there are no blocking findings.
  - `blocking` findings become request-changes reviews.
  - `suggestion` findings are included as non-blocking suggestions.
- Creates a GitHub check run with a `Lenient check` button when strict review requests changes.
- When `Lenient check` is clicked, reviews again and only blocks dangerous changes, runtime-impacting issues, errors, crashes, broken builds, data-loss risks, and security risks.
- A PR that passes `Lenient check` is not auto-merged until `@lezi-fun` approves the current head commit.
- If the reviewer detects clearly malicious code, the bot comments with the reason and closes the pull request.
- Posts inline comments only on valid added diff lines.
- Approves clean pull requests.
- If `AUTO_MERGE=true`, merges only after:
  - the AI reviewer says the PR is safe,
  - GitHub reports the PR as mergeable,
  - checks/statuses are green when `REQUIRE_CHECKS=true`.

## GitHub App setup

Create a GitHub App with these repository permissions:

- Contents: `Read & write`
- Pull requests: `Read & write`
- Checks: `Read & write`
- Commit statuses: `Read-only`
- Metadata: `Read-only`

Subscribe to this webhook event:

- Pull request
- Check run

Set the webhook URL to:

```text
https://your-domain.example/webhooks/github
```

Generate a private key for the app, install the app on the target repositories, and copy `.env.example` to `.env`.

## Configuration

```bash
cp .env.example .env
```

Required variables:

- `WEBHOOK_SECRET`: the GitHub App webhook secret.
- `GITHUB_APP_ID`: GitHub App ID.
- `GITHUB_PRIVATE_KEY`: GitHub App private key. Use escaped `\n` line breaks in a single-line env var.
- `OPENAI_API_KEY`: API key for the reviewer model.

Important optional variables:

- `OPENAI_MODEL`: defaults to `gpt-4.1`.
- `AUTO_MERGE`: defaults to `false`. Set to `true` only after testing on a non-critical repo.
- `MERGE_METHOD`: `merge`, `squash`, or `rebase`. Defaults to `squash`.
- `REQUIRE_CHECKS`: defaults to `true`.
- `LENIENT_APPROVAL_USER`: defaults to `lezi-fun`.
- `MAX_PATCH_CHARS`: maximum patch payload sent to the reviewer. Defaults to `120000`.

## Local development

```bash
npm install
npm run dev
```

Expose the local server with a tunnel and point the GitHub App webhook to:

```text
https://your-tunnel.example/webhooks/github
```

Health check:

```bash
curl http://localhost:3000/healthz
```

## Deploy to Vercel

This project includes a Vercel Function at `api/github/webhooks.ts` and a rewrite from `/webhooks/github` to `/api/github/webhooks`.

1. Import this repository into Vercel.
2. Add the required environment variables in Vercel Project Settings.
3. Deploy.
4. Set the GitHub App webhook URL to:

```text
https://your-project.vercel.app/webhooks/github
```

For local Vercel testing:

```bash
npm run dev:vercel
```

Vercel serverless functions have execution time limits. For large PRs, keep `MAX_PATCH_CHARS` conservative or upgrade the function duration in `vercel.json`.

## Self-hosted production

```bash
npm install
npm run build
npm start
```

Run it behind HTTPS. GitHub webhooks must reach `/webhooks/github`, and the app must keep the private key and webhook secret out of source control.

## Safety notes

Start with `AUTO_MERGE=false`. Let the bot comment and approve first, then enable auto-merge after you trust the behavior on your repositories.

This bot does not execute untrusted PR code. It reviews diffs and checks GitHub check/status results. Keep repository branch protection enabled so required CI and human override rules still apply.

## Open source release checklist

- Replace the copyright holder in `LICENSE` if needed.
- Create a GitHub repository.
- Push this code.
- Configure repository secrets only in GitHub/Vercel, never in source control.
- Keep branch protection enabled on `main`.
