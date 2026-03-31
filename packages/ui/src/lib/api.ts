export interface PublicRoomPayload {
  roomId: string;
  roomStem: string;
  status: "waiting_for_join" | "activating" | "active";
  hostAgentLink: string;
  guestAgentLink: string;
  inviteExpiresAt: string | null;
}

export interface CreateRoomPayload {
  roomId: string;
  roomStem: string;
  hostAgentLink: string;
  guestAgentLink: string;
  inviteExpiresAt: string;
  status: "waiting_for_join";
}

export type PublicRoomResponse =
  | ({
      kind: "room";
    } & PublicRoomPayload)
  | {
      kind: "expired";
    };

type FetchFn = typeof fetch;

const DEFAULT_SERVER_URL =
  process.env.AGENTMEETS_SERVER_URL?.replace(/\/$/, "")
  ?? process.env.AGENTMEETS_URL?.replace(/\/$/, "")
  ?? "http://localhost:3000";

export async function readPublicRoomResponse(
  response: Response,
): Promise<PublicRoomResponse> {
  if (response.status === 410) {
    return { kind: "expired" };
  }

  if (!response.ok) {
    throw new Error(`Failed to load room: ${response.status}`);
  }

  const payload = (await response.json()) as PublicRoomPayload;
  return {
    kind: "room",
    ...payload,
  };
}

export async function readCreateRoomResponse(
  response: Response,
): Promise<CreateRoomPayload> {
  if (!response.ok) {
    const error = await readErrorMessage(response);
    throw new Error(error);
  }

  return (await response.json()) as CreateRoomPayload;
}

export async function createRoom(
  input: {
    openingMessage: string;
  },
  fetchFn: FetchFn = fetch,
): Promise<CreateRoomPayload> {
  const response = await fetchFn("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  return readCreateRoomResponse(response);
}

export async function getPublicRoom(
  roomStem: string,
  fetchFn: FetchFn = fetch,
): Promise<PublicRoomResponse> {
  const response = await fetchFn(`${DEFAULT_SERVER_URL}/public/rooms/${roomStem}`, {
    cache: "no-store",
  });

  return readPublicRoomResponse(response);
}

export async function proxyToServer(
  path: string,
  init: RequestInit,
  fetchFn: FetchFn = fetch,
): Promise<Response> {
  const response = await fetchFn(`${DEFAULT_SERVER_URL}${path}`, init);
  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) {
    headers.set("content-type", contentType);
  }

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    if (typeof payload.error === "string" && payload.error.length > 0) {
      return payload.error;
    }
  } catch {}

  return `Request failed with status ${response.status}`;
}
