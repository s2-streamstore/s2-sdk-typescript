# FirstSeqNum

Sequence number for the first record on this stream.
Typically this will be returned when the requested `start_seq_num` was smaller.
It may also be returned during a session, if the stream gets concurrently trimmed.

## Example Usage

```typescript
import { FirstSeqNum } from "@s2-dev/streamstore/models/components";

let value: FirstSeqNum = {
  firstSeqNum: 870013,
};
```

## Fields

| Field                                                                                                                                                                                                                   | Type                                                                                                                                                                                                                    | Required                                                                                                                                                                                                                | Description                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `firstSeqNum`                                                                                                                                                                                                           | *number*                                                                                                                                                                                                                | :heavy_check_mark:                                                                                                                                                                                                      | Sequence number for the first record on this stream.<br/>Typically this will be returned when the requested `start_seq_num` was smaller.<br/>It may also be returned during a session, if the stream gets concurrently trimmed. |