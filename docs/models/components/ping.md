# Ping

## Example Usage

```typescript
import { Ping } from "@s2-dev/streamstore/models/components";

let value: Ping = {
  data: {
    timestamp: 743406,
  },
  event: "ping",
};
```

## Fields

| Field                                                                    | Type                                                                     | Required                                                                 | Description                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `data`                                                                   | [components.PingEventData](../../models/components/pingeventdata.md)     | :heavy_check_mark:                                                       | N/A                                                                      |
| `event`                                                                  | [components.ReadEvent4Event](../../models/components/readevent4event.md) | :heavy_check_mark:                                                       | N/A                                                                      |