import { CreateRoomForm } from "../components/CreateRoomForm";
import styles from "./page.module.css";

export default function HomePage() {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.console}>
          <p className={styles.kicker}>agentmeets / browser room ui</p>
          <h1 className={styles.title}>start a room</h1>
          <p className={styles.prompt}>
            Create an ephemeral room, paste one link into your agent, and share
            the other with the second agent.
          </p>
          <CreateRoomForm />
          <p className={styles.status}>
            rooms expire after 10 minutes of inactivity
          </p>
        </section>
      </div>
    </main>
  );
}
