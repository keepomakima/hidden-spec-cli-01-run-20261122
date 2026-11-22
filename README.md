# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/keepomakima/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/keepomakima/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON —
and mend reads all four to one written specification, `SPEC.md` in the kit's
starter: it finds the lines an edit names even when the model drifted their
whitespace or indentation, and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

Node 22 and its standard library alone; nothing is installed. The working
directory is the root of the tree, and every path in a patch is relative to it.
When PATCH is absent or is `-`, the patch is read from standard input.

```sh
node main.ts --format=auto fix.patch   # detect the format, apply the patch
node main.ts --check fix.patch         # same output and exit code, no writes
node main.ts --strict fix.patch        # match lines exactly (tier 0 only)
```

## Exit codes

- `0` — the tree is written; one line per path whose state changed
  (`A` added, `D` deleted, `M` modified, `R old -> new` moved), then
  `ok: <n> files`.
- `1` — one or more edits failed; one `error: <code> <path>` line per failed
  edit, then `failed: <k> of <n> edits`. No file is written.
- `2` — one line only: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.

## Matching

Old lines are found at the first of three tiers at which they occur: tier 0
(every line equal), tier 1 (trailing spaces and tabs ignored), tier 2 (leading
and trailing spaces and tabs ignored, with re-indentation). `--strict` tries
tier 0 only.

## License

MIT — see `LICENSE`.
