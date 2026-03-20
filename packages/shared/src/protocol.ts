// Client → Server messages

export interface MessagePayload {
  type: "message";
  content: string;
}

export interface EndPayload {
  type: "end";
}

export type ClientMessage = MessagePayload | EndPayload;

// Server → Client messages

export interface MessageEvent {
  type: "message";
  content: string;
}

export interface JoinedEvent {
  type: "joined";
}

export interface EndedEvent {
  type: "ended";
  reason: "closed" | "timeout" | "idle";
}

export type ServerMessage = MessageEvent | JoinedEvent | EndedEvent;
