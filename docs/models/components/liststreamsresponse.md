# ListStreamsResponse

## Example Usage

```typescript
import { ListStreamsResponse } from "@s2-dev/streamstore/models/components";

let value: ListStreamsResponse = {
  hasMore: true,
  streams: [
    {
      createdAt: "<value>",
      name: "<value>",
    },
  ],
};
```

## Fields

| Field                                                            | Type                                                             | Required                                                         | Description                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `hasMore`                                                        | *boolean*                                                        | :heavy_check_mark:                                               | Indicates that there are more results that match the criteria.   |
| `streams`                                                        | [components.StreamInfo](../../models/components/streaminfo.md)[] | :heavy_check_mark:                                               | Matching streams.                                                |