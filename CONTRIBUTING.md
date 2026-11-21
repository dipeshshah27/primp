# Contributing

## Provenance rule (clean room)

primp is MIT licensed. Some neighbouring tools are published under non-compete licences (PolyForm Shield and similar), which forbid using their code in a competing product.

- Do not copy code, prompt text, tool descriptions or schemas from any project under such a licence. Do not add one as a dependency, devDependency or test fixture. Check a project's licence before reading its source for ideas.
- Briefs given to coding agents describe behaviour only. They must not contain source excerpts from those projects.
- `element-source` declares no licence. Do not copy its code; framework collectors here are written independently.
- Code derived from MIT projects (for example Airship's proxy tunnel) is allowed. List each derived file in `NOTICE` with the upstream copyright line.

## Layout

See the plan summary in `README.md`. `packages/engine` is pure logic with no DOM or Node APIs, so it can be unit-tested on recorded JSON.

## Fixtures

`fixtures/*` are standalone apps outside the pnpm workspace. Install them with `pnpm install --ignore-workspace`. Tests copy a fixture to a temp directory before starting its dev server, so tests never edit the checked-in copy.
