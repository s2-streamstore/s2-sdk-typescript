# Three

A named series of (timestamp, value) points each representing an instantaneous value.

## Example Usage

```typescript
import { Three } from "@s2-dev/streamstore/models/components";

let value: Three = {
  gauge: {
    name: "<value>",
    unit: "bytes",
    values: [
      [],
    ],
  },
};
```

## Fields

| Field                                                | Type                                                 | Required                                             | Description                                          |
| ---------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| `gauge`                                              | [components.Gauge](../../models/components/gauge.md) | :heavy_check_mark:                                   | N/A                                                  |