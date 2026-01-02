## Initial setup

Get an API key from s2.dev (it's free to get started).

```bash
export S2_ACCESS_TOKEN="MY_TOKEN"
```

Create a basin.

```bash
export S2_BASIN="example-$(xxd -l 4 -p /dev/random)"
echo $S2_BASIN
```
This can be done with the S2 CLI:
```bash

s2 create-basin "${S2_BASIN}" --create-stream-on-append
```

Or the create-basin example itself:

TODO