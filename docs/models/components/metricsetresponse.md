# MetricSetResponse

## Example Usage

```typescript
import { MetricSetResponse } from "@s2-dev/streamstore/models/components";

let value: MetricSetResponse = {
  values: [
    {
      label: {
        name: "<value>",
        values: [
          "<value>",
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