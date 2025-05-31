# Scalar

## Example Usage

```typescript
import { Scalar } from "@s2-dev/streamstore/models/components";

let value: Scalar = {
  name: "<value>",
  unit: "bytes",
  value: 7939.48,
};
```

## Fields

| Field                                                          | Type                                                           | Required                                                       | Description                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| `name`                                                         | *string*                                                       | :heavy_check_mark:                                             | Metric name.                                                   |
| `unit`                                                         | [components.MetricUnit](../../models/components/metricunit.md) | :heavy_check_mark:                                             | N/A                                                            |
| `value`                                                        | *number*                                                       | :heavy_check_mark:                                             | Metric value.                                                  |