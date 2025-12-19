# @s2-dev/streamstore

## 0.20.0

### Minor Changes

- 49e851c: Fix error messages to contain more info

## 0.19.5

### Patch Changes

- 40ec9ce: Fix liveness timer issue for fetch-transport read session

## 0.19.4

### Patch Changes

- 12aca9c: Revert fix for fetch read session timeouts

## 0.19.3

### Patch Changes

- 7ccd6ce: Fix timeout logic for resumable read sessions with fetch transport

## 0.19.2

### Patch Changes

- dc6919c: Fixes bug around base64 encoding of binary append records when batches include mixed string/byte records

## 0.19.1

### Patch Changes

- 9ea91b5: Use static node:http2 import, and ignore from bundlers

## 0.19.0

### Minor Changes

- f79de6a: Gate node http/2 package for web bundling
