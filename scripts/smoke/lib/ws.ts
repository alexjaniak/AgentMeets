export function parseServerMessage(payload: string): unknown {
  return JSON.parse(payload);
}

export async function waitForWsOpen(
  ws: WebSocket,
  timeoutMs = 5_000,
): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("WebSocket open timeout"));
    }, timeoutMs);

    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );

    ws.addEventListener(
      "error",
      (event) => {
        clearTimeout(timeout);
        reject(event);
      },
      { once: true },
    );
  });
}
