import { describe, expect, it } from "vitest";
import {
  frameMessage,
  S2SFrameParser,
} from "../../lib/stream/transport/s2s/framing.js";

describe("Issue #94: S2S terminal frames without status code", () => {
  it("preserves body when terminal frame has no status code", () => {
    const testBody = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const frame = frameMessage({
      terminal: true,
      body: testBody,
    });

    const parser = new S2SFrameParser();
    parser.push(frame);
    const parsed = parser.parseFrame();

    expect(parsed).not.toBeNull();
    expect(parsed!.terminal).toBe(true);
    expect(parsed!.statusCode).toBeUndefined();
    expect(Array.from(parsed!.body)).toEqual(Array.from(testBody));
  });

  it("correctly extracts status code when present in terminal frame", () => {
    const testBody = new Uint8Array([0xAA, 0xBB]);
    const frame = frameMessage({
      terminal: true,
      body: testBody,
      statusCode: 502,
    });

    const parser = new S2SFrameParser();
    parser.push(frame);
    const parsed = parser.parseFrame();

    expect(parsed).not.toBeNull();
    expect(parsed!.terminal).toBe(true);
    expect(parsed!.statusCode).toBe(502);
    expect(Array.from(parsed!.body)).toEqual(Array.from(testBody));
  });

  it("handles terminal frame with empty body and status code", () => {
    const frame = frameMessage({
      terminal: true,
      body: new Uint8Array(0),
      statusCode: 200,
    });

    const parser = new S2SFrameParser();
    parser.push(frame);
    const parsed = parser.parseFrame();

    expect(parsed).not.toBeNull();
    expect(parsed!.terminal).toBe(true);
    expect(parsed!.statusCode).toBe(200);
    expect(parsed!.body.length).toBe(0);
  });

  it("handles terminal frame with empty body and no status code", () => {
    const frame = frameMessage({
      terminal: true,
      body: new Uint8Array(0),
    });

    const parser = new S2SFrameParser();
    parser.push(frame);
    const parsed = parser.parseFrame();

    expect(parsed).not.toBeNull();
    expect(parsed!.terminal).toBe(true);
    expect(parsed!.statusCode).toBeUndefined();
    expect(parsed!.body.length).toBe(0);
  });

  it("non-terminal frame body is preserved regardless of content", () => {
    const testBody = new Uint8Array([0x01, 0xF6, 0x03]);
    const frame = frameMessage({
      terminal: false,
      body: testBody,
    });

    const parser = new S2SFrameParser();
    parser.push(frame);
    const parsed = parser.parseFrame();

    expect(parsed).not.toBeNull();
    expect(parsed!.terminal).toBe(false);
    expect(parsed!.statusCode).toBeUndefined();
    expect(Array.from(parsed!.body)).toEqual(Array.from(testBody));
  });
});
