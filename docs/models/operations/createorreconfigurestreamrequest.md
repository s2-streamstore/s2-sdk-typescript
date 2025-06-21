# CreateOrReconfigureStreamRequest

## Example Usage

```typescript
import { CreateOrReconfigureStreamRequest } from "@s2-dev/streamstore/models/operations";

let value: CreateOrReconfigureStreamRequest = {
  stream: "<value>",
  s2Basin: "<value>",
};
```

## Fields

| Field                                                              | Type                                                               | Required                                                           | Description                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `stream`                                                           | *string*                                                           | :heavy_check_mark:                                                 | Stream name.                                                       |
| `s2RequestToken`                                                   | *string*                                                           | :heavy_minus_sign:                                                 | Client-specified request token for idempotent retries.             |
| `s2Basin`                                                          | *string*                                                           | :heavy_check_mark:                                                 | Basin name for basin-specific endpoints                            |
| `streamConfig`                                                     | [components.StreamConfig](../../models/components/streamconfig.md) | :heavy_minus_sign:                                                 | N/A                                                                |