# ListBasinsResponse

## Example Usage

```typescript
import { ListBasinsResponse } from "@s2-dev/streamstore/models/operations";

let value: ListBasinsResponse = {
  result: {
    basins: [
      {
        name: "<value>",
        scope: "unspecified",
        state: "deleting",
      },
    ],
    hasMore: false,
  },
};
```

## Fields

| Field                                                                          | Type                                                                           | Required                                                                       | Description                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `result`                                                                       | [components.ListBasinsResponse](../../models/components/listbasinsresponse.md) | :heavy_check_mark:                                                             | N/A                                                                            |