import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./s2-protos/s2/v1/openapi.json",
  output: {
    path: "packages/streamstore/src/generated",
    importFileExtension: ".js",
    clean: false,
  },
});
