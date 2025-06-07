# ReconfigureBasinRequest

## Example Usage

```typescript
import { ReconfigureBasinRequest } from "@s2-dev/streamstore/models/operations";

let value: ReconfigureBasinRequest = {
  basin: "<value>",
};
```

## Fields

| Field                                                                              | Type                                                                               | Required                                                                           | Description                                                                        |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `basin`                                                                            | *string*                                                                           | :heavy_check_mark:                                                                 | Basin name.                                                                        |
| `basinReconfiguration`                                                             | [components.BasinReconfiguration](../../models/components/basinreconfiguration.md) | :heavy_check_mark:                                                                 | N/A                                                                                |