# AppendRequest

## Example Usage

```typescript
import { AppendRequest } from "@s2-dev/streamstore/models/operations";

let value: AppendRequest = {
  stream: "<value>",
  s2Basin: "<value>",
  appendInput: {
    records: [
      {},
    ],
  },
};
```

## Fields

| Field                                                                                  | Type                                                                                   | Required                                                                               | Description                                                                            |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `stream`                                                                               | *string*                                                                               | :heavy_check_mark:                                                                     | Stream name.                                                                           |
| `s2Format`                                                                             | [components.S2Format](../../models/components/s2format.md)                             | :heavy_minus_sign:                                                                     | Define treatment of blob fields when exchanging records as JSON.<br/>The default is `raw`. |
| `s2Basin`                                                                              | *string*                                                                               | :heavy_check_mark:                                                                     | Basin name for basin-specific endpoints                                                |
| `appendInput`                                                                          | [components.AppendInput](../../models/components/appendinput.md)                       | :heavy_check_mark:                                                                     | N/A                                                                                    |