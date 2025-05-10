# ReconfigureStreamRequest

## Example Usage

```typescript
import { ReconfigureStreamRequest } from "@s2-dev/streamstore/models/operations";

let value: ReconfigureStreamRequest = {
  stream: "<value>",
  streamReconfiguration: {},
};
```

## Fields

| Field                                                                                                                                                                         | Type                                                                                                                                                                          | Required                                                                                                                                                                      | Description                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stream`                                                                                                                                                                      | *string*                                                                                                                                                                      | :heavy_check_mark:                                                                                                                                                            | Stream name, which must be unique within the basin.<br/>It can be an arbitrary string upto 512 characters.<br/>Backslash (`/`) is recommended as a delimiter for hierarchical naming. |
| `streamReconfiguration`                                                                                                                                                       | [components.StreamReconfiguration](../../models/components/streamreconfiguration.md)                                                                                          | :heavy_check_mark:                                                                                                                                                            | N/A                                                                                                                                                                           |