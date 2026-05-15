import { createFileRoute } from "@tanstack/react-router";
import { historyChat } from "../server/chat";

export const Route = createFileRoute("/api/chat/history")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const url = new URL(request.url);
				return historyChat(url.searchParams.get("id"));
			},
		},
	},
});
