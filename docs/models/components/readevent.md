# ReadEvent


## Supported Types

### `components.Batch`

```typescript
const value: components.Batch = {
  data: {
    records: [
      {
        seqNum: 773663,
        timestamp: 695060,
      },
    ],
  },
  event: "batch",
  id: "<id>",
};
```

### `components.ReadEvent2`

```typescript
const value: components.ReadEvent2 = {
  data: {
    tail: {
      seqNum: 786094,
      timestamp: 783488,
    },
  },
  event: "tail",
};
```

### `components.ErrorT`

```typescript
const value: components.ErrorT = {
  data: "<value>",
  event: "error",
};
```

### `components.Ping`

```typescript
const value: components.Ping = {
  data: {
    timestamp: 743406,
  },
  event: "ping",
};
```

