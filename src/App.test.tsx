import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("shows the CatchUp product identity", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "追更" })).toBeInTheDocument();
    expect(screen.getByText("CatchUp")).toBeInTheDocument();
    expect(
      screen.getByText(/记录剧集、番剧、综艺、小说与电影/),
    ).toBeInTheDocument();
  });
});
