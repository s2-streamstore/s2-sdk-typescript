# Metric


## Supported Types

### `components.Metric1`

```typescript
const value: components.Metric1 = {
  scalar: {
    name: "<value>",
    unit: "operations",
    value: 6.86,
  },
};
```

### `components.Two`

```typescript
const value: components.Two = {
  accumulation: {
    bucketLength: "minute",
    name: "<value>",
    unit: "operations",
    values: [
      [
        1949.27,
      ],
    ],
  },
};
```

### `components.Three`

```typescript
const value: components.Three = {
  gauge: {
    name: "<value>",
    unit: "bytes",
    values: [
      [
        482494,
      ],
    ],
  },
};
```

### `components.Four`

```typescript
const value: components.Four = {
  label: {
    name: "<value>",
    values: [
      "<value>",
    ],
  },
};
```

