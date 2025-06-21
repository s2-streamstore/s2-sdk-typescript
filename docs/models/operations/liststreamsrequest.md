# ListStreamsRequest

## Example Usage

```typescript
import { ListStreamsRequest } from "@s2-dev/streamstore/models/operations";

let value: ListStreamsRequest = {
  s2Basin: "<value>",
};
```

## Fields

| Field                                                                                                                | Type                                                                                                                 | Required                                                                                                             | Description                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `prefix`                                                                                                             | *string*                                                                                                             | :heavy_minus_sign:                                                                                                   | Filter to streams whose name begins with this prefix.                                                                |
| `startAfter`                                                                                                         | *string*                                                                                                             | :heavy_minus_sign:                                                                                                   | Filter to streams whose name begins with this prefix.<br/>It must be greater than or equal to the `prefix` if specified. |
| `limit`                                                                                                              | *number*                                                                                                             | :heavy_minus_sign:                                                                                                   | Number of results, up to a maximum of 1000.                                                                          |
| `s2Basin`                                                                                                            | *string*                                                                                                             | :heavy_check_mark:                                                                                                   | Basin name for basin-specific endpoints                                                                              |