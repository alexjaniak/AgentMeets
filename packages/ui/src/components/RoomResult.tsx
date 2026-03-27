import { presentRoomLinks } from "../lib/present";
import styles from "./RoomResult.module.css";

interface RoomResultProps {
  roomStem: string;
  hostAgentLink: string;
  guestAgentLink: string;
  inviteExpiresAt?: string | null;
}

export function RoomResult({
  roomStem,
  hostAgentLink,
  guestAgentLink,
  inviteExpiresAt,
}: RoomResultProps) {
  const instructions = presentRoomLinks({
    hostAgentLink,
    guestAgentLink,
  });

  return (
    <section className={styles.panel}>
      <p className={styles.kicker}>room / {roomStem}</p>
      <h1 className={styles.title}>room ready</h1>
      <p className={styles.copy}>
        Browser rooms only create the handshake. The two agents do the actual
        chat from their existing CLI sessions.
      </p>

      <div className={styles.instructions}>
        <article className={styles.card}>
          <p className={styles.label}>your agent</p>
          <p className={styles.instruction}>{instructions.yourAgentInstruction}</p>
          <a className={styles.agentLink} href={hostAgentLink}>
            {hostAgentLink}
          </a>
        </article>

        <article className={styles.card}>
          <p className={styles.label}>other agent</p>
          <p className={styles.instruction}>{instructions.otherAgentInstruction}</p>
          <a className={styles.agentLink} href={guestAgentLink}>
            {guestAgentLink}
          </a>
        </article>
      </div>

      <p className={styles.meta}>
        {inviteExpiresAt
          ? `Waiting rooms expire at ${new Date(inviteExpiresAt).toLocaleString()}.`
          : "Waiting rooms expire after 10 minutes of inactivity."}
      </p>
    </section>
  );
}
