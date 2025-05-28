# ReadRequest

## Example Usage

```typescript
import { ReadRequest } from "@s2-dev/streamstore/models/operations";

let value: ReadRequest = {
  stream: "<value>",
  s2Basin: "<value>",
};
```

## Fields

| Field                                                                                  | Type                                                                                   | Required                                                                               | Description                                                                            |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `stream`                                                                               | *string*                                                                               | :heavy_check_mark:                                                                     | Stream name.                                                                           |
| `s2Format`                                                                             | [components.S2Format](../../models/components/s2format.md)                             | :heavy_minus_sign:                                                                     | Define treatment of blob fields when exchanging records as JSON.<br/>The default is `raw`. |
| `seqNum`                                                                               | *number*                                                                               | :heavy_minus_sign:                                                                     | Start from a sequence number.                                                          |
| `timestamp`                                                                            | *number*                                                                               | :heavy_minus_sign:                                                                     | Start from a timestamp.                                                                |
| `tailOffset`                                                                           | *number*                                                                               | :heavy_minus_sign:                                                                     | Start from number of records before the tail, i.e. before the next sequence number.    |
| `count`                                                                                | *number*                                                                               | :heavy_minus_sign:                                                                     | Limit total records to return.                                                         |
| `bytes`                                                                                | *number*                                                                               | :heavy_minus_sign:                                                                     | Limit total metered bytes to return.                                                   |
| `s2Basin`                                                                              | *string*                                                                               | :heavy_check_mark:                                                                     | Basin name for basin-specific endpoints                                                |