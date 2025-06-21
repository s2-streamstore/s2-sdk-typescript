# Metric1

Single named value.

## Example Usage

```typescript
import { Metric1 } from "@s2-dev/streamstore/models/components";

let value: Metric1 = {
  scalar: {
    name: "<value>",
    unit: "operations",
    value: 4809.88,
  },
};
```

## Fields

| Field                                                  | Type                                                   | Required                                               | Description                                            |
| ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------ |
| `scalar`                                               | [components.Scalar](../../models/components/scalar.md) | :heavy_check_mark:                                     | N/A                                                    |