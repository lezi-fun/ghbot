# Contributing

Thanks for helping improve ghbot.

## Development

```bash
npm install
npm run typecheck
```

Use `.env.example` as the configuration reference. Do not commit `.env`, private keys, webhook secrets, or API keys.

## Pull request expectations

- Keep changes focused.
- Include clear behavior notes when changing review or merge logic.
- Preserve the default-safe posture: auto-merge must stay opt-in.
- Run `npm run typecheck` before opening a PR.

## Security

Please do not open public issues for vulnerabilities that expose secrets or allow unintended merges. Open a private security advisory on GitHub or contact the maintainers privately.
