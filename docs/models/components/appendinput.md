# AppendInput

Payload of an `append` request.

## Example Usage

```typescript
import { AppendInput } from "@s2-dev/streamstore/models/components";

let value: AppendInput = {
  records: [],
};
```

## Fields

| Field                                                                                                                                                                             | Type                                                                                                                                                                              | Required                                                                                                                                                                          | Description                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fencingToken`                                                                                                                                                                    | *string*                                                                                                                                                                          | :heavy_minus_sign:                                                                                                                                                                | Enforce a fencing token, which starts out as an empty string that can be overridden by a `fence` command record.                                                                  |
| `matchSeqNum`                                                                                                                                                                     | *number*                                                                                                                                                                          | :heavy_minus_sign:                                                                                                                                                                | N/A                                                                                                                                                                               |
| `records`                                                                                                                                                                         | [components.AppendRecord](../../models/components/appendrecord.md)[]                                                                                                              | :heavy_check_mark:                                                                                                                                                                | Batch of records to append atomically, which must contain at least one record, and no more than 1000.<br/>The total size of a batch of records may not exceed 1 MiB of metered bytes. |