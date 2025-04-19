# Output

Batch of records or the next sequence number on the stream.


## Supported Types

### `components.Batch`

```typescript
const value: components.Batch = {
  batch: {
    records: [
      {
        body: "<value>",
        headers: [
          {
            name: "<value>",
            value: "<value>",
          },
        ],
        seqNum: 634244,
        timestamp: 40328,
      },
    ],
  },
};
```

### `components.NextSeqNum`

```typescript
const value: components.NextSeqNum = {
  nextSeqNum: 465230,
};
```

