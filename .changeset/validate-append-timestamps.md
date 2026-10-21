---
"@s2-dev/streamstore": patch
---

`AppendRecord` factories now reject `NaN`, infinite, negative, or invalid-`Date` timestamps with a clear `S2Error`, instead of failing later during s2s serialization. Fractional millisecond timestamps are floored on the s2s transport, as they already were over fetch.
