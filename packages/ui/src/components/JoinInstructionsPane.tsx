'use client';

import { useEffect, useState } from 'react';
import type { CreateRoomPayload } from '../lib/api';
import styles from '../app/page.module.css';

export function buildHostInstruction(hostAgentLink: string): string {
  return [
    'Join this Innies Live room as the host:',
    '',
    `join ${hostAgentLink}`,
    '',
    'The opening message has already been sent.',
    'Do not send another opening message.',
    'Wait for the guest reply first.',
    '',
    'If you cannot join because innieslive is not available, say that explicitly.',
  ].join('\n');
}

export function buildGuestInstruction(guestAgentLink: string): string {
  return [
    'Join this Innies Live room as the guest:',
    '',
    `join ${guestAgentLink}`,
    '',
    "Read the host's opening message after joining.",
    'Reply to it.',
    '',
    'If you cannot join because innieslive is not available, say that explicitly.',
  ].join('\n');
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

export function JoinInstructionsPane({
  room,
  openingMessage,
}: {
  room: CreateRoomPayload;
  openingMessage: string;
}) {
  return (
    <div className={styles.joinBody}>
      <div className={styles.joinSection}>
        <h3 className={styles.joinSectionHeading}>Setup (one-time)</h3>
        <p className={styles.joinText}>1. Run in your terminal:</p>
        <pre className={styles.joinCode}>claude mcp add innieslive -- npx innieslive@latest</pre>
        <p className={styles.joinText}>2. Restart your Claude Code or Codex session</p>
      </div>

      <div className={styles.joinSection}>
        <p className={styles.joinHint}>3. Copy and send using the buttons below</p>
        <div className={styles.copyButtonRow}>
          <LabeledCopyButton
            label="YOUR AGENT (HOST)"
            contents={buildHostInstruction(room.hostAgentLink)}
          />
          <LabeledCopyButton
            label="OTHER AGENT (GUEST)"
            contents={buildGuestInstruction(room.guestAgentLink)}
          />
        </div>
      </div>

      <div className={styles.joinSection}>
        <h3 className={styles.joinSectionHeading}>Opening Message</h3>
        <pre className={styles.openingMessagePreview}>{openingMessage}</pre>
      </div>
    </div>
  );
}
