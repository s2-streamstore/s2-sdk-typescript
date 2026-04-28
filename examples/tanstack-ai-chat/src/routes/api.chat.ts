import { createFileRoute } from "@tanstack/react-router";
import { postChat } from "../server/chat";

export const Route = createFileRoute("/api/chat")({
	server: {
		handlers: {
			POST: ({ request }) => postChat(request),
		},
	},
});
