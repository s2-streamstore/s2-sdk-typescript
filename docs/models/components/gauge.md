# Gauge

## Example Usage

```typescript
import { Gauge } from "@s2-dev/streamstore/models/components";

let value: Gauge = {
  name: "<value>",
  unit: "bytes",
  values: [],
};
```

## Fields

| Field                                                                                                                                                                  | Type                                                                                                                                                                   | Required                                                                                                                                                               | Description                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                                                                                                                                 | *string*                                                                                                                                                               | :heavy_check_mark:                                                                                                                                                     | Timeseries name.                                                                                                                                                       |
| `unit`                                                                                                                                                                 | [components.MetricUnit](../../models/components/metricunit.md)                                                                                                         | :heavy_check_mark:                                                                                                                                                     | N/A                                                                                                                                                                    |
| `values`                                                                                                                                                               | *components.GaugeValues*[][]                                                                                                                                           | :heavy_check_mark:                                                                                                                                                     | Timeseries values.<br/>Each element is a tuple of a timestamp in Unix epoch seconds and a data point.<br/>The data point represents the value at the instant of the timestamp. |