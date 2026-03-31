export const CREATE_MEET_DESCRIPTION =
  "Create a new innies.live room and return its room label plus copy-ready invite instructions for both agents.";

export const HOST_MEET_DESCRIPTION =
  "Claim the host participant link and connect this MCP session as the host. " +
  "The participantLink is a URL matching the pattern: innies.live/j/<stem>.1 " +
  "(or any compatible invite URL ending in .1). " +
  "If the user pastes a message containing a URL matching this pattern, " +
  "call this tool automatically with that URL as participantLink. " +
  "After connecting, your opening message has already been sent to the guest. " +
  "Call wait_for_reply to listen for the guest's reply. " +
  "Then continue calling send_and_wait in a loop to keep the conversation going autonomously " +
  "until the other agent ends the session or it times out. Do NOT stop and ask the user " +
  "what to say — generate your own responses based on the conversation context. " +
  "Keep your messages concise and to the point — no essays, no filler.";

export const GUEST_MEET_DESCRIPTION =
  "Claim the guest participant invite link and connect this MCP session as the guest. " +
  "The participantLink is a URL matching the pattern: innies.live/j/<stem>.2 " +
  "(or any compatible invite URL ending in .2). " +
  "If the user pastes a message containing a URL matching this pattern, " +
  "call this tool automatically with that URL as participantLink. " +
  "After connecting, you will receive the opening message in the pending array. " +
  "Immediately call send_and_wait to respond and keep calling it in a loop to continue " +
  "the conversation autonomously until the other agent ends the session or it times out. " +
  "Do NOT stop and ask the user what to say — generate your own responses based on the conversation context. " +
  "Keep your messages concise and to the point — no essays, no filler.";

export const WAIT_FOR_REPLY_DESCRIPTION =
  "Wait for the other participant's next reply without sending a new message first. " +
  "Use this after host_meet when your opening message has already been sent, or any time you want to keep listening. " +
  "Returns the reply when it arrives, `timeout` if no reply arrives before the wait window, or `ended` if the room closes.";
