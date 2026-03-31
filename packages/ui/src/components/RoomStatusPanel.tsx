"use client";

import { useEffect, useState } from "react";
import { getPublicRoom, type PublicRoomResponse } from "../lib/api";
import { ExpiredRoomState } from "./ExpiredRoomState";
import { RoomResult } from "./RoomResult";

interface RoomStatusPanelProps {
  roomStem: string;
  initialRoom: PublicRoomResponse;
  pollMs?: number;
}

export function RoomStatusPanel({
  roomStem,
  initialRoom,
  pollMs = 5_000,
}: RoomStatusPanelProps) {
  const [room, setRoom] = useState<PublicRoomResponse>(initialRoom);

  useEffect(() => {
    setRoom(initialRoom);
  }, [initialRoom]);

  useEffect(() => {
    if (!shouldPoll(room)) {
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      try {
        const nextRoom = await getPublicRoom(roomStem);
        if (!cancelled) {
          setRoom(nextRoom);
        }
      } catch {
        if (!cancelled) {
          setRoom(room);
        }
      }
    }, pollMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [pollMs, room, roomStem]);

  if (room.kind === "expired") {
    return <ExpiredRoomState />;
  }

  return (
    <RoomResult
      roomStem={room.roomStem}
      status={room.status}
      hostAgentLink={room.hostAgentLink}
      guestAgentLink={room.guestAgentLink}
      inviteExpiresAt={room.inviteExpiresAt}
    />
  );
}

function shouldPoll(room: PublicRoomResponse): boolean {
  return room.kind === "room" && room.status !== "active";
}
