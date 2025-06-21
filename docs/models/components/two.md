# Two

Named series of `(timestamp, value)` points representing an accumulation over a specified
bucket.

## Example Usage

```typescript
import { Two } from "@s2-dev/streamstore/models/components";

let value: Two = {
  accumulation: {
    bucketLength: "day",
    name: "<value>",
    unit: "bytes",
    values: [
      [],
    ],
  },
};
```

## Fields

| Field                                                              | Type                                                               | Required                                                           | Description                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `accumulation`                                                     | [components.Accumulation](../../models/components/accumulation.md) | :heavy_check_mark:                                                 | N/A                                                                |