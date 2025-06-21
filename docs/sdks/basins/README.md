# Basins
(*basins*)

## Overview

Manage basins

### Available Operations

* [listBasins](#listbasins) - List basins.
* [createBasin](#createbasin) - Create a basin.
* [getBasinConfig](#getbasinconfig) - Get basin configuration.
* [createOrReconfigureBasin](#createorreconfigurebasin) - Create or reconfigure a basin.
* [deleteBasin](#deletebasin) - Delete a basin.
* [reconfigureBasin](#reconfigurebasin) - Reconfigure a basin.

## listBasins

List basins.

### Example Usage

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

### Standalone function

The standalone function version of this method:

```typescript
import { S2Core } from "@s2-dev/streamstore/core.js";
import { basinsListBasins } from "@s2-dev/streamstore/funcs/basinsListBasins.js";

// Use `S2Core` for best tree-shaking performance.
// You can create one instance of it to use across an application.
const s2 = new S2Core({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const res = await basinsListBasins(s2, {});
  if (res.ok) {
    const { value: result } = res;
    for await (const page of result) {
    console.log(page);
  }
  } else {
    console.log("basinsListBasins failed:", res.error);
  }
}

run();
```

### Parameters

| Parameter                                                                                                                                                                      | Type                                                                                                                                                                           | Required                                                                                                                                                                       | Description                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request`                                                                                                                                                                      | [operations.ListBasinsRequest](../../models/operations/listbasinsrequest.md)                                                                                                   | :heavy_check_mark:                                                                                                                                                             | The request object to use for the request.                                                                                                                                     |
| `options`                                                                                                                                                                      | RequestOptions                                                                                                                                                                 | :heavy_minus_sign:                                                                                                                                                             | Used to set various options for making HTTP requests.                                                                                                                          |
| `options.fetchOptions`                                                                                                                                                         | [RequestInit](https://developer.mozilla.org/en-US/docs/Web/API/Request/Request#options)                                                                                        | :heavy_minus_sign:                                                                                                                                                             | Options that are passed to the underlying HTTP request. This can be used to inject extra headers for examples. All `Request` options, except `method` and `body`, are allowed. |
| `options.retries`                                                                                                                                                              | [RetryConfig](../../lib/utils/retryconfig.md)                                                                                                                                  | :heavy_minus_sign:                                                                                                                                                             | Enables retrying HTTP requests under certain failure conditions.                                                                                                               |

### Response

**Promise\<[operations.ListBasinsResponse](../../models/operations/listbasinsresponse.md)\>**

### Errors

| Error Type           | Status Code          | Content Type         |
| -------------------- | -------------------- | -------------------- |
| errors.ErrorResponse | 400, 403             | application/json     |
| errors.APIError      | 4XX, 5XX             | \*/\*                |

## createBasin

Create a basin.

### Example Usage

```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const result = await s2.basins.createBasin({
    basin: "<value>",
  });

  console.log(result);
}

run();
```

### Standalone function

The standalone function version of this method:

```typescript
import { S2Core } from "@s2-dev/streamstore/core.js";
import { basinsCreateBasin } from "@s2-dev/streamstore/funcs/basinsCreateBasin.js";

// Use `S2Core` for best tree-shaking performance.
// You can create one instance of it to use across an application.
const s2 = new S2Core({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const res = await basinsCreateBasin(s2, {
    basin: "<value>",
  });
  if (res.ok) {
    const { value: result } = res;
    console.log(result);
  } else {
    console.log("basinsCreateBasin failed:", res.error);
  }
}

run();
```

### Parameters

| Parameter                                                                                                                                                                      | Type                                                                                                                                                                           | Required                                                                                                                                                                       | Description                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request`                                                                                                                                                                      | [components.CreateBasinRequest](../../models/components/createbasinrequest.md)                                                                                                 | :heavy_check_mark:                                                                                                                                                             | The request object to use for the request.                                                                                                                                     |
| `options`                                                                                                                                                                      | RequestOptions                                                                                                                                                                 | :heavy_minus_sign:                                                                                                                                                             | Used to set various options for making HTTP requests.                                                                                                                          |
| `options.fetchOptions`                                                                                                                                                         | [RequestInit](https://developer.mozilla.org/en-US/docs/Web/API/Request/Request#options)                                                                                        | :heavy_minus_sign:                                                                                                                                                             | Options that are passed to the underlying HTTP request. This can be used to inject extra headers for examples. All `Request` options, except `method` and `body`, are allowed. |
| `options.retries`                                                                                                                                                              | [RetryConfig](../../lib/utils/retryconfig.md)                                                                                                                                  | :heavy_minus_sign:                                                                                                                                                             | Enables retrying HTTP requests under certain failure conditions.                                                                                                               |

### Response

**Promise\<[components.BasinInfo](../../models/components/basininfo.md)\>**

### Errors

| Error Type           | Status Code          | Content Type         |
| -------------------- | -------------------- | -------------------- |
| errors.ErrorResponse | 400, 401, 403, 409   | application/json     |
| errors.APIError      | 4XX, 5XX             | \*/\*                |

## getBasinConfig

Get basin configuration.

### Example Usage

```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const result = await s2.basins.getBasinConfig({
    basin: "<value>",
  });

  console.log(result);
}

run();
```

### Standalone function

The standalone function version of this method:

```typescript
import { S2Core } from "@s2-dev/streamstore/core.js";
import { basinsGetBasinConfig } from "@s2-dev/streamstore/funcs/basinsGetBasinConfig.js";

// Use `S2Core` for best tree-shaking performance.
// You can create one instance of it to use across an application.
const s2 = new S2Core({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const res = await basinsGetBasinConfig(s2, {
    basin: "<value>",
  });
  if (res.ok) {
    const { value: result } = res;
    console.log(result);
  } else {
    console.log("basinsGetBasinConfig failed:", res.error);
  }
}

run();
```

### Parameters

| Parameter                                                                                                                                                                      | Type                                                                                                                                                                           | Required                                                                                                                                                                       | Description                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request`                                                                                                                                                                      | [operations.GetBasinConfigRequest](../../models/operations/getbasinconfigrequest.md)                                                                                           | :heavy_check_mark:                                                                                                                                                             | The request object to use for the request.                                                                                                                                     |
| `options`                                                                                                                                                                      | RequestOptions                                                                                                                                                                 | :heavy_minus_sign:                                                                                                                                                             | Used to set various options for making HTTP requests.                                                                                                                          |
| `options.fetchOptions`                                                                                                                                                         | [RequestInit](https://developer.mozilla.org/en-US/docs/Web/API/Request/Request#options)                                                                                        | :heavy_minus_sign:                                                                                                                                                             | Options that are passed to the underlying HTTP request. This can be used to inject extra headers for examples. All `Request` options, except `method` and `body`, are allowed. |
| `options.retries`                                                                                                                                                              | [RetryConfig](../../lib/utils/retryconfig.md)                                                                                                                                  | :heavy_minus_sign:                                                                                                                                                             | Enables retrying HTTP requests under certain failure conditions.                                                                                                               |

### Response

**Promise\<[components.BasinConfig](../../models/components/basinconfig.md)\>**

### Errors

| Error Type           | Status Code          | Content Type         |
| -------------------- | -------------------- | -------------------- |
| errors.ErrorResponse | 400, 403, 404        | application/json     |
| errors.APIError      | 4XX, 5XX             | \*/\*                |

## createOrReconfigureBasin

Create or reconfigure a basin.

### Example Usage

```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const result = await s2.basins.createOrReconfigureBasin({
    basin: "<value>",
  });

  console.log(result);
}

run();
```

### Standalone function

The standalone function version of this method:

```typescript
import { S2Core } from "@s2-dev/streamstore/core.js";
import { basinsCreateOrReconfigureBasin } from "@s2-dev/streamstore/funcs/basinsCreateOrReconfigureBasin.js";

// Use `S2Core` for best tree-shaking performance.
// You can create one instance of it to use across an application.
const s2 = new S2Core({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const res = await basinsCreateOrReconfigureBasin(s2, {
    basin: "<value>",
  });
  if (res.ok) {
    const { value: result } = res;
    console.log(result);
  } else {
    console.log("basinsCreateOrReconfigureBasin failed:", res.error);
  }
}

run();
```

### Parameters

| Parameter                                                                                                                                                                      | Type                                                                                                                                                                           | Required                                                                                                                                                                       | Description                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request`                                                                                                                                                                      | [operations.CreateOrReconfigureBasinRequest](../../models/operations/createorreconfigurebasinrequest.md)                                                                       | :heavy_check_mark:                                                                                                                                                             | The request object to use for the request.                                                                                                                                     |
| `options`                                                                                                                                                                      | RequestOptions                                                                                                                                                                 | :heavy_minus_sign:                                                                                                                                                             | Used to set various options for making HTTP requests.                                                                                                                          |
| `options.fetchOptions`                                                                                                                                                         | [RequestInit](https://developer.mozilla.org/en-US/docs/Web/API/Request/Request#options)                                                                                        | :heavy_minus_sign:                                                                                                                                                             | Options that are passed to the underlying HTTP request. This can be used to inject extra headers for examples. All `Request` options, except `method` and `body`, are allowed. |
| `options.retries`                                                                                                                                                              | [RetryConfig](../../lib/utils/retryconfig.md)                                                                                                                                  | :heavy_minus_sign:                                                                                                                                                             | Enables retrying HTTP requests under certain failure conditions.                                                                                                               |

### Response

**Promise\<[components.BasinInfo](../../models/components/basininfo.md)\>**

### Errors

| Error Type           | Status Code          | Content Type         |
| -------------------- | -------------------- | -------------------- |
| errors.ErrorResponse | 400                  | application/json     |
| errors.APIError      | 4XX, 5XX             | \*/\*                |

## deleteBasin

Delete a basin.

### Example Usage

```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  await s2.basins.deleteBasin({
    basin: "<value>",
  });


}

run();
```

### Standalone function

The standalone function version of this method:

```typescript
import { S2Core } from "@s2-dev/streamstore/core.js";
import { basinsDeleteBasin } from "@s2-dev/streamstore/funcs/basinsDeleteBasin.js";

// Use `S2Core` for best tree-shaking performance.
// You can create one instance of it to use across an application.
const s2 = new S2Core({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const res = await basinsDeleteBasin(s2, {
    basin: "<value>",
  });
  if (res.ok) {
    const { value: result } = res;
    
  } else {
    console.log("basinsDeleteBasin failed:", res.error);
  }
}

run();
```

### Parameters

| Parameter                                                                                                                                                                      | Type                                                                                                                                                                           | Required                                                                                                                                                                       | Description                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request`                                                                                                                                                                      | [operations.DeleteBasinRequest](../../models/operations/deletebasinrequest.md)                                                                                                 | :heavy_check_mark:                                                                                                                                                             | The request object to use for the request.                                                                                                                                     |
| `options`                                                                                                                                                                      | RequestOptions                                                                                                                                                                 | :heavy_minus_sign:                                                                                                                                                             | Used to set various options for making HTTP requests.                                                                                                                          |
| `options.fetchOptions`                                                                                                                                                         | [RequestInit](https://developer.mozilla.org/en-US/docs/Web/API/Request/Request#options)                                                                                        | :heavy_minus_sign:                                                                                                                                                             | Options that are passed to the underlying HTTP request. This can be used to inject extra headers for examples. All `Request` options, except `method` and `body`, are allowed. |
| `options.retries`                                                                                                                                                              | [RetryConfig](../../lib/utils/retryconfig.md)                                                                                                                                  | :heavy_minus_sign:                                                                                                                                                             | Enables retrying HTTP requests under certain failure conditions.                                                                                                               |

### Response

**Promise\<void\>**

### Errors

| Error Type           | Status Code          | Content Type         |
| -------------------- | -------------------- | -------------------- |
| errors.ErrorResponse | 400, 401, 403, 404   | application/json     |
| errors.APIError      | 4XX, 5XX             | \*/\*                |

## reconfigureBasin

Reconfigure a basin.

### Example Usage

```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const result = await s2.basins.reconfigureBasin({
    basin: "<value>",
    basinReconfiguration: {},
  });

  console.log(result);
}

run();
```

### Standalone function

The standalone function version of this method:

```typescript
import { S2Core } from "@s2-dev/streamstore/core.js";
import { basinsReconfigureBasin } from "@s2-dev/streamstore/funcs/basinsReconfigureBasin.js";

// Use `S2Core` for best tree-shaking performance.
// You can create one instance of it to use across an application.
const s2 = new S2Core({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const res = await basinsReconfigureBasin(s2, {
    basin: "<value>",
    basinReconfiguration: {},
  });
  if (res.ok) {
    const { value: result } = res;
    console.log(result);
  } else {
    console.log("basinsReconfigureBasin failed:", res.error);
  }
}

run();
```

### Parameters

| Parameter                                                                                                                                                                      | Type                                                                                                                                                                           | Required                                                                                                                                                                       | Description                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request`                                                                                                                                                                      | [operations.ReconfigureBasinRequest](../../models/operations/reconfigurebasinrequest.md)                                                                                       | :heavy_check_mark:                                                                                                                                                             | The request object to use for the request.                                                                                                                                     |
| `options`                                                                                                                                                                      | RequestOptions                                                                                                                                                                 | :heavy_minus_sign:                                                                                                                                                             | Used to set various options for making HTTP requests.                                                                                                                          |
| `options.fetchOptions`                                                                                                                                                         | [RequestInit](https://developer.mozilla.org/en-US/docs/Web/API/Request/Request#options)                                                                                        | :heavy_minus_sign:                                                                                                                                                             | Options that are passed to the underlying HTTP request. This can be used to inject extra headers for examples. All `Request` options, except `method` and `body`, are allowed. |
| `options.retries`                                                                                                                                                              | [RetryConfig](../../lib/utils/retryconfig.md)                                                                                                                                  | :heavy_minus_sign:                                                                                                                                                             | Enables retrying HTTP requests under certain failure conditions.                                                                                                               |

### Response

**Promise\<[components.BasinConfig](../../models/components/basinconfig.md)\>**

### Errors

| Error Type           | Status Code          | Content Type         |
| -------------------- | -------------------- | -------------------- |
| errors.ErrorResponse | 400, 403, 404        | application/json     |
| errors.APIError      | 4XX, 5XX             | \*/\*                |