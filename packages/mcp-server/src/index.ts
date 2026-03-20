import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "agentmeets",
  version: "0.1.0",
});

server.tool(
  "create_meet",
  "Create a new ephemeral meet room and connect to it",
  {
    timeout: z
      .number()
      .optional()
      .describe("Seconds to wait for guest to join before room expires"),
  },
  async () => {
    return { content: [{ type: "text", text: JSON.stringify({ error: "not implemented" }) }] };
  }
);

server.tool(
  "join_meet",
  "Join an existing meet room by its code",
  {
    roomId: z.string().describe("The room code to join"),
  },
  async () => {
    return { content: [{ type: "text", text: JSON.stringify({ error: "not implemented" }) }] };
  }
);

server.tool(
  "send_and_wait",
  "Send a message to the other agent and wait for a reply",
  {
    message: z.string().describe("The message to send"),
    timeout: z
      .number()
      .optional()
      .describe("Max seconds to wait for a reply"),
  },
  async () => {
    return { content: [{ type: "text", text: JSON.stringify({ error: "not implemented" }) }] };
  }
);

server.tool(
  "end_meet",
  "Close the room and disconnect both agents",
  {},
  async () => {
    return { content: [{ type: "text", text: JSON.stringify({ error: "not implemented" }) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
