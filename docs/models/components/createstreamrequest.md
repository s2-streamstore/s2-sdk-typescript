# CreateStreamRequest

## Example Usage

```typescript
import { CreateStreamRequest } from "@s2-dev/streamstore/models/components";

let value: CreateStreamRequest = {
  stream: "<value>",
};
```

## Fields

| Field                                                                                 | Type                                                                                  | Required                                                                              | Description                                                                           |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `config`                                                                              | [components.StreamConfig](../../models/components/streamconfig.md)                    | :heavy_minus_sign:                                                                    | N/A                                                                                   |
| `stream`                                                                              | *string*                                                                              | :heavy_check_mark:                                                                    | Stream name that is unique to the basin.<br/>It can be between 1 and 512 bytes in length. |