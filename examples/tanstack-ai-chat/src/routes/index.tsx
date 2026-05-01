import { createS2Connection } from "@s2-dev/resumable-stream/tanstack-ai/client";
import type { UIMessage } from "@tanstack/ai-react";
import { useChat } from "@tanstack/ai-react";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

const CHAT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const API = "/api/chat";
const SUBSCRIBE_API = `${API}/replay`;

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

function renderMessageText(message: UIMessage): string {
	return message.parts
		.filter(
			(part): part is { type: "text"; content: string } =>
				part.type === "text" && typeof part.content === "string",
		)
		.map((part) => part.content)
		.join("");
}

function ChatRoute() {
	const [chatId, setChatId] = useState<string | null>(null);
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
	}, []);

	if (chatId === null) {
		return (
			<main className="chat-shell">
				<header className="topbar">
					<div className="brand">
						<span className="brand-mark">S2</span>
						<div>
							<h1>TanStack AI Chat</h1>
							<p>starting</p>
						</div>
					</div>
				</header>
			</main>
		);
	}

	return <ChatInner chatId={chatId} chatEndRef={chatEndRef} />;
}

function ChatInner({
	chatId,
	chatEndRef,
}: {
	chatId: string;
	chatEndRef: React.RefObject<HTMLDivElement | null>;
}) {
	const connection = useMemo(
		() =>
			createS2Connection({
				sendUrl: API,
				stopUrl: API,
				subscribeUrl: subscribeUrl(chatId),
				mode: "session",
				body: { id: chatId },
			}),
		[chatId],
	);

	const { messages, sendMessage, isLoading, sessionGenerating, stop } = useChat(
		{
			connection,
			live: true,
		},
	);

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

	function onStop() {
		stop();
		void connection.stop?.();
	}

	return (
		<main className="chat-shell">
			<header className="topbar">
				<div className="brand">
					<span className="brand-mark">S2</span>
					<div>
						<h1>TanStack AI Chat</h1>
						<p>{`chat=${chatId}`}</p>
					</div>
				</div>
				<div className="actions">
					<button type="button" onClick={copyShareUrl}>
						Copy URL
					</button>
					{isStreaming ? (
						<button type="button" onClick={onStop}>
							Stop
						</button>
					) : null}
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
