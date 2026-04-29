import { createS2Connection } from "@s2-dev/resumable-stream/tanstack-ai/client";
import type { UIMessage } from "@tanstack/ai-react";
import { useChat } from "@tanstack/ai-react";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

const CHAT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const API = "/api/chat";
const HISTORY_API = `${API}/history`;
const SUBSCRIBE_API = `${API}/replay`;

type StreamMode = "single-use" | "shared" | "session";

function streamModeFromEnv(): StreamMode {
	const raw = import.meta.env.VITE_S2_TANSTACK_MODE;
	if (raw === "single-use" || raw === "shared" || raw === "session") {
		return raw;
	}
	return "session";
}

// Must match the server's `S2_TANSTACK_MODE`. Default `session`.
const STREAM_MODE = streamModeFromEnv();

type ChatMessage = UIMessage;

export const Route = createFileRoute("/")({
	component: ChatRoute,
});

function isValidChatId(value: unknown): value is string {
	return typeof value === "string" && CHAT_ID_PATTERN.test(value);
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

function subscribeUrl(chatId: string): string {
	return `${SUBSCRIBE_API}?${new URLSearchParams({ id: chatId })}`;
}

function historyToInitialMessages(history: ChatMessage[]): UIMessage[] {
	return history.map((message) => ({
		...message,
		id: typeof message.id === "string" ? message.id : crypto.randomUUID(),
		role: message.role,
		parts: Array.isArray(message.parts) ? message.parts : [],
		createdAt: message.createdAt ? new Date(message.createdAt) : new Date(),
	}));
}

function renderMessageText(message: UIMessage): string {
	return message.parts
		.filter(
			(part): part is { type: "text"; content: string } =>
				part.type === "text" && typeof part.content === "string",
		)
		.map((part) => part.content)
		.join("");
}

function hasActiveTurn(messages: UIMessage[]): boolean {
	const userCount = messages.filter(
		(message) => message.role === "user",
	).length;
	const assistantCount = messages.filter(
		(message) => message.role === "assistant",
	).length;
	return userCount > assistantCount;
}

function ChatRoute() {
	const [chatId, setChatId] = useState<string | null>(null);
	const [initialMessages, setInitialMessages] = useState<UIMessage[] | null>(
		null,
	);
	const [historyError, setHistoryError] = useState<string | null>(null);
	const initializedRef = useRef(false);
	const chatEndRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (initializedRef.current) return;
		initializedRef.current = true;
		const id = resolveChatId();
		setChatId(id);
		const url = chatUrl(id);
		window.history.replaceState(
			null,
			"",
			`${url.pathname}?${url.searchParams}`,
		);
		sessionStorage.setItem("s2-tanstack-ai-chat-id", id);

		if (STREAM_MODE === "session") {
			setInitialMessages([]);
			return;
		}

		fetch(`${HISTORY_API}?id=${encodeURIComponent(id)}`)
			.then(async (response) => {
				if (!response.ok) {
					throw new Error(`${response.status} ${response.statusText}`);
				}
				const payload = (await response.json()) as { messages?: ChatMessage[] };
				setInitialMessages(historyToInitialMessages(payload.messages ?? []));
			})
			.catch((error) => {
				setHistoryError(error instanceof Error ? error.message : String(error));
				setInitialMessages([]);
			});
	}, []);

	if (chatId === null || initialMessages === null) {
		return (
			<main className="chat-shell">
				<header className="topbar">
					<div className="brand">
						<span className="brand-mark">S2</span>
						<div>
							<h1>TanStack AI Chat</h1>
							<p>{historyError ?? "starting"}</p>
						</div>
					</div>
				</header>
			</main>
		);
	}

	return (
		<ChatInner
			chatId={chatId}
			initialMessages={initialMessages}
			historyError={historyError}
			chatEndRef={chatEndRef}
		/>
	);
}

function ChatInner({
	chatId,
	initialMessages,
	historyError,
	chatEndRef,
}: {
	chatId: string;
	initialMessages: UIMessage[];
	historyError: string | null;
	chatEndRef: React.RefObject<HTMLDivElement | null>;
}) {
	const shouldReplayOnMount =
		STREAM_MODE === "session" ||
		(STREAM_MODE !== "session" && hasActiveTurn(initialMessages));
	const connection = useMemo(
		() =>
			createS2Connection({
				sendUrl: API,
				...(shouldReplayOnMount ? { subscribeUrl: subscribeUrl(chatId) } : {}),
				mode: STREAM_MODE,
				body: { id: chatId },
			}),
		[chatId, shouldReplayOnMount],
	);

	const { messages, sendMessage, isLoading, sessionGenerating } = useChat({
		connection,
		initialMessages,
		// Replay on mount only when there is session state or an active turn.
		live: shouldReplayOnMount,
	});

	const [input, setInput] = useState("");

	const shareUrl = useMemo(() => chatUrl(chatId).toString(), [chatId]);

	useEffect(() => {
		chatEndRef.current?.scrollIntoView({ block: "end" });
	}, [messages, chatEndRef]);

	const isStreaming = isLoading || sessionGenerating;
	const status = isStreaming ? "streaming" : "idle";

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const content = input.trim();
		if (!content || isStreaming) return;
		setInput("");
		sendMessage(content);
	}

	async function copyShareUrl() {
		await navigator.clipboard.writeText(shareUrl).catch(() => {});
	}

	return (
		<main className="chat-shell">
			<header className="topbar">
				<div className="brand">
					<span className="brand-mark">S2</span>
					<div>
						<h1>TanStack AI Chat</h1>
						<p>{historyError ?? `chat=${chatId}`}</p>
					</div>
				</div>
				<div className="actions">
					<button type="button" onClick={copyShareUrl}>
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
								isStreaming && message === messages.at(-1) ? " streaming" : ""
							}`}
							key={message.id}
						>
							<div className="message-label">{message.role}</div>
							<div className="message-body">{renderMessageText(message)}</div>
						</article>
					))
				)}
				<div ref={chatEndRef} />
			</section>

			<form className="composer" onSubmit={onSubmit}>
				<input
					aria-label="Message"
					autoComplete="off"
					disabled={isStreaming}
					onChange={(event) => setInput(event.target.value)}
					placeholder="Message"
					value={input}
				/>
				<button disabled={isStreaming || !input.trim()}>Send</button>
			</form>
		</main>
	);
}
