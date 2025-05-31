# ReadEvent


## Supported Types

### `components.Batch`

```typescript
const value: components.Batch = {
  data: {
    records: [
      {
        seqNum: 634244,
        timestamp: 40328,
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
      seqNum: 682558,
      timestamp: 286393,
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
    timestamp: 352303,
  },
  event: "ping",
};
```

