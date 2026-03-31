import { describe, expect, test } from "bun:test";
import { registerMeetTools } from "./register-tools.ts";

function textResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

describe("registerMeetTools", () => {
  test("registers wait_for_reply and routes it to listen-only sendAndWait", async () => {
    const tools = new Map<
      string,
      { description: string; inputSchema: unknown; handler: (args: unknown) => Promise<unknown> }
    >();

    const server = {
      registerTool(
        name: string,
        config: { description: string; inputSchema: unknown },
        handler: (args: unknown) => Promise<unknown>,
      ) {
        tools.set(name, { ...config, handler });
      },
      tool(
        name: string,
        description: string,
        inputSchema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        tools.set(name, { description, inputSchema, handler });
      },
    };

    const controller = {
      createMeet: async () => textResult({ ok: true }),
      hostMeet: async () => textResult({ ok: true }),
      guestMeet: async () => textResult({ ok: true }),
      joinMeet: async () => textResult({ ok: true }),
      sendAndWait: async (input: { message?: string; timeout?: number }) =>
        textResult({ seen: input }),
      endMeet: async () => textResult({ ok: true }),
    };

    registerMeetTools(server as never, controller as never);

    expect(tools.has("wait_for_reply")).toBe(true);
    expect(tools.has("send_and_wait")).toBe(true);

    const result = (await tools.get("wait_for_reply")!.handler({
      timeout: 42,
    })) as {
      content: Array<{ text: string }>;
    };

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      seen: { timeout: 42 },
    });
    expect(tools.get("wait_for_reply")!.description).toContain(
      "Wait for the other participant's next reply",
    );
  });
});
