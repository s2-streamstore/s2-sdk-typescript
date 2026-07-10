import {
	adaptFetch,
	AppendInput,
	AppendRecord,
	S2,
	S2Error,
	type ReadSession,
	type S2Stream,
} from "@s2-dev/streamstore";
import { StatusBar } from "expo-status-bar";
import { fetch as expoFetch } from "expo/fetch";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	Button,
	FlatList,
	KeyboardAvoidingView,
	Platform,
	SafeAreaView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";

type LogEntry = {
	key: string;
	seqNum?: number;
	text: string;
};

export default function App() {
	const [accessToken, setAccessToken] = useState("");
	const [basinName, setBasinName] = useState("");
	const [streamName, setStreamName] = useState("rn-example");
	const [message, setMessage] = useState("hello from react native");
	const [status, setStatus] = useState<"idle" | "connecting" | "tailing">(
		"idle",
	);
	const [entries, setEntries] = useState<LogEntry[]>([]);

	const streamRef = useRef<S2Stream | null>(null);
	const sessionRef = useRef<ReadSession | null>(null);

	const log = useCallback((text: string, seqNum?: number) => {
		setEntries((prev) => [
			{ key: `${Date.now()}-${prev.length}`, seqNum, text },
			...prev,
		]);
	}, []);

	const disconnect = useCallback(async () => {
		await sessionRef.current?.cancel().catch(() => {});
		sessionRef.current = null;
		streamRef.current = null;
		setStatus("idle");
	}, []);

	useEffect(() => {
		return () => {
			void disconnect();
		};
	}, [disconnect]);

	const connect = useCallback(async () => {
		await disconnect();
		setStatus("connecting");
		try {
			const s2 = new S2({
				accessToken,
				// React Native's built-in fetch buffers response bodies; expo/fetch
				// streams them, which read sessions require. adaptFetch bridges
				// expo/fetch's (url, init) signature to the Request objects the
				// SDK passes.
				fetch: adaptFetch(expoFetch),
			});
			const basin = s2.basin(basinName);
			await basin.streams.create({ stream: streamName }).catch((error) => {
				if (!(error instanceof S2Error && error.status === 409)) {
					throw error;
				}
			});
			const stream = basin.stream(streamName);
			streamRef.current = stream;

			const session = await stream.readSession({
				start: { from: { tailOffset: 10 }, clamp: true },
			});
			sessionRef.current = session;
			setStatus("tailing");
			log(`tailing ${basinName}/${streamName}`);

			for await (const record of session) {
				log(record.body ?? "", record.seqNum);
			}
			log("read session ended");
		} catch (error) {
			log(`error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setStatus("idle");
			sessionRef.current = null;
		}
	}, [accessToken, basinName, streamName, disconnect, log]);

	const append = useCallback(async () => {
		const stream = streamRef.current;
		if (!stream) {
			log("connect first");
			return;
		}
		try {
			const ack = await stream.append(
				AppendInput.create([AppendRecord.string({ body: message })]),
			);
			log(`appended at seqNum ${ack.start.seqNum}`);
		} catch (error) {
			log(`error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}, [message, log]);

	return (
		<SafeAreaView style={styles.container}>
			<StatusBar style="auto" />
			<KeyboardAvoidingView
				style={styles.inner}
				behavior={Platform.OS === "ios" ? "padding" : undefined}
			>
				<Text style={styles.title}>S2 Streamstore</Text>
				<TextInput
					style={styles.input}
					placeholder="Access token"
					value={accessToken}
					onChangeText={setAccessToken}
					autoCapitalize="none"
					secureTextEntry
				/>
				<TextInput
					style={styles.input}
					placeholder="Basin"
					value={basinName}
					onChangeText={setBasinName}
					autoCapitalize="none"
				/>
				<TextInput
					style={styles.input}
					placeholder="Stream"
					value={streamName}
					onChangeText={setStreamName}
					autoCapitalize="none"
				/>
				<Button
					title={status === "idle" ? "Connect & tail" : `Status: ${status}`}
					onPress={connect}
					disabled={status !== "idle" || !accessToken || !basinName}
				/>
				<View style={styles.appendRow}>
					<TextInput
						style={[styles.input, styles.appendInput]}
						placeholder="Message"
						value={message}
						onChangeText={setMessage}
					/>
					<Button
						title="Append"
						onPress={append}
						disabled={status !== "tailing"}
					/>
				</View>
				<FlatList
					style={styles.log}
					data={entries}
					renderItem={({ item }) => (
						<Text style={styles.logEntry}>
							{item.seqNum !== undefined ? `#${item.seqNum} ` : ""}
							{item.text}
						</Text>
					)}
				/>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, backgroundColor: "#fff" },
	inner: { flex: 1, padding: 16, gap: 8 },
	title: { fontSize: 20, fontWeight: "600" },
	input: {
		borderWidth: 1,
		borderColor: "#ccc",
		borderRadius: 6,
		paddingHorizontal: 10,
		paddingVertical: 8,
	},
	appendRow: { flexDirection: "row", alignItems: "center", gap: 8 },
	appendInput: { flex: 1 },
	log: { flex: 1, marginTop: 8 },
	logEntry: { fontFamily: "monospace", fontSize: 12, paddingVertical: 2 },
});
