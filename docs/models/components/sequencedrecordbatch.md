# SequencedRecordBatch

A batch of sequenced records.

## Example Usage

```typescript
import { SequencedRecordBatch } from "@s2-dev/streamstore/models/components";

let value: SequencedRecordBatch = {
  records: [
    {
      body: "<value>",
      headers: [
        {
          name: "<value>",
          value: "<value>",
        },
      ],
      seqNum: 152032,
      timestamp: 163517,
    },
  ],
};
```

## Fields

| Field                                                                      | Type                                                                       | Required                                                                   | Description                                                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `records`                                                                  | [components.SequencedRecord](../../models/components/sequencedrecord.md)[] | :heavy_check_mark:                                                         | Batch of sequenced records.                                                |