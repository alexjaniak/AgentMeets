import { proxyToServer } from "../../../../lib/api";

export async function GET(
  _request: Request,
  context: { params: Promise<{ roomStem: string }> },
) {
  const { roomStem } = await context.params;

  return proxyToServer(`/public/rooms/${roomStem}`, {
    method: "GET",
  });
}
