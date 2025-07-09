# ListStreamsResponse

## Example Usage

```typescript
import { ListStreamsResponse } from "@s2-dev/streamstore/models/operations";

let value: ListStreamsResponse = {
  result: {
    hasMore: true,
    streams: [
      {
        createdAt: "<value>",
        name: "<value>",
      },
    ],
  },
};
```

## Fields

| Field                                                                            | Type                                                                             | Required                                                                         | Description                                                                      |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `result`                                                                         | [components.ListStreamsResponse](../../models/components/liststreamsresponse.md) | :heavy_check_mark:                                                               | N/A                                                                              |