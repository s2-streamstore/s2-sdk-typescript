---
"@s2-dev/streamstore": patch
---

Never follow HTTP redirects. A 3xx response now fails with an `S2Error` on every transport. Before, `fetch` followed it and forwarded headers such as `s2-encryption-key` to the redirect target, and an `s2s` read session ended as if it had finished.
