import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input:
    "https://raw.githubusercontent.com/s2-streamstore/s2-protos/refs/heads/main/s2/v1/openapi.json", // sign up at app.heyapi.dev
  output: "src/generated",
});
