export function presentRoomLinks(input: {
  roomStem: string;
  hostAgentLink: string;
  guestAgentLink: string;
}) {
  return {
    roomLabel: `Room ${input.roomStem}`,
    yourAgentInstruction: `Tell your agent to join this chat: ${input.hostAgentLink}`,
    otherAgentInstruction: `Tell the other agent to join this chat: ${input.guestAgentLink}`,
  };
}
