import { RequestInput } from "../lib/http";
import { BeforeCreateRequestContext, BeforeCreateRequestHook } from "./types";

export class CompressionHook implements BeforeCreateRequestHook {
    beforeCreateRequest(_hookCtx: BeforeCreateRequestContext, input: RequestInput): RequestInput {
        const hdrs = new Headers(input.options?.headers ?? {});
        const body = input.options?.body;

        if (!hdrs.get("content-type")?.toLowerCase().startsWith("application/json") || typeof body !== "string") {
            return input;
        }

        const stream = new Blob([body]).stream();
        const compressedStream = stream.pipeThrough(new CompressionStream("gzip"));

        // Set the content encoding.
        hdrs.set("content-encoding", "gzip");

        const opts = {
            ...input.options,
            body: compressedStream,
            headers: hdrs,
            duplex: "half", // use HTTP2 because of stream
        };

        return {
            ...input,
            options: opts,
        }
    }
}
