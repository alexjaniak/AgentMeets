'use client';

import { startTransition, useEffect, useRef, useState } from 'react';
import { createRoom, type CreateRoomPayload } from '../lib/api';
import styles from '../app/page.module.css';

function formatCountdown(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return '0:00';
  const mins = Math.floor(diff / 60_000);
  const secs = Math.floor((diff % 60_000) / 1000);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function LabeledCopyButton({ label, contents }: { label: string; contents: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timeoutId = globalThis.setTimeout(() => setCopied(false), 1400);
    return () => globalThis.clearTimeout(timeoutId);
  }, [copied]);

  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(contents);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      className={[
        styles.copyButtonLabeled,
        copied ? styles.copyButtonLabeledCopied : '',
      ].filter(Boolean).join(' ')}
      onClick={() => { void handleClick(); }}
      type="button"
    >
      <svg className={styles.copyButtonLabeledIcon} viewBox="0 0 16 16" aria-hidden="true">
        <rect x="5.5" y="3.5" width="7" height="9" rx="1.4" />
        <path d="M4.5 10.5h-1A1.5 1.5 0 0 1 2 9V4.5A1.5 1.5 0 0 1 3.5 3h4" />
      </svg>
      {copied ? 'COPIED' : label}
    </button>
  );
}

export function HomeCarousel() {
  const [room, setRoom] = useState<CreateRoomPayload | null>(null);
  const [openingMessage, setOpeningMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [countdown, setCountdown] = useState('');
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const trimmedMessage = openingMessage.trim();

  useEffect(() => {
    if (!room) return;
    const tick = () => setCountdown(formatCountdown(room.inviteExpiresAt));
    tick();
    countdownRef.current = setInterval(tick, 1000);
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [room]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmedMessage.length === 0 || isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const createdRoom = await createRoom({ openingMessage: trimmedMessage });
      startTransition(() => {
        setRoom(createdRoom);
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to create room');
      setIsSubmitting(false);
    }
  }

  const hostCopyText = room ? `join ${room.hostAgentLink}` : '';
  const guestCopyText = room ? `join ${room.guestAgentLink}` : '';

  return (
    <>
      <div className={styles.workspaceMeta}>
        {room ? (
          <span className={styles.workspaceHint}>
            {`ROOM: ${room.roomStem} \u00b7 STATUS: ${room.status.replaceAll('_', ' ').toUpperCase()} \u00b7 EXPIRES: ${countdown}`}
          </span>
        ) : (
          <span className={styles.workspaceHint}>
            TYPE AN OPENING MESSAGE TO CREATE ROOM
          </span>
        )}
      </div>

      <div className={styles.carouselViewport}>
        {room ? (
          <div className={styles.formPaneWrapper}>
            <article className={styles.pane}>
              <div className={styles.paneChrome}>
                <div className={styles.paneLights} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className={styles.paneTab}>joining-instructions.md</div>
                <div className={styles.paneChromeActions} />
              </div>
              <div className={styles.paneBody}>
                <div className={styles.joinBody}>
                  <div className={styles.joinSection}>
                    <h3 className={styles.joinSectionHeading}>Setup (one-time)</h3>
                    <p className={styles.joinText}>1. Run in your terminal:</p>
                    <pre className={styles.joinCode}>claude mcp add innieslive -- npx innieslive@latest</pre>
                    <p className={styles.joinText}>2. Restart your Claude Code or Codex session</p>
                  </div>

                  <div className={styles.joinSection}>
                    <h3 className={styles.joinSectionHeading}>Opening Message</h3>
                    <pre className={styles.openingMessagePreview}>{trimmedMessage}</pre>
                  </div>

                  <div className={styles.joinSection}>
                    <p className={styles.joinHint}>
                      Copy and send instructions to your agent and the other agent
                    </p>
                    <div className={styles.copyButtonRow}>
                      <LabeledCopyButton label="YOUR AGENT (HOST)" contents={hostCopyText} />
                      <LabeledCopyButton label="OTHER AGENT (GUEST)" contents={guestCopyText} />
                    </div>
                  </div>
                </div>
              </div>
            </article>
          </div>
        ) : (
          <div className={styles.formPaneWrapper}>
            <article className={styles.pane}>
              <div className={styles.paneChrome}>
                <div className={styles.paneLights} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className={styles.paneTab}>create-room.md</div>
                <div className={styles.paneChromeActions} />
              </div>
              <div className={styles.paneBody}>
                <form className={styles.paneForm} onSubmit={handleSubmit}>
                  <label className={styles.formLabel} htmlFor="opening-message">
                    opening message to guest agent
                  </label>
                  <textarea
                    id="opening-message"
                    className={styles.formTextarea}
                    name="openingMessage"
                    placeholder={"Topic: Review our API rate limiting strategy\nGoal: Identify gaps in our current rate limiter and propose improvements\nDuration: ~10 minutes\nContext: We're seeing 429s spike during peak hours. The rate limiter lives in src/middleware/rate-limit.ts and uses a sliding window. Need to figure out if we should switch to token bucket or add per-endpoint limits."}
                    rows={8}
                    required
                    value={openingMessage}
                    onChange={(event) => {
                      setOpeningMessage(event.target.value);
                      if (errorMessage) setErrorMessage(null);
                    }}
                  />
                  {errorMessage ? (
                    <p className={styles.formError} role="alert">
                      {errorMessage}
                    </p>
                  ) : null}
                  <button
                    className={styles.formSubmit}
                    type="submit"
                    disabled={trimmedMessage.length === 0 || isSubmitting}
                  >
                    {isSubmitting ? 'creating room...' : 'create room'}
                  </button>
                </form>
              </div>
            </article>
          </div>
        )}
      </div>
    </>
  );
}
