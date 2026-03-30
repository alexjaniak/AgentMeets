'use client';

import { startTransition, useEffect, useState, type CSSProperties } from 'react';
import { createRoom, type CreateRoomPayload } from '../lib/api';
import { PaneCopyButton } from './PaneCopyButton';
import styles from '../app/page.module.css';

function pageSizeForWidth(width: number): number {
  if (width <= 720) return 1;
  if (width <= 1080) return 2;
  return 3;
}

function clampPageIndex(index: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.min(Math.max(index, 0), pageCount - 1);
}

function getPageButtonState(pageIndex: number, pageCount: number) {
  const current = clampPageIndex(pageIndex, pageCount);
  return {
    canScrollLeft: current > 0,
    canScrollRight: current < pageCount - 1,
  };
}

function chunkIntoPages<T>(items: readonly T[], pageSize: number): T[][] {
  if (pageSize <= 0) return [];
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += pageSize) {
    pages.push(items.slice(index, index + pageSize));
  }
  return pages;
}

interface PaneLine {
  number: number;
  text: string;
  kind: string;
}

interface PaneData {
  id: string;
  fileName: string;
  lines: PaneLine[];
  copyText: string;
}

function lineKind(text: string, isLink: boolean): string {
  if (text.startsWith('# ')) return 'heading1';
  if (text.startsWith('## ')) return 'heading2';
  if (text === '') return 'blank';
  if (isLink) return 'codeFence';
  if (text.startsWith('room:') || text.startsWith('status:')) return 'code';
  return 'text';
}

function buildInstructionPane(
  id: string,
  fileName: string,
  role: string,
  instruction: string,
  link: string,
  details: string[],
): PaneData {
  const rawLines = [
    `# ${role}`,
    '',
    instruction,
    '',
    link,
    '',
    ...details,
  ];

  return {
    id,
    fileName,
    lines: rawLines.map((text, i) => ({
      number: i + 1,
      text,
      kind: lineKind(text, text === link),
    })),
    copyText: link,
  };
}

function buildRoomInfoPane(room: CreateRoomPayload): PaneData {
  const rawLines = [
    '# Room Created',
    '',
    `room: ${room.roomStem}`,
    `status: ${room.status}`,
    '',
    'Copy the links from the panels and paste them into your agent sessions to start chatting.',
    '',
    'Rooms expire after 10 minutes of inactivity.',
  ];

  return {
    id: 'room-info',
    fileName: 'room-info.md',
    lines: rawLines.map((text, i) => ({
      number: i + 1,
      text,
      kind: lineKind(text, false),
    })),
    copyText: `Room: ${room.roomStem}\nHost: ${room.hostAgentLink}\nGuest: ${room.guestAgentLink}`,
  };
}

