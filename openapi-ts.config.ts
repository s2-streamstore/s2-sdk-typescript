import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./openapi/s2.json",
  output: {
    path: "src/generated",
    importFileExtension: ".js",
  },
});
