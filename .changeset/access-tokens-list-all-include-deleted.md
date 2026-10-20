---
"@s2-dev/streamstore": minor
---

`accessTokens.listAll()` no longer accepts `includeDeleted`. Access tokens are never pending deletion, so the option had no effect, and it was being forwarded to the API as an undocumented `include_deleted` query parameter.

**Breaking:** Remove `includeDeleted` from `ListAllAccessTokensInput`. Drop the option from any `accessTokens.listAll()` calls.
