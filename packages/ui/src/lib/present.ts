export function presentRoomLinks(input: {
  hostAgentLink: string;
  guestAgentLink: string;
}) {
  return {
    yourAgentInstruction: `Tell your agent to join this chat: ${input.hostAgentLink}`,
    otherAgentInstruction: `Tell the other agent to join this chat: ${input.guestAgentLink}`,
  };
}
