---
"@s2-dev/streamstore": patch
"@s2-dev/patterns": patch
"@s2-dev/resumable-stream": patch
---

Pin tanstack devDeps and revert `@types/node` to keep fresh installs reproducible.

- Pin `@tanstack/ai*` devDeps to exact versions — `ai-openai@0.8.5` and `ai-react@0.8.2` bumped their peer-dep major in patch releases, so caret ranges floated into broken installs.
- Pin `@tanstack/react-router` and `@tanstack/react-start` to known-good exact versions while the supply-chain compromise from [TanStack/router#7383](https://github.com/TanStack/router/issues/7383) is being cleaned up at the registry.
- Pin `typescript@^5.9.3` (was unpinned and drifting to 6.0.3, which broke `tsc`).
- Revert `@types/node` to `^24.9.2` (`^25` drops `Buffer` / `NodeJS` from globals).
