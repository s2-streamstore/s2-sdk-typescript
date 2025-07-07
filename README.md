# streamstore

Developer-friendly & type-safe TypeScript SDK specifically catered to leverage *streamstore* API.

<div align="left">
    <a href="https://www.speakeasy.com/?utm_source=streamstore&utm_campaign=typescript"><img src="https://custom-icon-badges.demolab.com/badge/-Built%20By%20Speakeasy-212015?style=for-the-badge&logoColor=FBE331&logo=speakeasy&labelColor=545454" /></a>
    <a href="https://opensource.org/licenses/MIT">
        <img src="https://img.shields.io/badge/License-MIT-blue.svg" style="width: 100px; height: 28px;" />
    </a>
</div>


<br /><br />
<!-- Start Summary [summary] -->
## Summary

S2 API: Serverless API for streaming data backed by object storage.
<!-- End Summary [summary] -->

<!-- Start Table of Contents [toc] -->
## Table of Contents
<!-- $toc-max-depth=2 -->
* [streamstore](#streamstore)
  * [SDK Installation](#sdk-installation)
  * [Requirements](#requirements)
  * [SDK Example Usage](#sdk-example-usage)
  * [Authentication](#authentication)
  * [Available Resources and Operations](#available-resources-and-operations)
  * [Standalone functions](#standalone-functions)
  * [Server-sent event streaming](#server-sent-event-streaming)
  * [Pagination](#pagination)
  * [Retries](#retries)
  * [Error Handling](#error-handling)
  * [Server Selection](#server-selection)
  * [Custom HTTP Client](#custom-http-client)
  * [Debugging](#debugging)
* [Development](#development)
  * [Maturity](#maturity)
  * [Contributions](#contributions)

<!-- End Table of Contents [toc] -->

<!-- Start SDK Installation [installation] -->
## SDK Installation

The SDK can be installed with either [npm](https://www.npmjs.com/), [pnpm](https://pnpm.io/), [bun](https://bun.sh/) or [yarn](https://classic.yarnpkg.com/en/) package managers.

### NPM

```bash
npm add @s2-dev/streamstore
```

### PNPM

```bash
pnpm add @s2-dev/streamstore
```

### Bun

```bash
bun add @s2-dev/streamstore
```

### Yarn

```bash
yarn add @s2-dev/streamstore zod

# Note that Yarn does not install peer dependencies automatically. You will need
# to install zod as shown above.
```

> [!NOTE]
> This package is published with CommonJS and ES Modules (ESM) support.


### Model Context Protocol (MCP) Server

This SDK is also an installable MCP server where the various SDK methods are
exposed as tools that can be invoked by AI applications.

> Node.js v20 or greater is required to run the MCP server from npm.

<details>
<summary>Claude installation steps</summary>

Add the following server definition to your `claude_desktop_config.json` file:

```json
{
  "mcpServers": {
    "S2": {
      "command": "npx",
      "args": [
        "-y", "--package", "@s2-dev/streamstore",
        "--",
        "mcp", "start",
        "--access-token", "..."
      ]
    }
  }
}
```

</details>

<details>
<summary>Cursor installation steps</summary>

Create a `.cursor/mcp.json` file in your project root with the following content:

```json
{
  "mcpServers": {
    "S2": {
      "command": "npx",
      "args": [
        "-y", "--package", "@s2-dev/streamstore",
        "--",
        "mcp", "start",
        "--access-token", "..."
      ]
    }
  }
}
```

</details>

You can also run MCP servers as a standalone binary with no additional dependencies. You must pull these binaries from available Github releases:

```bash
curl -L -o mcp-server \
    https://github.com/{org}/{repo}/releases/download/{tag}/mcp-server-bun-darwin-arm64 && \
chmod +x mcp-server
```

If the repo is a private repo you must add your Github PAT to download a release `-H "Authorization: Bearer {GITHUB_PAT}"`.


```json
{
  "mcpServers": {
    "Todos": {
      "command": "./DOWNLOAD/PATH/mcp-server",
      "args": [
        "start"
      ]
    }
  }
}
```

For a full list of server arguments, run:

```sh
npx -y --package @s2-dev/streamstore -- mcp start --help
```
<!-- End SDK Installation [installation] -->

<!-- Start Requirements [requirements] -->
## Requirements

For supported JavaScript runtimes, please consult [RUNTIMES.md](RUNTIMES.md).
<!-- End Requirements [requirements] -->

<!-- Start SDK Example Usage [usage] -->
## SDK Example Usage

### Example

```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const result = await s2.accessTokens.listAccessTokens({});

  console.log(result);
}

run();

```
<!-- End SDK Example Usage [usage] -->

<!-- Start Authentication [security] -->
## Authentication

### Per-Client Security Schemes

This SDK supports the following security scheme globally:

| Name          | Type | Scheme      | Environment Variable |
| ------------- | ---- | ----------- | -------------------- |
| `accessToken` | http | HTTP Bearer | `S2_ACCESS_TOKEN`    |

To authenticate with the API the `accessToken` parameter must be set when initializing the SDK client instance. For example:
```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const result = await s2.accessTokens.listAccessTokens({});

  console.log(result);
}

run();

```
<!-- End Authentication [security] -->

<!-- Start Available Resources and Operations [operations] -->
## Available Resources and Operations

<details open>
<summary>Available methods</summary>

### [accessTokens](docs/sdks/accesstokens/README.md)

* [listAccessTokens](docs/sdks/accesstokens/README.md#listaccesstokens) - List access tokens.
* [issueAccessToken](docs/sdks/accesstokens/README.md#issueaccesstoken) - Issue a new access token.
* [revokeAccessToken](docs/sdks/accesstokens/README.md#revokeaccesstoken) - Revoke an access token.

### [basins](docs/sdks/basins/README.md)

* [listBasins](docs/sdks/basins/README.md#listbasins) - List basins.
* [createBasin](docs/sdks/basins/README.md#createbasin) - Create a basin.
* [getBasinConfig](docs/sdks/basins/README.md#getbasinconfig) - Get basin configuration.
* [createOrReconfigureBasin](docs/sdks/basins/README.md#createorreconfigurebasin) - Create or reconfigure a basin.
* [deleteBasin](docs/sdks/basins/README.md#deletebasin) - Delete a basin.
* [reconfigureBasin](docs/sdks/basins/README.md#reconfigurebasin) - Reconfigure a basin.

### [metrics](docs/sdks/metrics/README.md)

* [accountMetrics](docs/sdks/metrics/README.md#accountmetrics) - Account-level metrics.
* [basinMetrics](docs/sdks/metrics/README.md#basinmetrics) - Basin-level metrics.
* [streamMetrics](docs/sdks/metrics/README.md#streammetrics) - Stream-level metrics.

### [records](docs/sdks/records/README.md)

* [read](docs/sdks/records/README.md#read) - Read records.
* [append](docs/sdks/records/README.md#append) - Append records.
* [checkTail](docs/sdks/records/README.md#checktail) - Check the tail.


### [streams](docs/sdks/streams/README.md)

* [listStreams](docs/sdks/streams/README.md#liststreams) - List streams.
* [createStream](docs/sdks/streams/README.md#createstream) - Create a stream.
* [getStreamConfig](docs/sdks/streams/README.md#getstreamconfig) - Get stream configuration.
* [createOrReconfigureStream](docs/sdks/streams/README.md#createorreconfigurestream) - Create or reconfigure a stream.
* [deleteStream](docs/sdks/streams/README.md#deletestream) - Delete a stream.
* [reconfigureStream](docs/sdks/streams/README.md#reconfigurestream) - Reconfigure a stream.

</details>
<!-- End Available Resources and Operations [operations] -->

<!-- Start Standalone functions [standalone-funcs] -->
## Standalone functions

All the methods listed above are available as standalone functions. These
functions are ideal for use in applications running in the browser, serverless
runtimes or other environments where application bundle size is a primary
concern. When using a bundler to build your application, all unused
functionality will be either excluded from the final bundle or tree-shaken away.

To read more about standalone functions, check [FUNCTIONS.md](./FUNCTIONS.md).

<details>

<summary>Available standalone functions</summary>

- [`accessTokensIssueAccessToken`](docs/sdks/accesstokens/README.md#issueaccesstoken) - Issue a new access token.
- [`accessTokensListAccessTokens`](docs/sdks/accesstokens/README.md#listaccesstokens) - List access tokens.
- [`accessTokensRevokeAccessToken`](docs/sdks/accesstokens/README.md#revokeaccesstoken) - Revoke an access token.
- [`basinsCreateBasin`](docs/sdks/basins/README.md#createbasin) - Create a basin.
- [`basinsCreateOrReconfigureBasin`](docs/sdks/basins/README.md#createorreconfigurebasin) - Create or reconfigure a basin.
- [`basinsDeleteBasin`](docs/sdks/basins/README.md#deletebasin) - Delete a basin.
- [`basinsGetBasinConfig`](docs/sdks/basins/README.md#getbasinconfig) - Get basin configuration.
- [`basinsListBasins`](docs/sdks/basins/README.md#listbasins) - List basins.
- [`basinsReconfigureBasin`](docs/sdks/basins/README.md#reconfigurebasin) - Reconfigure a basin.
- [`metricsAccountMetrics`](docs/sdks/metrics/README.md#accountmetrics) - Account-level metrics.
- [`metricsBasinMetrics`](docs/sdks/metrics/README.md#basinmetrics) - Basin-level metrics.
- [`metricsStreamMetrics`](docs/sdks/metrics/README.md#streammetrics) - Stream-level metrics.
- [`recordsAppend`](docs/sdks/records/README.md#append) - Append records.
- [`recordsCheckTail`](docs/sdks/records/README.md#checktail) - Check the tail.
- [`recordsRead`](docs/sdks/records/README.md#read) - Read records.
- [`streamsCreateOrReconfigureStream`](docs/sdks/streams/README.md#createorreconfigurestream) - Create or reconfigure a stream.
- [`streamsCreateStream`](docs/sdks/streams/README.md#createstream) - Create a stream.
- [`streamsDeleteStream`](docs/sdks/streams/README.md#deletestream) - Delete a stream.
- [`streamsGetStreamConfig`](docs/sdks/streams/README.md#getstreamconfig) - Get stream configuration.
- [`streamsListStreams`](docs/sdks/streams/README.md#liststreams) - List streams.
- [`streamsReconfigureStream`](docs/sdks/streams/README.md#reconfigurestream) - Reconfigure a stream.

</details>
<!-- End Standalone functions [standalone-funcs] -->

<!-- Start Server-sent event streaming [eventstream] -->
## Server-sent event streaming

[Server-sent events][mdn-sse] are used to stream content from certain
operations. These operations will expose the stream as an async iterable that
can be consumed using a [`for await...of`][mdn-for-await-of] loop. The loop will
terminate when the server no longer has any events to send and closes the
underlying connection.

```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const result = await s2.records.read({
    stream: "<value>",
    s2Basin: "<value>",
  });

  for await (const event of result) {
    // Handle the event
    console.log(event);
  }
}

run();

```

[mdn-sse]: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
[mdn-for-await-of]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for-await...of
<!-- End Server-sent event streaming [eventstream] -->

<!-- Start Pagination [pagination] -->
## Pagination

Some of the endpoints in this SDK support pagination. To use pagination, you
make your SDK calls as usual, but the returned response object will also be an
async iterable that can be consumed using the [`for await...of`][for-await-of]
syntax.

[for-await-of]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for-await...of

Here's an example of one such pagination call:

```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const result = await s2.basins.listBasins({});

  for await (const page of result) {
    console.log(page);
  }
}

run();

```
<!-- End Pagination [pagination] -->

<!-- Start Retries [retries] -->
## Retries

Some of the endpoints in this SDK support retries.  If you use the SDK without any configuration, it will fall back to the default retry strategy provided by the API.  However, the default retry strategy can be overridden on a per-operation basis, or across the entire SDK.

To change the default retry strategy for a single API call, simply provide a retryConfig object to the call:
```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const result = await s2.accessTokens.listAccessTokens({}, {
    retries: {
      strategy: "backoff",
      backoff: {
        initialInterval: 1,
        maxInterval: 50,
        exponent: 1.1,
        maxElapsedTime: 100,
      },
      retryConnectionErrors: false,
    },
  });

  console.log(result);
}

run();

```

If you'd like to override the default retry strategy for all operations that support retries, you can provide a retryConfig at SDK initialization:
```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  retryConfig: {
    strategy: "backoff",
    backoff: {
      initialInterval: 1,
      maxInterval: 50,
      exponent: 1.1,
      maxElapsedTime: 100,
    },
    retryConnectionErrors: false,
  },
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const result = await s2.accessTokens.listAccessTokens({});

  console.log(result);
}

run();

```
<!-- End Retries [retries] -->

<!-- Start Error Handling [errors] -->
## Error Handling

[`S2Error`](./src/models/errors/s2error.ts) is the base class for all HTTP error responses. It has the following properties:

| Property            | Type       | Description                                                                             |
| ------------------- | ---------- | --------------------------------------------------------------------------------------- |
| `error.message`     | `string`   | Error message                                                                           |
| `error.statusCode`  | `number`   | HTTP response status code eg `404`                                                      |
| `error.headers`     | `Headers`  | HTTP response headers                                                                   |
| `error.body`        | `string`   | HTTP body. Can be empty string if no body is returned.                                  |
| `error.rawResponse` | `Response` | Raw HTTP response                                                                       |
| `error.data$`       |            | Optional. Some errors may contain structured data. [See Error Classes](#error-classes). |

### Example
```typescript
import { S2 } from "@s2-dev/streamstore";
import * as errors from "@s2-dev/streamstore/models/errors";

const s2 = new S2({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  try {
    const result = await s2.accessTokens.listAccessTokens({});

    console.log(result);
  } catch (error) {
    // The base class for HTTP error responses
    if (error instanceof errors.S2Error) {
      console.log(error.message);
      console.log(error.statusCode);
      console.log(error.body);
      console.log(error.headers);

      // Depending on the method different errors may be thrown
      if (error instanceof errors.ErrorResponse) {
        console.log(error.data$.code); // string
        console.log(error.data$.message); // string
      }
    }
  }
}

run();

```

### Error Classes
**Primary errors:**
* [`S2Error`](./src/models/errors/s2error.ts): The base class for HTTP error responses.
  * [`ErrorResponse`](./src/models/errors/errorresponse.ts): .

<details><summary>Less common errors (9)</summary>

<br />

**Network errors:**
* [`ConnectionError`](./src/models/errors/httpclienterrors.ts): HTTP client was unable to make a request to a server.
* [`RequestTimeoutError`](./src/models/errors/httpclienterrors.ts): HTTP request timed out due to an AbortSignal signal.
* [`RequestAbortedError`](./src/models/errors/httpclienterrors.ts): HTTP request was aborted by the client.
* [`InvalidRequestError`](./src/models/errors/httpclienterrors.ts): Any input used to create a request is invalid.
* [`UnexpectedClientError`](./src/models/errors/httpclienterrors.ts): Unrecognised or unexpected error.


**Inherit from [`S2Error`](./src/models/errors/s2error.ts)**:
* [`FencingToken`](./src/models/errors/fencingtoken.ts): Fencing token did not match. The expected fencing token is returned. Status code `412`. Applicable to 1 of 21 methods.*
* [`SeqNum`](./src/models/errors/seqnum.ts): Sequence number did not match the tail of the stream. The expected next sequence number is returned. Status code `412`. Applicable to 1 of 21 methods.*
* [`TailResponse`](./src/models/errors/tailresponse.ts): . Status code `416`. Applicable to 1 of 21 methods.*
* [`ResponseValidationError`](./src/models/errors/responsevalidationerror.ts): Type mismatch between the data returned from the server and the structure expected by the SDK. See `error.rawValue` for the raw value and `error.pretty()` for a nicely formatted multi-line string.

</details>

\* Check [the method documentation](#available-resources-and-operations) to see if the error is applicable.
<!-- End Error Handling [errors] -->

<!-- Start Server Selection [server] -->
## Server Selection

### Override Server URL Per-Client

The default server can be overridden globally by passing a URL to the `serverURL: string` optional parameter when initializing the SDK client instance. For example:
```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  serverURL: "https://aws.s2.dev/v1",
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const result = await s2.accessTokens.listAccessTokens({});

  console.log(result);
}

run();

```

### Override Server URL Per-Operation

The server URL can also be overridden on a per-operation basis, provided a server list was specified for the operation. For example:
```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const result = await s2.streams.listStreams({
    s2Basin: "<value>",
  }, {
    serverURL: "https://.b.aws.s2.dev/v1",
  });

  for await (const page of result) {
    console.log(page);
  }
}

run();

```
<!-- End Server Selection [server] -->

<!-- Start Custom HTTP Client [http-client] -->
## Custom HTTP Client

The TypeScript SDK makes API calls using an `HTTPClient` that wraps the native
[Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API). This
client is a thin wrapper around `fetch` and provides the ability to attach hooks
around the request lifecycle that can be used to modify the request or handle
errors and response.

The `HTTPClient` constructor takes an optional `fetcher` argument that can be
used to integrate a third-party HTTP client or when writing tests to mock out
the HTTP client and feed in fixtures.

The following example shows how to use the `"beforeRequest"` hook to to add a
custom header and a timeout to requests and how to use the `"requestError"` hook
to log errors:

```typescript
import { S2 } from "@s2-dev/streamstore";
import { HTTPClient } from "@s2-dev/streamstore/lib/http";

const httpClient = new HTTPClient({
  // fetcher takes a function that has the same signature as native `fetch`.
  fetcher: (request) => {
    return fetch(request);
  }
});

httpClient.addHook("beforeRequest", (request) => {
  const nextRequest = new Request(request, {
    signal: request.signal || AbortSignal.timeout(5000)
  });

  nextRequest.headers.set("x-custom-header", "custom value");

  return nextRequest;
});

httpClient.addHook("requestError", (error, request) => {
  console.group("Request Error");
  console.log("Reason:", `${error}`);
  console.log("Endpoint:", `${request.method} ${request.url}`);
  console.groupEnd();
});

const sdk = new S2({ httpClient });
```
<!-- End Custom HTTP Client [http-client] -->

<!-- Start Debugging [debug] -->
## Debugging

You can setup your SDK to emit debug logs for SDK requests and responses.

You can pass a logger that matches `console`'s interface as an SDK option.

> [!WARNING]
> Beware that debug logging will reveal secrets, like API tokens in headers, in log messages printed to a console or files. It's recommended to use this feature only during local development and not in production.

```typescript
import { S2 } from "@s2-dev/streamstore";

const sdk = new S2({ debugLogger: console });
```

You can also enable a default debug logger by setting an environment variable `S2_DEBUG` to true.
<!-- End Debugging [debug] -->

<!-- Placeholder for Future Speakeasy SDK Sections -->

# Development

## Maturity

This SDK is in beta, and there may be breaking changes between versions without a major version update. Therefore, we recommend pinning usage
to a specific package version. This way, you can install the same version each time without breaking changes unless you are intentionally
looking for the latest version.

## Contributions

While we value open-source contributions to this SDK, this library is generated programmatically. Any manual changes added to internal files will be overwritten on the next generation. 
We look forward to hearing your feedback. Feel free to open a PR or an issue with a proof of concept and we'll do our best to include it in a future release. 

### SDK Created by [Speakeasy](https://www.speakeasy.com/?utm_source=streamstore&utm_campaign=)
