# AppendConditionFailed

Failure response message when an Append is aborted due to a failed condition.


## Supported Types

### `errors.FencingToken`

```typescript
const value: errors.FencingToken = {
  fencingTokenMismatch: "<value>",
};
```

### `errors.SeqNum`

```typescript
const value: errors.SeqNum = {
  seqNumMismatch: 122504,
};
```

