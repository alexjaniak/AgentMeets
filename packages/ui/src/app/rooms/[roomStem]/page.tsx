import { ExpiredRoomState } from "../../../components/ExpiredRoomState";
import { RoomResult } from "../../../components/RoomResult";
import { getPublicRoom } from "../../../lib/api";
import styles from "./page.module.css";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ roomStem: string }>;
}) {
  const { roomStem } = await params;
  const room = await getPublicRoom(roomStem);

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.console}>
          {room.kind === "expired" ? (
            <ExpiredRoomState />
          ) : (
            <RoomResult
              roomStem={room.roomStem}
              hostAgentLink={room.hostAgentLink}
              guestAgentLink={room.guestAgentLink}
              inviteExpiresAt={room.inviteExpiresAt}
            />
          )}
        </section>
      </div>
    </main>
  );
}
