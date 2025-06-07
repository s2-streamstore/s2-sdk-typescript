# MetricSetResponse

## Example Usage

```typescript
import { MetricSetResponse } from "@s2-dev/streamstore/models/components";

let value: MetricSetResponse = {
  values: [
    {
      gauge: {
        name: "<value>",
        unit: "bytes",
        values: [
          [],
        ],
      },
    },
  ],
};
```

## Fields

| Field                       | Type                        | Required                    | Description                 |
| --------------------------- | --------------------------- | --------------------------- | --------------------------- |
| `values`                    | *components.Metric*[]       | :heavy_check_mark:          | Metrics comprising the set. |