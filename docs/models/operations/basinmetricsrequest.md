# BasinMetricsRequest

## Example Usage

```typescript
import { BasinMetricsRequest } from "@s2-dev/streamstore/models/operations";

let value: BasinMetricsRequest = {
  set: "read_throughput",
  basin: "<value>",
};
```

## Fields

| Field                                                                          | Type                                                                           | Required                                                                       | Description                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `set`                                                                          | [components.BasinMetricSet](../../models/components/basinmetricset.md)         | :heavy_check_mark:                                                             | Metric type to return.                                                         |
| `start`                                                                        | *number*                                                                       | :heavy_minus_sign:                                                             | Start timestamp, in Unix epoch seconds, if applicable for metric set.          |
| `end`                                                                          | *number*                                                                       | :heavy_minus_sign:                                                             | End timestamp, in Unix epoch seconds, if applicable for metric set.            |
| `interval`                                                                     | [components.TimeseriesInterval](../../models/components/timeseriesinterval.md) | :heavy_minus_sign:                                                             | For timeseries metric sets, the interval to aggregate over.                    |
| `basin`                                                                        | *string*                                                                       | :heavy_check_mark:                                                             | Basin name.                                                                    |