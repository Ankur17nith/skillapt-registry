# Contributing to skillapt-registry

Thanks for helping! This repository is the registry service of the skillapt project
(see also [`skillapt`](https://github.com/Ankur17nith/skillapt), the CLI, and
[`skillapt-web`](https://github.com/Ankur17nith/skillapt-web), the website).
By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

**Found a security problem?** Do not open an issue. Follow [`SECURITY.md`](SECURITY.md).

## Getting set up

Requirements: Node.js >= 22.5 and [pnpm](https://pnpm.io/).

```bash
git clone https://github.com/<your-fork>/skillapt-registry.git
cd skillapt-registry
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars     # local-only; never commit it
pnpm db:migrate:local
pnpm dev                           # http://localhost:8787
```

## Before you open a pull request

Run the same checks CI runs:

```bash
pnpm typecheck
pnpm test
pnpm audit --prod
npx wrangler deploy --dry-run      # bundle builds; uploads nothing
pnpm smoke                         # boots the Worker on local workerd
pnpm test:integration              # end-to-end scenarios on workerd
```

All of them must pass. If you changed behavior that the CLI depends on, also run
`pnpm conformance` with `SKILLAPT_CLI_DIR` pointing at a built checkout of the CLI.

## Guidelines

- **Tests first for bugs.** Reproduce the bug in a failing test, then fix it. Security
  regressions live in `tests/security/`.
- **Keep changes focused.** One concern per pull request, and small commits.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`fix(validation): ...`, `feat: ...`, `docs: ...`, `ci: ...`, `chore: ...`). Explain *why*,
  not just *what*.
- **TypeScript strictness.** `pnpm typecheck` must be clean; avoid `any` in new code.
- **Database changes** are new numbered files in `migrations/` (never edit an applied
  migration). Update the tests that apply migrations, and mention the change in the PR.
- **API changes** must be reflected in `docs/openapi.yaml` and `docs/SPEC.md`, and noted
  in `CHANGELOG.md` under *Unreleased*.
- **No secrets, ever.** Not in code, tests, docs or commit history. Test fixtures use
  obviously fake values.
- **Free-tier friendly.** The project must keep running on Cloudflare's free plan; avoid
  adding paid services or heavy per-request CPU work (the free Workers plan allows 10 ms).
- **Never** run `wrangler login`, `wrangler deploy` or any `--remote` command as part of a
  contribution; deployment is done by maintainers (see `docs/DEPLOY.md`).

## Reporting bugs and requesting features

Use the issue templates. For bugs include the version, what you did, what you expected and
what happened (with logs, but **without tokens or secrets**).

## Review process

A maintainer reviews every pull request. Expect feedback; we aim to respond within a week.
Pull requests that fail CI cannot be merged.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
