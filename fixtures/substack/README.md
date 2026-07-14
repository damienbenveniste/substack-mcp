# Substack Fixtures

This directory is reserved for live Substack draft-body fixtures captured with:

```bash
npm run inspect:draft -- <draft_id>
```

The default inspection output includes the parsed `draft_body` and omits the full raw Substack response. Fixture captures created with `--fixture <kind>` write only the parsed `draft_body`, without draft title, subtitle, audience, or raw metadata. Add `--include-raw` only when you need to inspect fields outside `draft_body`.

Check current fixture readiness at any time:

```bash
npm run fixtures:status
```

The status output prints a next action for each required fixture, including the exact `create:fixture -- --kind <kind> --capture` command for missing or stale purpose-built fixtures.

When the required live fixtures are expected to exist, make the readiness check fail on missing, invalid, or adapter-incompatible files, then run the fixture-gated adapter test:

```bash
npm run fixtures:status -- --require-all
npm test -- tests/content/substackFixtureCompatibility.test.ts
```

For a non-default fixture directory, pass the same directory to both commands:

```bash
npm run fixtures:status -- --fixture-dir fixtures/live --require-all
SUBSTACK_FIXTURE_DIR=fixtures/live npm test -- tests/content/substackFixtureCompatibility.test.ts
```

`SUBSTACK_FIXTURE_DIR` must resolve inside the project directory. `npm run v1:preflight` warns when it is outside the project or when it differs from the `--fixture-dir` path used for V1 status/runbook commands.

Gate 7 evidence must include a fixture provenance review. Record whether each required fixture was captured from a purpose-built draft created by `create:fixture`, from an existing native editor-created draft through `inspect:draft -- --fixture`, or from another reviewed live Substack workflow. `npm run create:fixture -- --kind all --capture` emits a safe `gate_7_fixture_provenance_review` summary and per-fixture `provenance_review` lines that can be copied into the evidence artifact after manual editor review. Dry-run provenance is a rehearsal result only and is rejected by `v1:record` for gate 7. The fixture readiness and compatibility checks prove the files match the adapter; the provenance review records why those files are acceptable evidence for native Substack rendering.

You can write an expected fixture file directly:

```bash
npm run inspect:draft -- <draft_id> --fixture inline-marks
npm run inspect:draft -- <draft_id> --fixture image
npm run inspect:draft -- <draft_id> --fixture code-block
npm run inspect:draft -- <draft_id> --fixture latex-block
npm run inspect:draft -- <draft_id> --fixture image --fixture-dir fixtures/substack
```

To create a purpose-built draft for fixture capture, first dry-run locally:

```bash
npm run create:fixture -- --dry-run
npm run create:fixture -- --kind inline-marks --dry-run
npm run create:fixture -- --kind image --dry-run
npm run create:fixture -- --kind code-block --dry-run
npm run create:fixture -- --kind latex-block --dry-run
npm run create:fixture -- --kind all --dry-run
```

Then, with `.env.local` or `.env` configured for Substack, create the needed draft:

```bash
npm run create:fixture
npm run create:fixture -- --kind latex-block
npm run create:fixture -- --kind all
npm run create:fixture -- --kind all --capture
npm run create:fixture -- --kind all --capture --fixture-dir fixtures/substack
```

The script prints the draft ID and the matching `inspect:draft` command. For `--kind inline-marks`, `--kind image`, `--kind code-block`, and `--kind latex-block`, that command includes the matching `--fixture <kind>` flag. `--kind all` creates the four required purpose-built fixture drafts and returns four inspect commands. When `--fixture-dir <project-local-dir>` is set, the printed inspect commands include the same fixture directory. Adding `--capture` to a purpose-built fixture kind or `--kind all` fetches each created draft back and writes the expected body-only, non-raw fixture file under this directory by default. Pass `--fixture-dir <project-local-dir>` to write capture output somewhere else, then run `npm run fixtures:status -- --fixture-dir <project-local-dir>` against that directory. The same `--fixture-dir` option works with `inspect:draft -- --fixture <kind>` when capturing an already-created draft into a non-default fixture directory. It creates drafts only; it does not publish, schedule, delete, email, or create public Notes.

Expected fixture files before V1 completion:

- `inline-marks-draft-body.json`
- `image-draft-body.json`
- `code-block-draft-body.json`
- `latex-block-draft-body.json`

`tests/content/substackFixtureCompatibility.test.ts` automatically skips these checks while the files are absent. As each file is added, `npm test -- tests/content/substackFixtureCompatibility.test.ts` compares the captured Substack `draft_body` to the adapter output.
`npm run fixtures:status` confirms the fixture files are present, parse as Substack draft-body documents, contain no top-level draft metadata or raw response fields, contain the expected feature-specific shape, and exactly match the current adapter output. It reports separate present, valid, and adapter-compatible counts. Incompatible fixtures include a safe first structural difference plus node/mark summaries so adapter updates can be targeted without printing draft text or URLs.

Use purpose-built drafts with only the content under test:

- `inline-marks-draft-body.json`: one paragraph containing `Plain `, bold `bold`, plain space, italic `italic`, plain space, inline code `code`, plain space, and link text `link` pointing to `https://example.com`.
- `code-block-draft-body.json`: one Python code block containing exactly `print('hello')`.
- `image-draft-body.json`: one uploaded image, optionally with alt text, title, dimensions, and caption. The test derives the image URL and optional attributes from the captured fixture.
- `latex-block-draft-body.json`: one native LaTeX block containing exactly `E = mc^2`.

Do not put private draft content here. Use purpose-built test drafts with non-sensitive text.
