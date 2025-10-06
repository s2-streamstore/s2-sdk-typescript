interface StreamPosition {
  seqNum: number;
  timestamp: number;
}

interface BaseOptions {
  signal?: AbortSignal;
}

type ReadStart = {
  seqNum: number;
} | {
  timestamp: number;
} | {
  tailOffset: number;
};

type ReadLimit = {
  count?: number;
  bytes?: number;
};

type ReadArgs<Format extends "string" | "bytes" = "string"> = {
  clamp?: boolean;
  until?: number;
  wait?: number;
  as?: Format;
} & ReadStart & ReadLimit;

type Header = [string, string];

interface SequencedRecord<Data extends string | Uint8Array> {
  body?: Data;
  headers?: Header[];
  seq_num: number;
  timestamp: number;
}

interface ReadResponse<Data extends string | Uint8Array> {
  records: SequencedRecord<Data>[];
  tail: StreamPosition | null;
}

interface AppendRecord<Data extends string | Uint8Array> {
  body: Data;
  headers?: Header[];
}

interface AppendArgs<Data extends string | Uint8Array> {
  records: AppendRecord<Data>[];
  fencingToken?: string;
  matchSeqNum?: number;
}

interface AppendResponse {
  start: StreamPosition;
  end: StreamPosition;
  tail: StreamPosition;
}

interface AppendAck {
  start: StreamPosition;
  end: StreamPosition;
  tail: StreamPosition;
}

interface ReadEvent<Data extends string | Uint8Array> {
  records: SequencedRecord<Data>[];
  tail: StreamPosition | null;
}

declare class ReadSession<Data extends string | Uint8Array> implements AsyncDisposable, AsyncIterable<ReadEvent<Data>> {
  [Symbol.asyncDispose](): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<ReadEvent<Data>>;
}
declare class AppendSession implements AsyncDisposable {
  [Symbol.asyncDispose](): Promise<void>;
  acks(): AsyncIterableIterator<AppendAck>;
  send<Data extends string | Uint8Array>(records: AppendRecord<Data> | AppendRecord<Data>[], opts?: BaseOptions): Promise<void>;
}

declare class StreamService {
  read(args: ReadArgs<"string">, opts?: BaseOptions): Promise<ReadResponse<string>>;
  read(args: ReadArgs<"bytes">, opts?: BaseOptions): Promise<ReadResponse<Uint8Array>>;
  readSession(args?: ReadArgs<"string">, opts?: BaseOptions): ReadSession<string>;
  readSession(args?: ReadArgs<"bytes">, opts?: BaseOptions): ReadSession<Uint8Array>;
  append<Data extends string | Uint8Array>(args: AppendArgs<Data>, opts?: BaseOptions): Promise<AppendResponse>;
  appendSession(opts?: BaseOptions): AppendSession;
  checkTail(opts?: BaseOptions): Promise<StreamPosition>;
}

declare class BasinService {
  stream(name: string): StreamService;
  // stubs
  listStreams(): void;
  createStream(): void;
  deleteStream(): void;
  getStreamConfig(): void;
  reconfigureStream(): void;
}

export declare class S2 {
  basin(name: string): BasinService;
  // stubs
  listBasins(): void;
  createBasin(): void;
  deleteBasin(): void;
  getBasinConfig(): void;
  reconfigureBasin(): void;
  listAccessTokens(): void;
  issueAccessToken(): void;
  revokeAccessToken(): void;
  getAccountMetrics(): void;
  getBasinMetrics(): void;
  getStreamMetrics(): void;
}

async function _example() {
  const s2 = new S2();
  const stream = s2.basin("my-basin").stream("my-stream");
  const tail = await stream.checkTail();

  const _stringRecord = await stream.read({
    seqNum: tail.seqNum,
    count: 10,
  });
  
  const _bytesRecord = await stream.read({
    seqNum: tail.seqNum,
    count: 10,
    as: "bytes",
  });

  await stream.append({
    records: [
      {
        body: "Hello, world!",
      },
    ],
  });

  await using readSession = stream.readSession();
  await using appendSession = stream.appendSession();

  const appendTask = (async () => {
    for await (const ack of appendSession.acks()) {
      console.log(ack);
    }

    for (let i = 0; i < 10; i++) {
      await appendSession.send({
        body: `Hello, world! ${i}`,
      });
    }
  })();

  let readCount = 0;
  for await (const event of readSession) {
    console.log(event.records);
    readCount += event.records.length;

    if (readCount >= 10) {
      break;
    }
  }

  await appendTask;
}