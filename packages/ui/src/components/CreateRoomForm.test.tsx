import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CreateRoomForm } from "./CreateRoomForm";

describe("CreateRoomForm", () => {
  test("requires a starting message before submit", () => {
    const markup = renderToStaticMarkup(<CreateRoomForm />);

    expect(markup).toContain("create room");
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>create room<\/button>/i);
  });
});
