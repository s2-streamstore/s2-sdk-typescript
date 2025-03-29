# ReadRequest

## Example Usage

```typescript
import { ReadRequest } from "@s2-dev/streamstore/models/operations";

let value: ReadRequest = {
  stream: "<value>",
};
```

## Fields

| Field                                                                                                                                    | Type                                                                                                                                     | Required                                                                                                                                 | Description                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `startSeqNum`                                                                                                                            | *number*                                                                                                                                 | :heavy_minus_sign:                                                                                                                       | Starting sequence number (inclusive).                                                                                                    |
| `limit`                                                                                                                                  | [operations.Limit](../../models/operations/limit.md)                                                                                     | :heavy_minus_sign:                                                                                                                       | Limit how many records can be returned.<br/>This will get capped at the default limit,<br/>which is up to 1000 records or 1MiB of metered bytes. |
| `s2Format`                                                                                                                               | *operations.S2Format*                                                                                                                    | :heavy_minus_sign:                                                                                                                       | json: utf-8 plaintext data.<br/>json-binsafe: base64 encoded binary data.                                                                |
| `stream`                                                                                                                                 | *string*                                                                                                                                 | :heavy_check_mark:                                                                                                                       | Name of the stream.                                                                                                                      |