# Batch

Batch of records.
It can only be empty outside of a session context,
if the request cannot be satisfied without violating its limit.

## Example Usage

```typescript
import { Batch } from "@s2-dev/streamstore/models/components";

let value: Batch = {
  batch: {
    records: [
      {
        body: "<value>",
        headers: [
          {
            name: "<value>",
            value: "<value>",
          },
        ],
        seqNum: 793742,
        timestamp: 773663,
      },
    ],
  },
};
```

## Fields

| Field                                                                              | Type                                                                               | Required                                                                           | Description                                                                        |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `batch`                                                                            | [components.SequencedRecordBatch](../../models/components/sequencedrecordbatch.md) | :heavy_check_mark:                                                                 | A batch of sequenced records.                                                      |