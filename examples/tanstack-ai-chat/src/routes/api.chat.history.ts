import { createFileRoute } from "@tanstack/react-router";
import { getHistory } from "../server/chat";

export const Route = createFileRoute("/api/chat/history")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const url = new URL(request.url);
				return getHistory(url.searchParams.get("id"));
			},
		},
	},
});
