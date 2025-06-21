# TimestampingConfig

## Example Usage

```typescript
import { TimestampingConfig } from "@s2-dev/streamstore/models/components";

let value: TimestampingConfig = {};
```

## Fields

| Field                                                                                                                                              | Type                                                                                                                                               | Required                                                                                                                                           | Description                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                                                                                                                                             | [components.TimestampingMode](../../models/components/timestampingmode.md)                                                                         | :heavy_minus_sign:                                                                                                                                 | N/A                                                                                                                                                |
| `uncapped`                                                                                                                                         | *boolean*                                                                                                                                          | :heavy_minus_sign:                                                                                                                                 | Allow client-specified timestamps to exceed the arrival time.<br/>If this is `false` or not set, client timestamps will be capped at the arrival time. |