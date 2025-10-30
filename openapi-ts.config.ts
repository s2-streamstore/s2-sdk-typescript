import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./s2-protos/s2/v1/openapi.json",
  output: {
    path: "src/generated",
    importFileExtension: ".js",
    clean: false,
  },
});
