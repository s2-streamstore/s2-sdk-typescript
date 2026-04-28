import { createFileRoute } from "@tanstack/react-router";
import { getSnapshot } from "../server/chat";

export const Route = createFileRoute("/api/chat/snapshot")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const url = new URL(request.url);
				return getSnapshot(url.searchParams.get("id"));
			},
		},
	},
});
