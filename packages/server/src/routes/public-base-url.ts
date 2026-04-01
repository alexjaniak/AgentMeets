const DEFAULT_PUBLIC_BASE_URL = "https://api.innies.live";

export function getPublicBaseUrl(): string {
  return process.env.PUBLIC_URL?.replace(/\/$/, "") ?? DEFAULT_PUBLIC_BASE_URL;
}

export function buildInviteUrl(inviteToken: string): string {
  return `${getPublicBaseUrl()}/j/${inviteToken}`;
}
