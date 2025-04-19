# CheckTailResponse

Check tail response.

## Example Usage

```typescript
import { CheckTailResponse } from "@s2-dev/streamstore/models/components";

let value: CheckTailResponse = {
  nextSeqNum: 844206,
};
```

## Fields

| Field                                                                   | Type                                                                    | Required                                                                | Description                                                             |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `nextSeqNum`                                                            | *number*                                                                | :heavy_check_mark:                                                      | Sequence number that will be assigned to the next record on the stream. |