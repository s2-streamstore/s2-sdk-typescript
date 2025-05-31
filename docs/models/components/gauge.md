# Gauge

## Example Usage

```typescript
import { Gauge } from "@s2-dev/streamstore/models/components";

let value: Gauge = {
  name: "<value>",
  unit: "bytes",
  values: [
    [
      315000,
    ],
  ],
};
```

## Fields

| Field                                                                                                                                                                              | Type                                                                                                                                                                               | Required                                                                                                                                                                           | Description                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                                                                                                                                             | *string*                                                                                                                                                                           | :heavy_check_mark:                                                                                                                                                                 | Timeseries name.                                                                                                                                                                   |
| `unit`                                                                                                                                                                             | [components.MetricUnit](../../models/components/metricunit.md)                                                                                                                     | :heavy_check_mark:                                                                                                                                                                 | N/A                                                                                                                                                                                |
| `values`                                                                                                                                                                           | *components.GaugeValues*[][]                                                                                                                                                       | :heavy_check_mark:                                                                                                                                                                 | Timeseries values.<br/><br/>Each element is a tuple containing the seconds since Unix epoch, followed by the data<br/>point.<br/><br/>The data point represents the value at the instant of the epoch. |