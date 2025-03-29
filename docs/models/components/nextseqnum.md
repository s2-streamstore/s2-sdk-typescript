# NextSeqNum

Sequence number that will be assigned to the next record on this stream.
This will be returned either because the requested `start_seq_num` was larger,
or in case of a limited read, equal to it.

## Example Usage

```typescript
import { NextSeqNum } from "@s2-dev/streamstore/models/components";

let value: NextSeqNum = {
  nextSeqNum: 778157,
};
```

## Fields

| Field                                                                                                                                                                                              | Type                                                                                                                                                                                               | Required                                                                                                                                                                                           | Description                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nextSeqNum`                                                                                                                                                                                       | *number*                                                                                                                                                                                           | :heavy_check_mark:                                                                                                                                                                                 | Sequence number that will be assigned to the next record on this stream.<br/>This will be returned either because the requested `start_seq_num` was larger,<br/>or in case of a limited read, equal to it. |