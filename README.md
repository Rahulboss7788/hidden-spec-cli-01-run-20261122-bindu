# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Rahulboss7788/hidden-spec-cli-01-run-20261122-bindu/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Rahulboss7788/hidden-spec-cli-01-run-20261122-bindu/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is a command-line tool that applies AI-written edits to a tree of text files. It accepts four patch formats — unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — and applies each edit all-or-nothing: either every edit succeeds, or no file is changed. It runs on Node 22 using only the standard library.

## Usage

```
node main.ts [options] [PATCH]
```

`PATCH` is the path to the patch file; when it is absent or `-`, the patch is read from standard input.

Options:

- `--format=NAME` — read the patch as `unified`, `search-replace`, `v4a`, or `json`; `auto` (the default) detects the format.
- `--check` — validate and report the result without writing any files.
- `--strict` — match lines exactly, without the relaxed whitespace tiers.

## How it works

See `SPEC.md` for the full specification. In brief: patches are detected, parsed, and applied in order; line matching tolerates whitespace drift across three tiers (exact, trailing-whitespace, and leading/trailing-whitespace) unless `--strict` is given; paths are checked for safety before anything is written; and output reports the files added, deleted, modified, or moved, with a summary line.

## Practice checks

Run the practice set against the kit's checks:

```
node check.ts <kit>/program/generator/practice.json
```

## Files

- `main.ts` — the CLI.
- `runner.ts` — trial runner (kept as supplied).
- `check.ts` — runs the practice checks on your machine.
- `SPEC.md` — the full specification.
- `LICENSE` — MIT.

## License

MIT — see `LICENSE`.
