---
"@s2-dev/streamstore": patch
---

- Improves decision tree for when to retry failed appends under `noSideEffects` policy
- Fixes a bug regarding duplicated acks after append session recovery
