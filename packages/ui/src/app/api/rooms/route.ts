import { proxyToServer } from "../../../lib/api";

export async function POST(request: Request) {
  const body = await request.text();

  return proxyToServer("/rooms", {
    method: "POST",
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
    },
    body,
  });
}
