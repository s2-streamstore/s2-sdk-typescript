# ListAccessTokensRequest

## Example Usage

```typescript
import { ListAccessTokensRequest } from "@s2-dev/streamstore/models/operations";

let value: ListAccessTokensRequest = {};
```

## Fields

| Field                                                                        | Type                                                                         | Required                                                                     | Description                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `prefix`                                                                     | *string*                                                                     | :heavy_minus_sign:                                                           | Filter to access tokens whose ID begins with this prefix.                    |
| `startAfter`                                                                 | *string*                                                                     | :heavy_minus_sign:                                                           | Filter to access tokens whose ID lexicographically starts after this string. |
| `limit`                                                                      | *number*                                                                     | :heavy_minus_sign:                                                           | Number of results, up to a maximum of 1000.                                  |