import {
	AppendRecord,
	BatchTransform,
	Producer,
	type ReadRecord,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to a valid access token.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN so we know where to work.");
}

const streamName = process.env.S2_STREAM ?? "pipelines/demo";

const s2 = new S2({
	...S2Environment.parse(),
	accessToken,
});

const basin = s2.basin(basinName);
await basin.streams.create({ stream: streamName }).catch((error: unknown) => {
	if (error instanceof S2Error && error.status === 409) {
		console.log(`Stream ${streamName} already exists.`);
		return undefined;
	}
	throw error;
});

const stream = basin.stream(streamName);
const startTail = await stream.checkTail();

// Producer lets us treat batches as a writable stream with built-in retry/backpressure.
const producer = new Producer(
	new BatchTransform({
		lingerDurationMillis: 500,
		maxBatchRecords: 200,
		matchSeqNum: startTail.tail.seqNum,
	}),
	await stream.appendSession({
		maxInflightBytes: 4 * 1024 * 1024,
	}),
);

type SensorReading = {
	id: string;
	value: number;
	at: string;
};

// Simulate a stream of sensor readings using Web streams APIs.
const sensorStream = new ReadableStream<SensorReading>({
	start(controller) {
		let count = 0;
		const interval = setInterval(() => {
			controller.enqueue({
				id: `sensor-${(count % 5) + 1}`,
				value: Math.round(Math.random() * 100),
				at: new Date().toISOString(),
			});
			count += 1;
			if (count === 200) {
				clearInterval(interval);
				controller.close();
			}
		}, 10);
	},
});

// Convert readings into AppendRecords before handing them to the producer.
const toAppendRecord = new TransformStream<SensorReading, AppendRecord>({
	transform(reading, controller) {
		controller.enqueue(
			AppendRecord.string({
				body: JSON.stringify(reading),
			}),
		);
	},
});

// Pipe the sensor stream through the transform stream and the producer's writable stream.
// The producer can exhibit backpressure on the sensor stream.
// The amount of backpressure can be configured via the `maxInflightBytes` and `maxInflightBatches` options
// on the append session provided to the producer.
await sensorStream.pipeThrough(toAppendRecord).pipeTo(producer.writable);

const producedCount =
	producer.appendSession.lastAckedPosition()!.end.seqNum -
	startTail.tail.seqNum;
console.log("Appended %d sensor readings.", producedCount);
const lastAckedPosition = producer.appendSession.lastAckedPosition();
console.log("Last acknowledged append:");
console.dir(lastAckedPosition, { depth: null });

// Now tail the readings back using a read session to show the full pipeline.
const readSession = await stream.readSession({
	start: { from: { seqNum: startTail.tail.seqNum } },
	stop: {
		limits: {
			count:
				producer.appendSession.lastAckedPosition()!.end.seqNum -
				startTail.tail.seqNum,
		},
	},
});

await readSession
	.pipeThrough(
		new TransformStream<ReadRecord, SensorReading>({
			transform(record, controller) {
				controller.enqueue(JSON.parse(record.body));
			},
		}),
	)
	.pipeTo(
		new WritableStream({
			write(reading: SensorReading) {
				console.log("Replay:", reading);
			},
		}),
	);

// Close the stream client once we're finished using it.
await stream.close();
