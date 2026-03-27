export interface RawModeController {
  restore(): void;
}

export function enableRawMode(
  input: Pick<NodeJS.ReadStream, "isTTY" | "setRawMode"> & { isRaw?: boolean } = process.stdin,
): RawModeController {
  if (!input.isTTY) {
    return { restore() {} };
  }

  const wasRaw = input.isRaw === true;
  input.setRawMode(true);

  let restored = false;
  return {
    restore() {
      if (restored || wasRaw) {
        return;
      }

      restored = true;
      input.setRawMode(false);
    },
  };
}

