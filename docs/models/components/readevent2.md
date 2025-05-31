# ReadEvent2

## Example Usage

```typescript
import { ReadEvent2 } from "@s2-dev/streamstore/models/components";

let value: ReadEvent2 = {
  data: {
    tail: {
      seqNum: 786094,
      timestamp: 783488,
    },
  },
  event: "tail",
};
```

## Fields

| Field                                                                  | Type                                                                   | Required                                                               | Description                                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `data`                                                                 | [components.TailResponse](../../models/components/tailresponse.md)     | :heavy_check_mark:                                                     | N/A                                                                    |
| `event`                                                                | [components.ReadEventEvent](../../models/components/readeventevent.md) | :heavy_check_mark:                                                     | N/A                                                                    |