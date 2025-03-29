# Message

## Example Usage

```typescript
import { Message } from "@s2-dev/streamstore/models/components";

let value: Message = {
  data: {
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
          seqNum: 774234,
          timestamp: 456150,
        },
      ],
    },
  },
  event: "message",
};
```

## Fields

| Field                                                                                                                                                          | Type                                                                                                                                                           | Required                                                                                                                                                       | Description                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`                                                                                                                                                         | *components.Output*                                                                                                                                            | :heavy_check_mark:                                                                                                                                             | Batch of records, or a sequence number if the read could not be satisfied.<br/>An empty batch or a sequence number output will be a terminal message in a session. |
| `event`                                                                                                                                                        | [components.Event](../../models/components/event.md)                                                                                                           | :heavy_check_mark:                                                                                                                                             | N/A                                                                                                                                                            |