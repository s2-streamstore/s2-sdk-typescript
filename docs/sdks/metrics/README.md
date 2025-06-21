# Metrics
(*metrics*)

## Overview

Usage metrics and data.

### Available Operations

* [accountMetrics](#accountmetrics) - Account-level metrics.
* [basinMetrics](#basinmetrics) - Basin-level metrics.
* [streamMetrics](#streammetrics) - Stream-level metrics.

## accountMetrics

Account-level metrics.

### Example Usage

```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const result = await s2.metrics.accountMetrics({
    set: "account-ops",
  });

  console.log(result);
}

run();
```

### Standalone function

The standalone function version of this method:

```typescript
import { S2Core } from "@s2-dev/streamstore/core.js";
import { metricsAccountMetrics } from "@s2-dev/streamstore/funcs/metricsAccountMetrics.js";

// Use `S2Core` for best tree-shaking performance.
// You can create one instance of it to use across an application.
const s2 = new S2Core({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const res = await metricsAccountMetrics(s2, {
    set: "account-ops",
  });
  if (res.ok) {
    const { value: result } = res;
    console.log(result);
  } else {
    console.log("metricsAccountMetrics failed:", res.error);
  }
}

run();
```

### Parameters

| Parameter                                                                                                                                                                      | Type                                                                                                                                                                           | Required                                                                                                                                                                       | Description                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request`                                                                                                                                                                      | [operations.AccountMetricsRequest](../../models/operations/accountmetricsrequest.md)                                                                                           | :heavy_check_mark:                                                                                                                                                             | The request object to use for the request.                                                                                                                                     |
| `options`                                                                                                                                                                      | RequestOptions                                                                                                                                                                 | :heavy_minus_sign:                                                                                                                                                             | Used to set various options for making HTTP requests.                                                                                                                          |
| `options.fetchOptions`                                                                                                                                                         | [RequestInit](https://developer.mozilla.org/en-US/docs/Web/API/Request/Request#options)                                                                                        | :heavy_minus_sign:                                                                                                                                                             | Options that are passed to the underlying HTTP request. This can be used to inject extra headers for examples. All `Request` options, except `method` and `body`, are allowed. |
| `options.retries`                                                                                                                                                              | [RetryConfig](../../lib/utils/retryconfig.md)                                                                                                                                  | :heavy_minus_sign:                                                                                                                                                             | Enables retrying HTTP requests under certain failure conditions.                                                                                                               |

### Response

**Promise\<[components.MetricSetResponse](../../models/components/metricsetresponse.md)\>**

### Errors

| Error Type           | Status Code          | Content Type         |
| -------------------- | -------------------- | -------------------- |
| errors.ErrorResponse | 400, 403             | application/json     |
| errors.APIError      | 4XX, 5XX             | \*/\*                |

## basinMetrics

Basin-level metrics.

### Example Usage

```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const result = await s2.metrics.basinMetrics({
    set: "storage",
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
import { metricsBasinMetrics } from "@s2-dev/streamstore/funcs/metricsBasinMetrics.js";

// Use `S2Core` for best tree-shaking performance.
// You can create one instance of it to use across an application.
const s2 = new S2Core({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const res = await metricsBasinMetrics(s2, {
    set: "storage",
    basin: "<value>",
  });
  if (res.ok) {
    const { value: result } = res;
    console.log(result);
  } else {
    console.log("metricsBasinMetrics failed:", res.error);
  }
}

run();
```

### Parameters

| Parameter                                                                                                                                                                      | Type                                                                                                                                                                           | Required                                                                                                                                                                       | Description                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request`                                                                                                                                                                      | [operations.BasinMetricsRequest](../../models/operations/basinmetricsrequest.md)                                                                                               | :heavy_check_mark:                                                                                                                                                             | The request object to use for the request.                                                                                                                                     |
| `options`                                                                                                                                                                      | RequestOptions                                                                                                                                                                 | :heavy_minus_sign:                                                                                                                                                             | Used to set various options for making HTTP requests.                                                                                                                          |
| `options.fetchOptions`                                                                                                                                                         | [RequestInit](https://developer.mozilla.org/en-US/docs/Web/API/Request/Request#options)                                                                                        | :heavy_minus_sign:                                                                                                                                                             | Options that are passed to the underlying HTTP request. This can be used to inject extra headers for examples. All `Request` options, except `method` and `body`, are allowed. |
| `options.retries`                                                                                                                                                              | [RetryConfig](../../lib/utils/retryconfig.md)                                                                                                                                  | :heavy_minus_sign:                                                                                                                                                             | Enables retrying HTTP requests under certain failure conditions.                                                                                                               |

### Response

**Promise\<[components.MetricSetResponse](../../models/components/metricsetresponse.md)\>**

### Errors

| Error Type           | Status Code          | Content Type         |
| -------------------- | -------------------- | -------------------- |
| errors.ErrorResponse | 400, 403             | application/json     |
| errors.APIError      | 4XX, 5XX             | \*/\*                |

## streamMetrics

Stream-level metrics.

### Example Usage

```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const result = await s2.metrics.streamMetrics({
    basin: "<value>",
    stream: "<value>",
  });

  console.log(result);
}

run();
```

### Standalone function

The standalone function version of this method:

```typescript
import { S2Core } from "@s2-dev/streamstore/core.js";
import { metricsStreamMetrics } from "@s2-dev/streamstore/funcs/metricsStreamMetrics.js";

// Use `S2Core` for best tree-shaking performance.
// You can create one instance of it to use across an application.
const s2 = new S2Core({
  accessToken: process.env["S2_ACCESS_TOKEN"] ?? "",
});

async function run() {
  const res = await metricsStreamMetrics(s2, {
    basin: "<value>",
    stream: "<value>",
  });
  if (res.ok) {
    const { value: result } = res;
    console.log(result);
  } else {
    console.log("metricsStreamMetrics failed:", res.error);
  }
}

run();
```

### Parameters

| Parameter                                                                                                                                                                      | Type                                                                                                                                                                           | Required                                                                                                                                                                       | Description                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request`                                                                                                                                                                      | [operations.StreamMetricsRequest](../../models/operations/streammetricsrequest.md)                                                                                             | :heavy_check_mark:                                                                                                                                                             | The request object to use for the request.                                                                                                                                     |
| `options`                                                                                                                                                                      | RequestOptions                                                                                                                                                                 | :heavy_minus_sign:                                                                                                                                                             | Used to set various options for making HTTP requests.                                                                                                                          |
| `options.fetchOptions`                                                                                                                                                         | [RequestInit](https://developer.mozilla.org/en-US/docs/Web/API/Request/Request#options)                                                                                        | :heavy_minus_sign:                                                                                                                                                             | Options that are passed to the underlying HTTP request. This can be used to inject extra headers for examples. All `Request` options, except `method` and `body`, are allowed. |
| `options.retries`                                                                                                                                                              | [RetryConfig](../../lib/utils/retryconfig.md)                                                                                                                                  | :heavy_minus_sign:                                                                                                                                                             | Enables retrying HTTP requests under certain failure conditions.                                                                                                               |

### Response

**Promise\<[components.MetricSetResponse](../../models/components/metricsetresponse.md)\>**

### Errors

| Error Type           | Status Code          | Content Type         |
| -------------------- | -------------------- | -------------------- |
| errors.ErrorResponse | 400, 403             | application/json     |
| errors.APIError      | 4XX, 5XX             | \*/\*                |