# Output

Batch of records, or a sequence number if the read could not be satisfied.
An empty batch or a sequence number output will be a terminal message in a session.


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
        seqNum: 461479,
        timestamp: 780529,
      },
    ],
  },
};
```

### `components.FirstSeqNum`

```typescript
const value: components.FirstSeqNum = {
  firstSeqNum: 118274,
};
```

### `components.NextSeqNum`

```typescript
const value: components.NextSeqNum = {
  nextSeqNum: 639921,
};
```

