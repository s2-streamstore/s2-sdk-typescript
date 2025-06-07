# Batch

## Example Usage

```typescript
import { Batch } from "@s2-dev/streamstore/models/components";

let value: Batch = {
  data: {
    records: [
      {
        seqNum: 773663,
        timestamp: 695060,
      },
    ],
  },
  event: "batch",
  id: "<id>",
};
```

## Fields

| Field                                                        | Type                                                         | Required                                                     | Description                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `data`                                                       | [components.ReadBatch](../../models/components/readbatch.md) | :heavy_check_mark:                                           | N/A                                                          |
| `event`                                                      | [components.Event](../../models/components/event.md)         | :heavy_check_mark:                                           | N/A                                                          |
| `id`                                                         | *string*                                                     | :heavy_check_mark:                                           | N/A                                                          |