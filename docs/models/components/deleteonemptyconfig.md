# DeleteOnEmptyConfig

## Example Usage

```typescript
import { DeleteOnEmptyConfig } from "@s2-dev/streamstore/models/components";

let value: DeleteOnEmptyConfig = {};
```

## Fields

| Field                                                                                                                                     | Type                                                                                                                                      | Required                                                                                                                                  | Description                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `minAgeSecs`                                                                                                                              | *number*                                                                                                                                  | :heavy_minus_sign:                                                                                                                        | Minimum age in seconds before an empty stream can be deleted.<br/>Set to 0 (default) to disable delete-on-empty (don't delete automatically). |