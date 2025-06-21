# StreamPosition

Position of a record in a stream.

## Example Usage

```typescript
import { StreamPosition } from "@s2-dev/streamstore/models/components";

let value: StreamPosition = {
  seqNum: 618722,
  timestamp: 868161,
};
```

## Fields

| Field                                                                                                                                                   | Type                                                                                                                                                    | Required                                                                                                                                                | Description                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seqNum`                                                                                                                                                | *number*                                                                                                                                                | :heavy_check_mark:                                                                                                                                      | Sequence number assigned by the service.                                                                                                                |
| `timestamp`                                                                                                                                             | *number*                                                                                                                                                | :heavy_check_mark:                                                                                                                                      | Timestamp, which may be client-specified or assigned by the service.<br/>If it is assigned by the service, it will represent milliseconds since Unix epoch. |