# Batch

Batch of records.
It can only be empty when not in a session context (which implies a limit),
if the first record that could have been retrieved would violate the limit.

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
        seqNum: 978619,
        timestamp: 799159,
      },
    ],
  },
};
```

## Fields

| Field                                                                              | Type                                                                               | Required                                                                           | Description                                                                        |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `batch`                                                                            | [components.SequencedRecordBatch](../../models/components/sequencedrecordbatch.md) | :heavy_check_mark:                                                                 | A batch of sequenced records.                                                      |