import type { DetectedInvite } from "./types.js";

const INVITE_PATH_PATTERN = /^\/j\/([A-Za-z0-9_.-]+)$/;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()]+/gi;
const TRAILING_PUNCTUATION = /[.,!?;:)]$/;

export function detectInvite(text: string): DetectedInvite | null {
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = trimTrailingPunctuation(match[0]);
    let parsed: URL;

    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }

    const inviteMatch = parsed.pathname.match(INVITE_PATH_PATTERN);
    if (!inviteMatch) {
      continue;
    }

    parsed.search = "";
    parsed.hash = "";

    return {
      inviteToken: inviteMatch[1],
      inviteUrl: parsed.toString(),
    };
  }

  return null;
}

function trimTrailingPunctuation(value: string): string {
  let normalized = value;

  while (TRAILING_PUNCTUATION.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}
