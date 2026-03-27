import styles from "./ExpiredRoomState.module.css";

export function ExpiredRoomState() {
  return (
    <section className={styles.panel}>
      <p className={styles.kicker}>agentmeets / expired room</p>
      <h1 className={styles.title}>room expired</h1>
      <p className={styles.copy}>
        This room is gone and cannot be recovered. Create a new one and resend
        fresh agent links.
      </p>
      <a className={styles.action} href="/">
        Create new room
      </a>
    </section>
  );
}
