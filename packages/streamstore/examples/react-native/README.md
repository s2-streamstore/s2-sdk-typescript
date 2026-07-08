# React Native (Expo) example

A minimal Expo app that appends to and tails an S2 stream from a device,
demonstrating the two things React Native needs:

- a streaming-capable fetch (`expo/fetch`) passed via `S2ClientOptions.fetch`,
  since React Native's built-in fetch buffers response bodies and breaks
  read sessions
- polyfills for globals Hermes lacks: `web-streams-polyfill` (`ReadableStream`)
  and `react-native-get-random-values` (`crypto.getRandomValues`)

Both polyfills load in `index.ts` before the SDK is imported — that order
matters, because the SDK touches `ReadableStream` at module load.

## Run it

```sh
cd examples/react-native
npm install
npx expo start
```

Open the app in Expo Go (or a dev build), then enter an access token, basin,
and stream name. "Connect & tail" creates the stream if needed and starts a
tailing read session; "Append" writes a record, which shows up in the tail.

## Against local SDK source

The example depends on the published `@s2-dev/streamstore`. To test local
changes, build and pack the SDK, then install the tarball:

```sh
cd ../.. && bun run build && npm pack
cd examples/react-native && npm install ../../s2-dev-streamstore-*.tgz
```

## Caveats

- Ship tokens to devices only if they are scoped appropriately (see
  `accessTokens.issue`); for most apps a backend relay is the better design.
- The app must reach `a.s2.dev` / `*.b.s2.dev` (or your `endpoints` override)
  directly from the device.
