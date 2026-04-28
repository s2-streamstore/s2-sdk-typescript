import { createFileRoute } from "@tanstack/react-router";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

const CHAT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const API = "/api/chat";
const HISTORY_API = `${API}/history`;
const REPLAY_API = `${API}/replay`;

type ChatMessage = {
	role: "user" | "assistant";
	content: string;
};

type DisplayMessage = ChatMessage & {
	id: string;
	streaming?: boolean;
};

type StreamChunk = {
	type: string;
	delta?: unknown;
	error?: { message?: unknown };
};

export const Route = createFileRoute("/")({
	component: ChatRoute,
});

function isValidChatId(value: unknown): value is string {
	return typeof value === "string" && CHAT_ID_PATTERN.test(value);
}

function createDisplayMessage(message: ChatMessage): DisplayMessage {
	return {
		...message,
		id: crypto.randomUUID(),
	};
}

function resolveChatId(): string {
	const url = new URL(window.location.href);
	const fromQuery = url.searchParams.get("chat");
	if (isValidChatId(fromQuery)) return fromQuery;

	const fromSession = sessionStorage.getItem("s2-tanstack-ai-chat-id");
	if (isValidChatId(fromSession)) return fromSession;

	return crypto.randomUUID();
}

function chatUrl(chatId: string): URL {
	const url = new URL(window.location.href);
	url.searchParams.set("chat", chatId);
	return url;
}

async function responseErrorMessage(response: Response): Promise<string> {
	const text = await response.text();
	if (
		text.trimStart().startsWith("<!doctype html") ||
		text.trimStart().startsWith("<html")
	) {
		return `${response.status} ${response.statusText || "Request failed"}`;
	}
	return (
		text || `${response.status} ${response.statusText || "Request failed"}`
	);
}

