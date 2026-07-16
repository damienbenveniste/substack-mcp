# Governance

## Project Scope

`substack-mcp` is an open-source, self-hosted MCP server for managing
Substack newsletter drafts. Publishing, scheduling, deletion, email delivery, and public Substack
Notes are outside the project boundary. Substack's draft API is unofficial and
unstable, so compatibility claims require deterministic mocked or fixture-based
evidence.

## Maintainer

[@damienbenveniste](https://github.com/damienbenveniste) is the sole maintainer,
code owner, and merge authority for this project.

The maintainer is responsible for:

- setting project scope and technical direction;
- reviewing issues and pull requests;
- enforcing security, privacy, testing, and conduct requirements;
- deciding whether to accept, revise, defer, or reject contributions;
- merging approved changes; and
- managing releases and repository settings.

No contributor, reviewer, automation, or dependency-update service may merge a
change without the maintainer's approval.

## Decision Process

Discussion occurs in issues and pull requests whenever it can be public safely.
The maintainer seeks clear technical evidence and constructive input, but final
decisions rest with the maintainer. Decisions prioritize:

1. protecting credentials and private draft data;
2. preserving the manual-publishing boundary;
3. deterministic behavior and testability;
4. compatibility with the repository's supported TypeScript and MCP surface;
5. focused maintenance cost.

Security reports and other sensitive matters must use private GitHub Security
Advisories rather than public discussion.

## Change Acceptance

Outside contributions must arrive from a fork through a pull request. Every
change requires:

- passing required CI checks;
- maintainer review and approval;
- deterministic mocked tests for behavior changes;
- documentation updates when public behavior changes; and
- compliance with the security, privacy, and manual-publishing requirements in
  [CONTRIBUTING.md](CONTRIBUTING.md).

The maintainer may request changes, close inactive work, or decline changes that
expand scope, lack evidence, create privacy risk, or impose disproportionate
maintenance cost.

## Maintainer Succession

If project stewardship changes, the current maintainer will designate a
successor explicitly and update this document and `CODEOWNERS`. Until then,
[@damienbenveniste](https://github.com/damienbenveniste) remains the sole merge
authority.
