---
"@s2-dev/streamstore": minor
---

- refactor!: BasinScope now Location, and is free string instead of enum
- feat: adds `location` related RPCs

Breaking changes:
  - CreateBasinInput.scope replaced by location
  - EnsureBasinInput.scope replaced by location
  - BasinInfo.scope replaced by location
  - root export BasinScope removed and replaced by LocationName
  - generated API.BasinScope no longer exists because the spec no longer has it
