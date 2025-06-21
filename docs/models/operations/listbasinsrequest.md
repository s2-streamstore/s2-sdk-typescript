# ListBasinsRequest

## Example Usage

```typescript
import { ListBasinsRequest } from "@s2-dev/streamstore/models/operations";

let value: ListBasinsRequest = {};
```

## Fields

| Field                                                                                                                                  | Type                                                                                                                                   | Required                                                                                                                               | Description                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `prefix`                                                                                                                               | *string*                                                                                                                               | :heavy_minus_sign:                                                                                                                     | Filter to basins whose names begin with this prefix.                                                                                   |
| `startAfter`                                                                                                                           | *string*                                                                                                                               | :heavy_minus_sign:                                                                                                                     | Filter to basins whose names lexicographically start after this string.<br/>It must be greater than or equal to the `prefix` if specified. |
| `limit`                                                                                                                                | *number*                                                                                                                               | :heavy_minus_sign:                                                                                                                     | Number of results, up to a maximum of 1000.                                                                                            |