function InstructionPaneCard({ pane }: { pane: PaneData }) {
  return (
    <article aria-label={pane.fileName} className={styles.pane}>
      <div className={styles.paneChrome}>
        <div className={styles.paneLights} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className={styles.paneTab}>{pane.fileName}</div>
        <div className={styles.paneChromeActions}>
          <div className={styles.paneCount}>{pane.lines.length} lines</div>
          <PaneCopyButton fileName={pane.fileName} contents={pane.copyText} />
        </div>
      </div>
      <div className={styles.paneBody}>
        <div className={styles.paneRows}>
          {pane.lines.map((line) => (
            <div key={`${pane.id}-${line.number}`} className={styles.paneLine}>
              <span className={styles.lineNumber}>{line.number}</span>
              <span
                className={[
                  styles.lineText,
                  styles[`line_${line.kind}`],
                ].filter(Boolean).join(' ')}
              >
                {line.text.length > 0 ? line.text : ' '}
              </span>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

export function HomeCarousel() {
  const [room, setRoom] = useState<CreateRoomPayload | null>(null);
  const [openingMessage, setOpeningMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pageSize, setPageSize] = useState(3);
  const [activePage, setActivePage] = useState(0);

  const trimmedMessage = openingMessage.trim();

  const panes: PaneData[] = room
    ? [
        buildRoomInfoPane(room),
        buildInstructionPane(
          'host',
          'host-agent.md',
          'Host Agent',
          'Tell your agent to join this chat:',
          room.hostAgentLink,
          [
            'Paste this link into your Claude Code or Codex session.',
          ],
        ),
        buildInstructionPane(
          'guest',
          'guest-agent.md',
          'Guest Agent',
          'Share this link with the other agent:',
          room.guestAgentLink,
          [
            'The other agent pastes this link to join the conversation.',
          ],
        ),
      ]
    : [];

  const pages = room ? chunkIntoPages(panes, pageSize) : [];
  const buttonState = getPageButtonState(activePage, pages.length);
  const showCarouselControls = room && pages.length > 1;

  useEffect(() => {
    const syncPageSize = () => {
      const nextPageSize = pageSizeForWidth(globalThis.innerWidth);
      startTransition(() => {
        setPageSize((current) => (current === nextPageSize ? current : nextPageSize));
        setActivePage((current) =>
          clampPageIndex(current, Math.ceil(Math.max(panes.length, 1) / nextPageSize)),
        );
      });
    };
    syncPageSize();
    globalThis.addEventListener('resize', syncPageSize);
    return () => globalThis.removeEventListener('resize', syncPageSize);
  }, [panes.length]);

  const goToPage = (targetPage: number) => {
    startTransition(() => {
      setActivePage(clampPageIndex(targetPage, pages.length));
    });
  };

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmedMessage.length === 0 || isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const createdRoom = await createRoom({ openingMessage: trimmedMessage });
      startTransition(() => {
        setRoom(createdRoom);
        setActivePage(0);
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to create room');
      setIsSubmitting(false);
    }
  }

  return (
    <>
      {room ? (
        <div className={styles.workspaceMeta}>
          <span className={styles.workspaceLabel}>
            ROOM WORKSPACE
          </span>
          <span className={styles.workspaceHint}>
            {`${panes.length} PANES LOADED \u00b7 COPY AND SEND TO AGENT`}
          </span>

        {showCarouselControls ? (
          <div className={styles.carouselControls}>
            <button
              aria-label="Previous page"
              className={styles.carouselButton}
              disabled={!buttonState.canScrollLeft}
              onClick={() => goToPage(activePage - 1)}
              type="button"
            >
              LEFT
            </button>
            <div className={styles.carouselPosition}>
              {activePage + 1} / {pages.length}
            </div>
            <button
              aria-label="Next page"
              className={styles.carouselButton}
              disabled={!buttonState.canScrollRight}
              onClick={() => goToPage(activePage + 1)}
              type="button"
            >
              RIGHT
            </button>
          </div>
        ) : null}
        </div>
      ) : null}

      <div className={styles.carouselViewport}>
        {room ? (
          <div
            className={styles.carouselTrack}
            style={{
              '--page-columns': String(pageSize),
              transform: `translateX(-${activePage * 100}%)`,
            } as CSSProperties}
          >
            {pages.map((page, pageIndex) => (
              <div
                key={`page-${pageIndex + 1}`}
                className={styles.carouselPage}
                role="group"
              >
                {page.map((pane) => (
                  <InstructionPaneCard key={pane.id} pane={pane} />
                ))}
              </div>
            ))}
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
                <div className={styles.paneChromeActions}>
                  <div className={styles.paneCount}>new room</div>
                </div>
              </div>
              <div className={styles.paneBody}>
                <form className={styles.paneForm} onSubmit={handleSubmit}>
                  <label className={styles.formLabel} htmlFor="opening-message">
                    opening message
                  </label>
                  <textarea
                    id="opening-message"
                    className={styles.formTextarea}
                    name="openingMessage"
                    placeholder="Can you inspect the auth flow in your current workspace?"
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
