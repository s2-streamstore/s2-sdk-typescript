# ReadBatch

## Example Usage

```typescript
import { ReadBatch } from "@s2-dev/streamstore/models/components";

let value: ReadBatch = {
  records: [],
};
```

## Fields

| Field                                                                                        | Type                                                                                         | Required                                                                                     | Description                                                                                  |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `records`                                                                                    | [components.SequencedRecord](../../models/components/sequencedrecord.md)[]                   | :heavy_check_mark:                                                                           | Records that are durably sequenced on the stream, retrieved based on the requested criteria. |
| `tail`                                                                                       | [components.StreamPosition](../../models/components/streamposition.md)                       | :heavy_minus_sign:                                                                           | N/A                                                                                          |