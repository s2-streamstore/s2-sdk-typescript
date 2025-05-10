# StreamInfo

## Example Usage

```typescript
import { StreamInfo } from "@s2-dev/streamstore/models/components";

let value: StreamInfo = {
  createdAt: "<value>",
  name: "<value>",
};
```

## Fields

| Field                                                             | Type                                                              | Required                                                          | Description                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| `createdAt`                                                       | *string*                                                          | :heavy_check_mark:                                                | Creation time in ISO 8601 format.                                 |
| `deletedAt`                                                       | *string*                                                          | :heavy_minus_sign:                                                | Deletion time in ISO 8601 format, if the stream is being deleted. |
| `name`                                                            | *string*                                                          | :heavy_check_mark:                                                | Stream name.                                                      |