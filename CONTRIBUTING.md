# Contributing to substack-mcp

Thank you for helping improve `substack-mcp`. This project is an open-source,
self-hosted MCP server for Substack newsletter draft workflows. Contributions should
preserve that narrow product and safety boundary.

## Before You Start

- Search existing issues and pull requests before opening a new one.
- Use a feature request for a proposed behavior change and a bug report for a
  reproducible defect.
- Report suspected vulnerabilities privately through
  [GitHub Security Advisories](https://github.com/damienbenveniste/substack-mcp/security/advisories/new),
  not in a public issue.
- Do not include real Substack credentials, session cookies, tokens, private
  draft text, private images, raw API responses, or other personal data in an
  issue, pull request, test, fixture, log, or screenshot.

Substack's draft API and editor document formats are unofficial and may change
without notice. Changes at that boundary need narrow parsing, defensive error
handling, and deterministic fixture or mocked test coverage. A successful live
request is not sufficient evidence for a contribution.

## Product Boundary

This project manages unpublished drafts. Contributions must not add publishing,
scheduling, deletion, email delivery, or public Substack Notes. Users must
review and publish drafts manually in Substack.

Do not present deployment, OAuth, or third-party client behavior as implemented
or verified unless the repository's current public documentation and tests
establish that behavior. Keep proposed or operator-only work clearly labeled as
such.

## Contribution Workflow

Outside contributors should:

1. Fork the repository on GitHub.
2. Create a focused branch in the fork.
3. Make the smallest coherent change and add tests and documentation where
   required.
4. Push the branch to the fork and open a pull request against this repository's
   `main` branch.

Do not push branches directly to this repository. Opening a pull request does
not guarantee acceptance. The sole maintainer, [@damienbenveniste](https://github.com/damienbenveniste),
has final review and merge authority.

## Local Setup

Use Node.js 20 or newer and install exactly the dependencies in the committed
lockfile:

```bash
npm ci
```

Do not use `npm install` unless the contribution intentionally changes
dependencies. If dependencies change, include the corresponding
`package-lock.json` update.

Keep local credentials in ignored local configuration only. Never add secrets
to `.env.example`; it must remain a secret-empty template.

## Tests

Every behavior change needs deterministic automated coverage. Bug fixes need a
regression test that fails before the fix and passes after it.

- Mock all Substack and other network boundaries.
- Do not make live network requests from the normal test suite.
- Do not use real accounts, credentials, private drafts, wall-clock sleeps, or
  undeclared services.
- Use synthetic, body-only fixtures that contain no private metadata or raw
  Substack responses.

Run a focused test while developing, for example:

```bash
npm test -- tests/path/to/relevant.test.ts
```

Then run the complete local checks before requesting review:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run coverage
uv python install 3.13
uv venv --python 3.13
uv pip sync --python .venv/bin/python --require-hashes docs/requirements.lock
.venv/bin/mkdocs build --strict
scaffold-guard inspect-diff
scaffold-guard validate
```

The pull request must pass the repository's required CI checks. Do not bypass,
weaken, or mark a failing check as irrelevant without maintainer agreement.

## Code and Documentation Expectations

- Keep TypeScript strict. Do not use `any`, broad casts, `// @ts-ignore`, or
  broad lint suppressions to conceal failures.
- Keep changes focused and avoid unrelated cleanup.
- Update tests for every behavior change.
- Update `README.md` and examples when public behavior, configuration, or user
  workflows change.
- Keep examples small, realistic, runnable, and free of secrets.
- Do not document planned behavior as if it is available.

## Pull Request Review

Complete the pull request template with the scope, tests, privacy impact, and
documentation impact. All changes require passing CI and review by
[@damienbenveniste](https://github.com/damienbenveniste). Only the maintainer may
merge a pull request.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
