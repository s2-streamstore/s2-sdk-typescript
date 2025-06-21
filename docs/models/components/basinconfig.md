# BasinConfig

## Example Usage

```typescript
import { BasinConfig } from "@s2-dev/streamstore/models/components";

let value: BasinConfig = {};
```

## Fields

| Field                                                                                | Type                                                                                 | Required                                                                             | Description                                                                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `createStreamOnAppend`                                                               | *boolean*                                                                            | :heavy_minus_sign:                                                                   | Create stream on append if it doesn't exist, using the default stream configuration. |
| `createStreamOnRead`                                                                 | *boolean*                                                                            | :heavy_minus_sign:                                                                   | Create stream on read if it doesn't exist, using the default stream configuration.   |
| `defaultStreamConfig`                                                                | [components.StreamConfig](../../models/components/streamconfig.md)                   | :heavy_minus_sign:                                                                   | N/A                                                                                  |