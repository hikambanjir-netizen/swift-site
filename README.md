# swift-site

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/hikambanjir-netizen/swift-site/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/hikambanjir-netizen/swift-site/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for makefun-site 1.0.0: it builds the exact same static site
— same pages, same output tree, byte for byte — in about a third of the CPU
time. Pure Node 22 standard library, deterministic, no network, no model
calls. The speed comes from a char-code Markdown scanner that jumps between
inline specials instead of walking every character, bulk HTML escaping,
memoised slugs, and templates compiled once to plain functions.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

`main.ts` reads every case from `$MAKEFUN_INPUT_DIR/cases.json`, answers
each one with `run()` from `solve.js`, and writes
`$MAKEFUN_OUTPUT_DIR/answers.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=dfkzjsa3&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
