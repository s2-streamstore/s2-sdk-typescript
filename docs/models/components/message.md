# Message

## Example Usage

```typescript
import { Message } from "@s2-dev/streamstore/models/components";

let value: Message = {
  data: {
    nextSeqNum: 258974,
  },
  event: "message",
};
```

## Fields

| Field                                                       | Type                                                        | Required                                                    | Description                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| `data`                                                      | *components.Output*                                         | :heavy_check_mark:                                          | Batch of records or the next sequence number on the stream. |
| `event`                                                     | [components.Event](../../models/components/event.md)        | :heavy_check_mark:                                          | N/A                                                         |