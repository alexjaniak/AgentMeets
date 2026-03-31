import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExpiredRoomState } from "./ExpiredRoomState";

describe("ExpiredRoomState", () => {
  test("renders the dead-end recovery action", () => {
    const markup = renderToStaticMarkup(<ExpiredRoomState />);

    expect(markup).toContain("room expired");
    expect(markup).toContain('href="/"');
    expect(markup).toContain("Create new room");
  });
});