async function readSse(
	response: Response,
	onChunk: (chunk: StreamChunk) => void,
): Promise<void> {
	if (!response.body) throw new Error("Response body is empty");

	const events = response.body
		.pipeThrough(new TextDecoderStream())
		.pipeThrough(new EventSourceParserStream());
	const reader = events.getReader();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			if (!value || typeof value.data !== "string" || value.data === "[DONE]") {
				continue;
			}

			try {
				onChunk(JSON.parse(value.data) as StreamChunk);
			} catch {
				// Ignore non-JSON frames so the stream can continue.
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function appendAssistantDelta(
	messages: DisplayMessage[],
	assistantId: string,
	delta: string,
): DisplayMessage[] {
	return messages.map((message) =>
		message.id === assistantId
			? { ...message, content: message.content + delta }
			: message,
	);
}

function finishAssistantMessage(
	messages: DisplayMessage[],
	assistantId: string,
): DisplayMessage[] {
	return messages.map((message) =>
		message.id === assistantId ? { ...message, streaming: false } : message,
	);
}

function ChatRoute() {
	const [chatId, setChatId] = useState<string | null>(null);
	const [messages, setMessages] = useState<DisplayMessage[]>([]);
	const [input, setInput] = useState("");
	const [status, setStatus] = useState<"idle" | "loading" | "streaming">(
		"loading",
	);
	const initializedRef = useRef(false);
	const chatEndRef = useRef<HTMLDivElement | null>(null);

	const shareUrl = useMemo(
		() => (chatId ? chatUrl(chatId).toString() : ""),
		[chatId],
	);

	useEffect(() => {
		if (!chatId) return;
		const url = chatUrl(chatId);
		window.history.replaceState(
			null,
			"",
			`${url.pathname}?${url.searchParams}`,
		);
		sessionStorage.setItem("s2-tanstack-ai-chat-id", chatId);
	}, [chatId]);

	useEffect(() => {
		chatEndRef.current?.scrollIntoView({ block: "end" });
	}, [messages]);

	useEffect(() => {
		if (initializedRef.current) return;
		initializedRef.current = true;

		const id = resolveChatId();
		setChatId(id);

		(async () => {
			await loadHistory(id);
			await replayActiveTurn(id);
			setStatus("idle");
		})().catch((error) => {
			setMessages([
				createDisplayMessage({
					role: "assistant",
					content: error instanceof Error ? error.message : String(error),
				}),
			]);
			setStatus("idle");
		});
	}, []);

	async function loadHistory(id: string) {
		const response = await fetch(`${HISTORY_API}?id=${encodeURIComponent(id)}`);
		if (!response.ok) throw new Error(await responseErrorMessage(response));

		const payload = (await response.json()) as { messages?: ChatMessage[] };
		const history = Array.isArray(payload.messages) ? payload.messages : [];
		setMessages(history.map(createDisplayMessage));
	}

	async function streamIntoAssistant(response: Response) {
		const assistantId = crypto.randomUUID();
		setMessages((current) => [
			...current,
			{ id: assistantId, role: "assistant", content: "", streaming: true },
		]);

		let streamError = "";
		await readSse(response, (chunk) => {
			if (
				chunk.type === "TEXT_MESSAGE_CONTENT" &&
				typeof chunk.delta === "string"
			) {
				setMessages((current) =>
					appendAssistantDelta(current, assistantId, chunk.delta as string),
				);
			}
			if (chunk.type === "RUN_ERROR") {
				streamError =
					typeof chunk.error?.message === "string"
						? chunk.error.message
						: "Unknown model error";
			}
		});

		setMessages((current) => {
			const finished = finishAssistantMessage(current, assistantId);
			if (!streamError) return finished;
			return appendAssistantDelta(
				finished,
				assistantId,
				`\n\n[error] ${streamError}`,
			);
		});
	}

	async function replayActiveTurn(id: string) {
		setStatus("streaming");
		const response = await fetch(`${REPLAY_API}?id=${encodeURIComponent(id)}`);
		if (response.status === 204) return;
		if (!response.ok) throw new Error(await responseErrorMessage(response));
		await streamIntoAssistant(response);
	}

	async function sendMessage(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const content = input.trim();
		if (!chatId || !content || status === "streaming") return;

		setInput("");
		setStatus("streaming");
		setMessages((current) => [
			...current,
			createDisplayMessage({ role: "user", content }),
		]);

		try {
			const response = await fetch(API, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: chatId,
					message: { role: "user", content } satisfies ChatMessage,
				}),
			});

			if (!response.ok) throw new Error(await responseErrorMessage(response));
			await streamIntoAssistant(response);
		} catch (error) {
			setMessages((current) => [
				...current,
				createDisplayMessage({
					role: "assistant",
					content: error instanceof Error ? error.message : String(error),
				}),
			]);
		} finally {
			setStatus("idle");
		}
	}

	async function copyShareUrl() {
		if (!shareUrl) return;
		await navigator.clipboard.writeText(shareUrl).catch(() => {});
	}

	return (
		<main className="chat-shell">
			<header className="topbar">
				<div className="brand">
					<span className="brand-mark">S2</span>
					<div>
						<h1>TanStack AI Chat</h1>
						<p>{chatId ? `chat=${chatId}` : "starting"}</p>
					</div>
				</div>
				<div className="actions">
					<button type="button" onClick={copyShareUrl} disabled={!shareUrl}>
						Copy URL
					</button>
					<span className={`status ${status}`}>{status}</span>
				</div>
			</header>

			<section className="messages" aria-live="polite">
				{messages.length === 0 ? (
					<div className="empty-state">
						<h2>New chat</h2>
					</div>
				) : (
					messages.map((message) => (
						<article
							className={`message ${message.role}${
								message.streaming ? " streaming" : ""
							}`}
							key={message.id}
						>
							<div className="message-label">{message.role}</div>
							<div className="message-body">{message.content}</div>
						</article>
					))
				)}
				<div ref={chatEndRef} />
			</section>

			<form className="composer" onSubmit={sendMessage}>
				<input
					aria-label="Message"
					autoComplete="off"
					disabled={!chatId || status !== "idle"}
					onChange={(event) => setInput(event.target.value)}
					placeholder="Message"
					value={input}
				/>
				<button disabled={!chatId || status !== "idle" || !input.trim()}>
					Send
				</button>
			</form>
		</main>
	);
}
