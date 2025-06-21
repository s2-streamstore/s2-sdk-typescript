# AccountMetricsRequest

## Example Usage

```typescript
import { AccountMetricsRequest } from "@s2-dev/streamstore/models/operations";

let value: AccountMetricsRequest = {
  set: "account-ops",
};
```

## Fields

| Field                                                                          | Type                                                                           | Required                                                                       | Description                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `set`                                                                          | [components.AccountMetricSet](../../models/components/accountmetricset.md)     | :heavy_check_mark:                                                             | Metric set to return.                                                          |
| `start`                                                                        | *number*                                                                       | :heavy_minus_sign:                                                             | Start timestamp as Unix epoch seconds, if applicable for the metric set.       |
| `end`                                                                          | *number*                                                                       | :heavy_minus_sign:                                                             | End timestamp as Unix epoch seconds, if applicable for the metric set.         |
| `interval`                                                                     | [components.TimeseriesInterval](../../models/components/timeseriesinterval.md) | :heavy_minus_sign:                                                             | Interval to aggregate over for timeseries metric sets.                         |