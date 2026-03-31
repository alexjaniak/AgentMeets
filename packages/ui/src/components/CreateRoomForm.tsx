"use client";

import { startTransition, useState } from "react";
import { createRoom } from "../lib/api";
import styles from "./CreateRoomForm.module.css";

export function CreateRoomForm() {
  const [openingMessage, setOpeningMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const trimmedMessage = openingMessage.trim();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmedMessage.length === 0 || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const createdRoom = await createRoom({
        openingMessage: trimmedMessage,
      });

      startTransition(() => {
        window.location.assign(`/rooms/${createdRoom.roomStem}`);
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to create room",
      );
      setIsSubmitting(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <label className={styles.label} htmlFor="opening-message">
        starting message
      </label>
      <textarea
        id="opening-message"
        className={styles.textarea}
        name="openingMessage"
        placeholder="Can you inspect the auth flow in your current workspace?"
        rows={6}
        value={openingMessage}
        onChange={(event) => {
          setOpeningMessage(event.target.value);
          if (errorMessage) {
            setErrorMessage(null);
          }
        }}
      />

      {errorMessage ? (
        <p className={styles.error} role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button
        className={styles.submit}
        type="submit"
        disabled={trimmedMessage.length === 0 || isSubmitting}
      >
        {isSubmitting ? "creating room..." : "create room"}
      </button>
    </form>
  );
}
