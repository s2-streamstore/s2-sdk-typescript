# CheckTailRequest

## Example Usage

```typescript
import { CheckTailRequest } from "@s2-dev/streamstore/models/operations";

let value: CheckTailRequest = {
  stream: "<value>",
  s2Basin: "<value>",
};
```

## Fields

| Field                                   | Type                                    | Required                                | Description                             |
| --------------------------------------- | --------------------------------------- | --------------------------------------- | --------------------------------------- |
| `stream`                                | *string*                                | :heavy_check_mark:                      | Stream name.                            |
| `s2Basin`                               | *string*                                | :heavy_check_mark:                      | Basin name for basin-specific endpoints |