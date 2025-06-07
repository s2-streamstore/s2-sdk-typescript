# AppendInput

Payload of an Append request message.

## Example Usage

```typescript
import { AppendInput } from "@s2-dev/streamstore/models/components";

let value: AppendInput = {
  records: [],
};
```

## Fields

| Field                                                                                                                                                                            | Type                                                                                                                                                                             | Required                                                                                                                                                                         | Description                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fencingToken`                                                                                                                                                                   | *string*                                                                                                                                                                         | :heavy_minus_sign:                                                                                                                                                               | Enforce a fencing token which must have been previously set by a `fence` command record.                                                                                         |
| `matchSeqNum`                                                                                                                                                                    | *number*                                                                                                                                                                         | :heavy_minus_sign:                                                                                                                                                               | N/A                                                                                                                                                                              |
| `records`                                                                                                                                                                        | [components.AppendRecord](../../models/components/appendrecord.md)[]                                                                                                             | :heavy_check_mark:                                                                                                                                                               | Batch of records to append atomically, which must contain at least one record, and no more<br/>than 1000. The total size of a batch of records may not exceed 1MiB of metered bytes. |