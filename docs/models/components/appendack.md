# AppendAck

Success response message to an Append request.

## Example Usage

```typescript
import { AppendAck } from "@s2-dev/streamstore/models/components";

let value: AppendAck = {
  end: {
    seqNum: 858003,
    timestamp: 86925,
  },
  start: {
    seqNum: 124797,
    timestamp: 913959,
  },
  tail: {
    seqNum: 786094,
    timestamp: 783488,
  },
};
```

## Fields

| Field                                                                  | Type                                                                   | Required                                                               | Description                                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `end`                                                                  | [components.StreamPosition](../../models/components/streamposition.md) | :heavy_check_mark:                                                     | Position of a record in a stream.                                      |
| `start`                                                                | [components.StreamPosition](../../models/components/streamposition.md) | :heavy_check_mark:                                                     | Position of a record in a stream.                                      |
| `tail`                                                                 | [components.StreamPosition](../../models/components/streamposition.md) | :heavy_check_mark:                                                     | Position of a record in a stream.                                      |