import { createFileRoute } from "@tanstack/react-router";
import { replayChat } from "../server/chat";

export const Route = createFileRoute("/api/chat/replay")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const url = new URL(request.url);
				return replayChat(url.searchParams.get("id"));
			},
		},
	},
});
