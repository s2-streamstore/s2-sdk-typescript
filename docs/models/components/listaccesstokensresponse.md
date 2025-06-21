# ListAccessTokensResponse

## Example Usage

```typescript
import { ListAccessTokensResponse } from "@s2-dev/streamstore/models/components";

let value: ListAccessTokensResponse = {
  accessTokens: [
    {
      id: "<id>",
      scope: {},
    },
  ],
  hasMore: false,
};
```

## Fields

| Field                                                                      | Type                                                                       | Required                                                                   | Description                                                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `accessTokens`                                                             | [components.AccessTokenInfo](../../models/components/accesstokeninfo.md)[] | :heavy_check_mark:                                                         | Matching access tokens.                                                    |
| `hasMore`                                                                  | *boolean*                                                                  | :heavy_check_mark:                                                         | Indicates that there are more access tokens that match the criteria.       |