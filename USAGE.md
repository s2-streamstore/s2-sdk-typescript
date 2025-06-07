<!-- Start SDK Example Usage [usage] -->
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