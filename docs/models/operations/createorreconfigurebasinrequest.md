# CreateOrReconfigureBasinRequest

## Example Usage

```typescript
import { CreateOrReconfigureBasinRequest } from "@s2-dev/streamstore/models/operations";

let value: CreateOrReconfigureBasinRequest = {
  basin: "<value>",
};
```

## Fields

| Field                                                                                                    | Type                                                                                                     | Required                                                                                                 | Description                                                                                              |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `s2RequestToken`                                                                                         | *string*                                                                                                 | :heavy_minus_sign:                                                                                       | Client-specified request token for idempotent retries.                                                   |
| `basin`                                                                                                  | *string*                                                                                                 | :heavy_check_mark:                                                                                       | Basin name.                                                                                              |
| `createOrReconfigureBasinRequest`                                                                        | [components.CreateOrReconfigureBasinRequest](../../models/components/createorreconfigurebasinrequest.md) | :heavy_minus_sign:                                                                                       | N/A                                                                                                      |