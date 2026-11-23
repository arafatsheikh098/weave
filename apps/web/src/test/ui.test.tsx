import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fuzzyScore } from "../components/CommandPalette";
import { StatusPill } from "../components/workspace";

describe("StatusPill", () => {
  it("says everything is saved when live and in sync", () => {
    render(<StatusPill status="live" unsynced={0} />);
    expect(screen.getByRole("status")).toHaveTextContent("All changes saved");
  });

  it("counts unsynced edits while offline", () => {
    render(<StatusPill status="offline" unsynced={3} />);
    expect(screen.getByRole("status")).toHaveTextContent("Offline · 3 unsynced edits");
  });

  it("shows saving while edits are in flight", () => {
    render(<StatusPill status="live" unsynced={1} />);
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
  });
});

describe("fuzzyScore", () => {
  it("matches letters in order and prefers word starts", () => {
    expect(fuzzyScore("Compile PDF", "cpdf")).toBeGreaterThan(0);
    expect(fuzzyScore("Compile PDF", "xyz")).toBe(0);
    expect(fuzzyScore("chapters/intro.tex", "intro")).toBeGreaterThan(fuzzyScore("chapters/intro.tex", "ptr"));
  });
});
