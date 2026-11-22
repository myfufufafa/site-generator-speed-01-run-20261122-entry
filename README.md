# site-generator-speed-01 — faster makefun-site drop-in

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/myfufufafa/site-generator-speed-01-run-20261122-entry/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/myfufufafa/site-generator-speed-01-run-20261122-entry/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: `solve.js` answers byte-identically
on every case, with far less CPU time than the house baseline.

How it gets faster, without changing any answer:

- One fused pass per source: front matter, Markdown blocks and inline
  rendering share a single scan, with no token objects and no per-character
  HTML escaping (plain runs are copied whole; a lookup table dispatches
  only the characters that can start a construct).
- A cached slugifier with an ASCII fast path (NFKD + combining-mark
  stripping is skipped for pure-ASCII text, which is almost everything).
- Templates are parsed once, includes are inlined at parse time, and each
  template is compiled to a single native function: loops and conditionals
  become real `for`/`if`, loop variables become lexical variables.
- Word counting scans a table instead of building a word array; front
  matter bodies are slices, not re-joined lines; nothing is cached from
  one case to the next.

Verification (practice set, this machine): 3/3 cases byte-identical to the
house baseline, 43/43 differential-fuzz cases identical, deterministic
across repeated runs.

## Layout

- `main.ts` — the harness driver: reads `/input/cases.json`, answers each
  case with `run()`, writes `/output/answers.json`.
- `solve.js` — the whole build, dependency-free, stdlib only.
- `package.json` — `{"type": "module"}`.
