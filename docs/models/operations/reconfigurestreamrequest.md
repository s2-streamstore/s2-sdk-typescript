# ReconfigureStreamRequest

## Example Usage

```typescript
import { ReconfigureStreamRequest } from "@s2-dev/streamstore/models/operations";

let value: ReconfigureStreamRequest = {
  stream: "<value>",
  s2Basin: "<value>",
};
```

## Fields

| Field                                                                                | Type                                                                                 | Required                                                                             | Description                                                                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `stream`                                                                             | *string*                                                                             | :heavy_check_mark:                                                                   | Stream name.                                                                         |
| `s2Basin`                                                                            | *string*                                                                             | :heavy_check_mark:                                                                   | Basin name for basin-specific endpoints                                              |
| `streamReconfiguration`                                                              | [components.StreamReconfiguration](../../models/components/streamreconfiguration.md) | :heavy_check_mark:                                                                   | N/A                                                                                  |