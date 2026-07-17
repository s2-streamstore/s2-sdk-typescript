---
"@s2-dev/streamstore": patch
---

- Test suite: allow correctness test reads to outlive prolonged append outages and cleanly cancelling concurrent work on failure
- Normalize undici network failures so interrupted requests and response streams participate in SDK retry handling
