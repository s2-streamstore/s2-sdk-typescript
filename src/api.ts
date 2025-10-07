import createClient from "openapi-fetch";
import type { paths } from "./generated/api";

type BasinSpecificApiPaths =
  | "/streams/{stream}"
  | "/streams/{stream}/records"
  | "/streams/{stream}/records/tail";

// Get only the basin-specific paths
type basinSpecificPaths = Pick<paths, BasinSpecificApiPaths>;

// Get all paths EXCEPT the basin-specific ones
type generalPaths = Omit<paths, BasinSpecificApiPaths>;

const generalApiClient = createClient<generalPaths>({
  baseUrl: "https://api.s2.streamstore.com",
});

const makeBasinSpecificApiClient = (basin: string) => {
  return createClient<basinSpecificPaths>({
    baseUrl: `https://${basin}.b.aws.s2.dev`,
  });
};

generalApiClient.GET("/streams");
const basinSpecificClient = makeBasinSpecificApiClient("test");
basinSpecificClient.GET("/streams/{stream}", {
  params: {
    path: {
      stream: "test",
    },
  },
});
