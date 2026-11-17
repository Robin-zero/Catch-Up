import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listEntries } from "./api";
import App from "./App";
import type { MediaEntry, MediaType } from "./types";

vi.mock("./api", () => ({
  listEntries: vi.fn(),
  getLibraryErrorMessage: vi.fn(
    () => "本地内容库暂时无法读取，请检查应用状态后重试。",
  ),
}));

const mockedListEntries = vi.mocked(listEntries);

function makeEntry(overrides: Partial<MediaEntry> = {}): MediaEntry {
  return {
    id: "entry-1",
    title: "漫长的季节",
    mediaType: "drama",
    currentProgress: 3,
    totalProgress: 12,
    status: "tracking",
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-17T01:30:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockedListEntries.mockReset();
});

describe("内容库", () => {
  it("启动时显示明确的加载状态", () => {
    mockedListEntries.mockReturnValue(new Promise(() => {}));

    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "正在整理你的内容库",
    );
    expect(screen.queryByRole("list", { name: "追更内容列表" })).toBeNull();
    expect(mockedListEntries).toHaveBeenCalledTimes(1);
  });

  it("首次使用且没有条目时显示空库状态", async () => {
    mockedListEntries.mockResolvedValue([]);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "内容库还是空的" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/这里会安静地收下你的每一次追更/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "内容库摘要" })).toBeNull();
    expect(screen.queryByRole("list", { name: "追更内容列表" })).toBeNull();
  });

  it("读取失败时显示中文提示，并可通过重试恢复", async () => {
    const user = userEvent.setup();
    const entry = makeEntry({ title: "重启人生" });
    mockedListEntries
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce([entry]);

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "本地内容库暂时无法读取，请检查应用状态后重试。",
    );
    expect(screen.queryByRole("article")).toBeNull();

    await user.click(screen.getByRole("button", { name: "重新加载" }));

    expect(
      await screen.findByRole("article", { name: "重启人生" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mockedListEntries).toHaveBeenCalledTimes(2);
  });

  it("展示五类内容标识及各自正确的进度单位", async () => {
    const cases: Array<{
      mediaType: MediaType;
      label: string;
      unit: string;
      title: string;
    }> = [
      { mediaType: "drama", label: "剧集", unit: "集", title: "剧集条目" },
      { mediaType: "anime", label: "番剧", unit: "集", title: "番剧条目" },
      { mediaType: "variety", label: "综艺", unit: "集", title: "综艺条目" },
      { mediaType: "novel", label: "小说", unit: "章", title: "小说条目" },
      { mediaType: "movie", label: "电影", unit: "部", title: "电影条目" },
    ];
    mockedListEntries.mockResolvedValue(
      cases.map((item, index) =>
        makeEntry({
          id: item.mediaType,
          title: item.title,
          mediaType: item.mediaType,
          currentProgress: index + 1,
          totalProgress: 10,
        }),
      ),
    );

    render(<App />);

    expect(
      await screen.findByRole("article", { name: "剧集条目" }),
    ).toBeInTheDocument();

    cases.forEach((item, index) => {
      const card = screen.getByRole("article", { name: item.title });
      expect(within(card).getByText(item.label)).toBeInTheDocument();
      expect(
        within(card).getByText(`${index + 1} / 10 ${item.unit}`),
      ).toBeInTheDocument();
    });
  });

  it("已知总进度显示百分比，未知总进度不显示进度条或百分比", async () => {
    const known = makeEntry({
      id: "known",
      title: "已知总长度的剧",
      currentProgress: 3,
      totalProgress: 12,
    });
    const unknown = makeEntry({
      id: "unknown",
      title: "仍在连载的小说",
      mediaType: "novel",
      currentProgress: 8,
      totalProgress: null,
    });
    mockedListEntries.mockResolvedValue([known, unknown]);

    render(<App />);

    const knownCard = await screen.findByRole("article", {
      name: known.title,
    });
    expect(within(knownCard).getByText("3 / 12 集")).toBeInTheDocument();
    expect(within(knownCard).getByText("25%")).toBeInTheDocument();
    expect(
      within(knownCard).getByRole("progressbar", {
        name: `${known.title}的观看或阅读进度`,
      }),
    ).toHaveAttribute("aria-valuenow", "25");
    expect(within(knownCard).getByText(/^更新于 /)).toHaveAttribute(
      "dateTime",
      known.updatedAt,
    );

    const unknownCard = screen.getByRole("article", { name: unknown.title });
    expect(within(unknownCard).getByText("8 章")).toBeInTheDocument();
    expect(within(unknownCard).getByText(/总进度未知/)).toBeInTheDocument();
    expect(within(unknownCard).queryByRole("progressbar")).toBeNull();
    expect(within(unknownCard).queryByText(/%/)).toBeNull();
  });

  it("汇总条目总数、在追和已完成数量", async () => {
    mockedListEntries.mockResolvedValue([
      makeEntry({ id: "one", title: "在追一" }),
      makeEntry({ id: "two", title: "已完成", status: "completed" }),
      makeEntry({ id: "three", title: "在追二" }),
    ]);

    render(<App />);

    const summary = await screen.findByRole("region", {
      name: "内容库摘要",
    });
    expect(summary).toHaveTextContent("条目总数3项");
    expect(summary).toHaveTextContent("正在追更2项在追");
    expect(summary).toHaveTextContent("已经看完1项完成");
  });

  it("按照后端返回顺序展示条目", async () => {
    const titles = ["第三个的故事", "第一个的故事", "第二个的故事"];
    mockedListEntries.mockResolvedValue(
      titles.map((title, index) =>
        makeEntry({ id: `ordered-${index}`, title }),
      ),
    );

    render(<App />);

    const list = await screen.findByRole("list", { name: "追更内容列表" });
    const articles = within(list).getAllByRole("article");
    expect(
      articles.map((article) => within(article).getByRole("heading").textContent),
    ).toEqual(titles);
  });
});
