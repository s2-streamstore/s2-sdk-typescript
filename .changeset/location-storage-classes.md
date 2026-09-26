---
"@s2-dev/streamstore": minor
---

Expose `storageClasses` and `defaultStorageClass` on location responses.

**Breaking:** Remove the `StorageClass` type export and use `string` for storage-class names. Replace imports of `StorageClass` with `string`, and discover available values with `s2.locations.list()`. Omission and null reset behavior are unchanged.
