import { createFileRoute } from "@tanstack/react-router";
import { postChat, stopChat } from "../server/chat";

export const Route = createFileRoute("/api/chat")({
	server: {
		handlers: {
			POST: ({ request }) => postChat(request),
			DELETE: ({ request }) => stopChat(request),
		},
	},
});
