# TailResponse

## Example Usage

```typescript
import { TailResponse } from "@s2-dev/streamstore/models/components";

let value: TailResponse = {
  tail: {
    seqNum: 786094,
    timestamp: 783488,
  },
};
```

## Fields

| Field                                                                  | Type                                                                   | Required                                                               | Description                                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `tail`                                                                 | [components.StreamPosition](../../models/components/streamposition.md) | :heavy_check_mark:                                                     | Position of a record in a stream.                                      |