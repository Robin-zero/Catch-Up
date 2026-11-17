import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adjustProgress,
  createEntry,
  deleteEntry,
  listEntries,
  setEntryStatus,
  updateEntry,
} from "./api";
import App from "./App";
import type { MediaEntry, MediaType } from "./types";

vi.mock("./api", () => ({
  listEntries: vi.fn(),
  createEntry: vi.fn(),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn(),
  adjustProgress: vi.fn(),
  setEntryStatus: vi.fn(),
  getLibraryErrorMessage: vi.fn(
    () => "本地内容库暂时无法读取，请检查应用状态后重试。",
  ),
}));

const mockedListEntries = vi.mocked(listEntries);
const mockedCreateEntry = vi.mocked(createEntry);
const mockedUpdateEntry = vi.mocked(updateEntry);
const mockedDeleteEntry = vi.mocked(deleteEntry);
const mockedAdjustProgress = vi.mocked(adjustProgress);
const mockedSetEntryStatus = vi.mocked(setEntryStatus);

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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockedListEntries.mockReset();
  mockedCreateEntry.mockReset();
  mockedUpdateEntry.mockReset();
  mockedDeleteEntry.mockReset();
  mockedAdjustProgress.mockReset();
  mockedSetEntryStatus.mockReset();
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

describe("快捷进度操作", () => {
  it("加一使用后端结果自动完成，并同步摘要、进度条和更新时间排序", async () => {
    const user = userEvent.setup();
    const target = makeEntry({
      id: "target",
      title: "即将看完",
      currentProgress: 1,
      totalProgress: 2,
      updatedAt: "2026-11-15T08:00:00.000Z",
    });
    const other = makeEntry({
      id: "other",
      title: "仍在追更",
      currentProgress: 4,
      totalProgress: 10,
      updatedAt: "2026-11-16T08:00:00.000Z",
    });
    const updated = makeEntry({
      ...target,
      currentProgress: 2,
      status: "completed",
      updatedAt: "2026-11-17T08:00:00.000Z",
    });
    mockedListEntries.mockResolvedValue([other, target]);
    mockedAdjustProgress.mockResolvedValue(updated);
    render(<App />);

    const targetCard = await screen.findByRole("article", {
      name: target.title,
    });
    await user.click(
      within(targetCard).getByRole("button", {
        name: `《${target.title}》进度加一`,
      }),
    );

    expect(mockedAdjustProgress).toHaveBeenCalledWith(target.id, 1);
    const updatedCard = screen.getByRole("article", { name: target.title });
    expect(within(updatedCard).getByText("2 / 2 集")).toBeInTheDocument();
    expect(within(updatedCard).getByText("100%")).toBeInTheDocument();
    expect(
      within(updatedCard).getByRole("progressbar"),
    ).toHaveAttribute("aria-valuenow", "100");
    expect(within(updatedCard).getByText("已完成")).toBeInTheDocument();
    expect(
      within(updatedCard).getByRole("button", {
        name: `重新追更《${target.title}》`,
      }),
    ).toBeInTheDocument();
    expect(
      within(updatedCard).getByRole("button", {
        name: `《${target.title}》进度加一`,
      }),
    ).toBeDisabled();
    expect(within(updatedCard).getByText(/^更新于 /)).toHaveAttribute(
      "dateTime",
      updated.updatedAt,
    );

    const list = screen.getByRole("list", { name: "追更内容列表" });
    expect(
      within(list)
        .getAllByRole("article")
        .map((article) => within(article).getByRole("heading").textContent),
    ).toEqual([target.title, other.title]);
    const summary = screen.getByRole("region", { name: "内容库摘要" });
    expect(summary).toHaveTextContent("正在追更1项在追");
    expect(summary).toHaveTextContent("已经看完1项完成");
  });

  it("减一使用后端结果恢复在追，保留对应进度", async () => {
    const user = userEvent.setup();
    const original = makeEntry({
      title: "看完后回退一步",
      currentProgress: 3,
      totalProgress: 3,
      status: "completed",
    });
    const updated = makeEntry({
      ...original,
      currentProgress: 2,
      status: "tracking",
      updatedAt: "2026-11-17T09:00:00.000Z",
    });
    mockedListEntries.mockResolvedValue([original]);
    mockedAdjustProgress.mockResolvedValue(updated);
    render(<App />);

    const card = await screen.findByRole("article", { name: original.title });
    await user.click(
      within(card).getByRole("button", {
        name: `《${original.title}》进度减一`,
      }),
    );

    expect(mockedAdjustProgress).toHaveBeenCalledWith(original.id, -1);
    expect(within(card).getByText("2 / 3 集")).toBeInTheDocument();
    expect(within(card).getByText("在追")).toBeInTheDocument();
    expect(
      within(card).getByRole("button", {
        name: `标记《${original.title}》完成`,
      }),
    ).toBeInTheDocument();
    expect(within(card).getByText(/^更新于 /)).toHaveAttribute(
      "dateTime",
      updated.updatedAt,
    );
  });

  it("在零和总进度处禁用对应按钮，未知总进度仍可加一且不显示百分比", async () => {
    const user = userEvent.setup();
    const zero = makeEntry({
      id: "zero",
      title: "尚未开始",
      currentProgress: 0,
      totalProgress: 2,
    });
    const full = makeEntry({
      id: "full",
      title: "已经到顶",
      currentProgress: 2,
      totalProgress: 2,
      status: "completed",
    });
    const unknown = makeEntry({
      id: "unknown",
      title: "连载作品",
      mediaType: "novel",
      currentProgress: 8,
      totalProgress: null,
    });
    const updatedUnknown = makeEntry({
      ...unknown,
      currentProgress: 23,
      updatedAt: "2026-11-17T10:00:00.000Z",
    });
    mockedListEntries.mockResolvedValue([zero, full, unknown]);
    mockedAdjustProgress.mockResolvedValue(updatedUnknown);
    render(<App />);

    const zeroCard = await screen.findByRole("article", { name: zero.title });
    const fullCard = screen.getByRole("article", { name: full.title });
    const unknownCard = screen.getByRole("article", { name: unknown.title });
    expect(
      within(zeroCard).getByRole("button", {
        name: `《${zero.title}》进度减一`,
      }),
    ).toBeDisabled();
    expect(
      within(zeroCard).getByRole("button", {
        name: `《${zero.title}》进度加一`,
      }),
    ).toBeEnabled();
    expect(
      within(fullCard).getByRole("button", {
        name: `《${full.title}》进度加一`,
      }),
    ).toBeDisabled();
    expect(
      within(fullCard).getByRole("button", {
        name: `《${full.title}》进度减一`,
      }),
    ).toBeEnabled();
    expect(within(unknownCard).queryByText(/%/)).toBeNull();

    await user.click(
      within(unknownCard).getByRole("button", {
        name: `《${unknown.title}》进度加一`,
      }),
    );

    expect(mockedAdjustProgress).toHaveBeenCalledWith(unknown.id, 1);
    expect(within(unknownCard).getByText("23 章")).toBeInTheDocument();
    expect(within(unknownCard).queryByText(/%/)).toBeNull();
    expect(
      within(unknownCard).getByRole("button", {
        name: `《${unknown.title}》进度加一`,
      }),
    ).toBeEnabled();
  });

  it("手动完成与重新追更均调用状态接口并保留后端返回的进度", async () => {
    const user = userEvent.setup();
    const original = makeEntry({
      title: "手动管理状态",
      currentProgress: 4,
      totalProgress: 10,
    });
    const completed = makeEntry({
      ...original,
      status: "completed",
      updatedAt: "2026-11-17T11:00:00.000Z",
    });
    const tracking = makeEntry({
      ...completed,
      status: "tracking",
      updatedAt: "2026-11-17T12:00:00.000Z",
    });
    mockedListEntries.mockResolvedValue([original]);
    mockedSetEntryStatus
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce(tracking);
    render(<App />);

    const card = await screen.findByRole("article", { name: original.title });
    await user.click(
      within(card).getByRole("button", {
        name: `标记《${original.title}》完成`,
      }),
    );

    expect(mockedSetEntryStatus).toHaveBeenNthCalledWith(
      1,
      original.id,
      "completed",
    );
    expect(within(card).getByText("4 / 10 集")).toBeInTheDocument();
    expect(within(card).getByText("已完成")).toBeInTheDocument();

    await user.click(
      within(card).getByRole("button", {
        name: `重新追更《${original.title}》`,
      }),
    );

    expect(mockedSetEntryStatus).toHaveBeenNthCalledWith(
      2,
      original.id,
      "tracking",
    );
    expect(within(card).getByText("4 / 10 集")).toBeInTheDocument();
    expect(within(card).getByText("在追")).toBeInTheDocument();
    expect(within(card).getByText(/^更新于 /)).toHaveAttribute(
      "dateTime",
      tracking.updatedAt,
    );
  });

  it("写入失败显示中文错误并保留原条目和摘要", async () => {
    const user = userEvent.setup();
    const original = makeEntry({ title: "更新失败的作品" });
    mockedListEntries.mockResolvedValue([original]);
    mockedAdjustProgress.mockRejectedValue(
      new Error("调整进度失败：database locked"),
    );
    render(<App />);

    const card = await screen.findByRole("article", { name: original.title });
    await user.click(
      within(card).getByRole("button", {
        name: `《${original.title}》进度加一`,
      }),
    );

    expect(await within(card).findByRole("alert")).toHaveTextContent(
      `更新《${original.title}》失败。调整进度失败：database locked`,
    );
    expect(within(card).getByText("3 / 12 集")).toBeInTheDocument();
    expect(within(card).getByText("25%")).toBeInTheDocument();
    expect(within(card).getByText("在追")).toBeInTheDocument();
    expect(within(card).getByText(/^更新于 /)).toHaveAttribute(
      "dateTime",
      original.updatedAt,
    );
    expect(
      within(card).getByRole("button", {
        name: `《${original.title}》进度加一`,
      }),
    ).toBeEnabled();
    const summary = screen.getByRole("region", { name: "内容库摘要" });
    expect(summary).toHaveTextContent("正在追更1项在追");
    expect(summary).toHaveTextContent("已经看完0项完成");
  });

  it("逐条目防止连点并禁用相关写操作，同时允许其他条目更新", async () => {
    const user = userEvent.setup();
    const first = makeEntry({
      id: "first",
      title: "慢请求条目",
      currentProgress: 1,
      totalProgress: null,
    });
    const second = makeEntry({
      id: "second",
      title: "可操作条目",
      currentProgress: 2,
      totalProgress: 10,
    });
    const pendingFirst = createDeferred<MediaEntry>();
    const updatedSecond = makeEntry({
      ...second,
      currentProgress: 3,
      updatedAt: "2026-11-17T13:00:00.000Z",
    });
    mockedListEntries.mockResolvedValue([first, second]);
    mockedAdjustProgress.mockImplementation((id) =>
      id === first.id
        ? pendingFirst.promise
        : Promise.resolve(updatedSecond),
    );
    render(<App />);

    const firstCard = await screen.findByRole("article", { name: first.title });
    const secondCard = screen.getByRole("article", { name: second.title });
    const firstIncrement = within(firstCard).getByRole("button", {
      name: `《${first.title}》进度加一`,
    });
    await user.click(firstIncrement);

    expect(
      within(firstCard).getByRole("status"),
    ).toHaveTextContent(`正在更新《${first.title}》`);
    expect(firstIncrement).toBeDisabled();
    expect(
      within(firstCard).getByRole("button", {
        name: `《${first.title}》进度减一`,
      }),
    ).toBeDisabled();
    expect(
      within(firstCard).getByRole("button", {
        name: `标记《${first.title}》完成`,
      }),
    ).toBeDisabled();
    expect(
      within(firstCard).getByRole("button", {
        name: `编辑《${first.title}》`,
      }),
    ).toBeDisabled();
    expect(
      within(firstCard).getByRole("button", {
        name: `删除《${first.title}》`,
      }),
    ).toBeDisabled();

    await user.click(firstIncrement);
    const secondIncrement = within(secondCard).getByRole("button", {
      name: `《${second.title}》进度加一`,
    });
    expect(secondIncrement).toBeEnabled();
    await user.click(secondIncrement);
    expect(await within(secondCard).findByText("3 / 10 集")).toBeInTheDocument();

    await act(async () => {
      pendingFirst.resolve(
        makeEntry({
          ...first,
          currentProgress: 2,
          updatedAt: "2026-11-17T14:00:00.000Z",
        }),
      );
      await pendingFirst.promise;
    });

    expect(await within(firstCard).findByText("2 集")).toBeInTheDocument();
    expect(within(firstCard).queryByRole("status")).toBeNull();
    expect(
      mockedAdjustProgress.mock.calls.filter(([id]) => id === first.id),
    ).toHaveLength(1);
    expect(mockedAdjustProgress).toHaveBeenCalledWith(second.id, 1);
  });
});

describe("搜索与筛选", () => {
  function expectVisibleTitles(titles: string[]) {
    const list = screen.getByRole("list", { name: "追更内容列表" });
    expect(
      within(list)
        .getAllByRole("article")
        .map((article) => within(article).getByRole("heading").textContent),
    ).toEqual(titles);
  }

  it("标题搜索忽略大小写和首尾空白，并匹配实际标题", async () => {
    const user = userEvent.setup();
    const entries = [
      makeEntry({ id: "english", title: "The Last of Us" }),
      makeEntry({ id: "similar", title: "The Last Story" }),
      makeEntry({ id: "chinese", title: "最后生还者" }),
    ];
    mockedListEntries.mockResolvedValue(entries);
    render(<App />);

    await screen.findByRole("article", { name: "The Last of Us" });
    const search = screen.getByLabelText("搜索标题");
    expect(search).toHaveValue("");
    expect(screen.getByLabelText("类型筛选")).toHaveValue("all");
    expect(screen.getByLabelText("状态筛选")).toHaveValue("all");

    await user.type(search, "   ");
    expectVisibleTitles(entries.map((entry) => entry.title));

    await user.type(search, "tHe LaSt oF  ");
    expectVisibleTitles(["The Last of Us"]);
    expect(screen.queryByRole("article", { name: "The Last Story" })).toBeNull();
    expect(screen.queryByRole("article", { name: "最后生还者" })).toBeNull();
  });

  it("类型和状态可分别筛选，有结果时可一键清除全部条件", async () => {
    const user = userEvent.setup();
    const entries = [
      makeEntry({ id: "drama", title: "剧集故事", mediaType: "drama" }),
      makeEntry({
        id: "anime",
        title: "番剧故事",
        mediaType: "anime",
        status: "completed",
      }),
      makeEntry({ id: "novel", title: "小说故事", mediaType: "novel" }),
      makeEntry({
        id: "movie",
        title: "电影故事",
        mediaType: "movie",
        status: "completed",
      }),
    ];
    mockedListEntries.mockResolvedValue(entries);
    render(<App />);

    await screen.findByRole("article", { name: "剧集故事" });
    await user.selectOptions(screen.getByLabelText("类型筛选"), "anime");
    expectVisibleTitles(["番剧故事"]);
    expect(screen.getByLabelText("状态筛选")).toHaveValue("all");

    await user.click(
      screen.getByRole("button", { name: "清除搜索和筛选" }),
    );
    expectVisibleTitles(entries.map((entry) => entry.title));
    expect(screen.getByLabelText("类型筛选")).toHaveValue("all");

    await user.selectOptions(screen.getByLabelText("状态筛选"), "completed");
    expectVisibleTitles(["番剧故事", "电影故事"]);
    expect(screen.getByLabelText("类型筛选")).toHaveValue("all");

    await user.click(
      screen.getByRole("button", { name: "清除搜索和筛选" }),
    );
    expectVisibleTitles(entries.map((entry) => entry.title));
    expect(screen.getByLabelText("状态筛选")).toHaveValue("all");
  });

  it("组合条件无结果时显示独立状态，保留整体摘要并可一键恢复", async () => {
    const user = userEvent.setup();
    const entries = [
      makeEntry({
        id: "three-body",
        title: "三体",
        mediaType: "novel",
        status: "completed",
      }),
      makeEntry({
        id: "season",
        title: "漫长的季节",
        mediaType: "drama",
        status: "completed",
      }),
      makeEntry({ id: "lightning", title: "球状闪电", mediaType: "novel" }),
    ];
    mockedListEntries.mockResolvedValue(entries);
    render(<App />);

    await screen.findByRole("article", { name: "三体" });
    await user.selectOptions(screen.getByLabelText("类型筛选"), "novel");
    await user.selectOptions(screen.getByLabelText("状态筛选"), "completed");
    expectVisibleTitles(["三体"]);

    await user.type(screen.getByLabelText("搜索标题"), "  没有这部作品  ");
    expect(
      screen.getByRole("heading", { name: "没有找到匹配的条目" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "内容库还是空的" })).toBeNull();
    expect(screen.queryByRole("list", { name: "追更内容列表" })).toBeNull();
    const summary = screen.getByRole("region", { name: "内容库摘要" });
    expect(summary).toHaveTextContent("条目总数3项");
    expect(summary).toHaveTextContent("正在追更1项在追");
    expect(summary).toHaveTextContent("已经看完2项完成");

    await user.click(
      screen.getByRole("button", { name: "清除搜索和筛选" }),
    );
    expectVisibleTitles(entries.map((entry) => entry.title));
    expect(screen.getByLabelText("搜索标题")).toHaveValue("");
    expect(screen.getByLabelText("类型筛选")).toHaveValue("all");
    expect(screen.getByLabelText("状态筛选")).toHaveValue("all");
    expect(screen.queryByRole("heading", { name: "没有找到匹配的条目" })).toBeNull();
  });

  it("快捷进度更新后继续应用当前筛选并按 updatedAt 倒序", async () => {
    const user = userEvent.setup();
    const target = makeEntry({
      id: "target",
      title: "共同故事一",
      currentProgress: 1,
      totalProgress: 2,
      updatedAt: "2026-11-14T08:00:00.000Z",
    });
    const other = makeEntry({
      id: "other",
      title: "共同故事二",
      currentProgress: 4,
      totalProgress: 10,
      updatedAt: "2026-11-16T08:00:00.000Z",
    });
    const completed = makeEntry({
      id: "completed",
      title: "其他故事",
      status: "completed",
      updatedAt: "2026-11-15T08:00:00.000Z",
    });
    const updatedTarget = makeEntry({
      ...target,
      currentProgress: 2,
      status: "completed",
      updatedAt: "2026-11-17T08:00:00.000Z",
    });
    mockedListEntries.mockResolvedValue([other, completed, target]);
    mockedAdjustProgress.mockResolvedValue(updatedTarget);
    render(<App />);

    const targetCard = await screen.findByRole("article", {
      name: target.title,
    });
    await user.type(screen.getByLabelText("搜索标题"), "  故事  ");
    await user.selectOptions(screen.getByLabelText("状态筛选"), "tracking");
    expectVisibleTitles([other.title, target.title]);

    await user.click(
      within(targetCard).getByRole("button", {
        name: `《${target.title}》进度加一`,
      }),
    );

    expectVisibleTitles([other.title]);
    expect(screen.getByLabelText("搜索标题")).toHaveValue("  故事  ");
    expect(screen.getByLabelText("状态筛选")).toHaveValue("tracking");
    const summary = screen.getByRole("region", { name: "内容库摘要" });
    expect(summary).toHaveTextContent("条目总数3项");
    expect(summary).toHaveTextContent("正在追更1项在追");
    expect(summary).toHaveTextContent("已经看完2项完成");

    await user.selectOptions(screen.getByLabelText("状态筛选"), "all");
    expectVisibleTitles([target.title, other.title, completed.title]);
  });
});

describe("条目管理", () => {
  it("空态可打开新增对话框，初始聚焦标题并在 Escape 关闭后返回焦点", async () => {
    const user = userEvent.setup();
    mockedListEntries.mockResolvedValue([]);
    render(<App />);

    const emptyAddButton = await screen.findByRole("button", {
      name: "添加第一个条目",
    });
    expect(screen.getByRole("button", { name: "添加条目" })).toBeVisible();

    await user.click(emptyAddButton);

    expect(
      screen.getByRole("dialog", { name: "添加条目" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("标题")).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(emptyAddButton).toHaveFocus();
  });

  it("新增成功后使用后端条目更新列表和摘要，并防止重复提交与处理中关闭", async () => {
    const user = userEvent.setup();
    const existing = makeEntry({
      id: "existing",
      title: "已有条目",
      updatedAt: "2026-11-16T01:30:00.000Z",
    });
    const created = makeEntry({
      id: "created",
      title: "来自后端的新条目",
      mediaType: "novel",
      currentProgress: 8,
      totalProgress: null,
      status: "completed",
      createdAt: "2026-11-17T03:00:00.000Z",
      updatedAt: "2026-11-17T03:00:00.000Z",
    });
    const pendingCreate = createDeferred<MediaEntry>();
    mockedListEntries.mockResolvedValue([existing]);
    mockedCreateEntry.mockReturnValue(pendingCreate.promise);
    render(<App />);

    await screen.findByRole("article", { name: existing.title });
    await user.click(screen.getByRole("button", { name: "添加条目" }));
    const dialog = screen.getByRole("dialog", { name: "添加条目" });
    const title = within(dialog).getByLabelText("标题");
    await user.type(title, "  来自后端的新条目  ");
    await user.selectOptions(within(dialog).getByLabelText("类型"), "novel");
    const currentProgress = within(dialog).getByLabelText("当前进度（章）");
    await user.clear(currentProgress);
    await user.type(currentProgress, "8");
    await user.selectOptions(within(dialog).getByLabelText("状态"), "completed");

    await user.click(within(dialog).getByRole("button", { name: "添加条目" }));

    const savingButton = within(dialog).getByRole("button", {
      name: "保存中…",
    });
    expect(savingButton).toBeDisabled();
    expect(title).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "关闭对话框" }),
    ).toBeDisabled();
    await user.click(savingButton);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "添加条目" })).toBeVisible();
    expect(mockedCreateEntry).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingCreate.resolve(created);
      await pendingCreate.promise;
    });

    expect(
      await screen.findByRole("article", { name: created.title }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockedCreateEntry).toHaveBeenCalledWith({
      title: created.title,
      mediaType: "novel",
      currentProgress: 8,
      totalProgress: null,
      status: "completed",
    });
    const summary = screen.getByRole("region", { name: "内容库摘要" });
    expect(summary).toHaveTextContent("条目总数2项");
    expect(summary).toHaveTextContent("正在追更1项在追");
    expect(summary).toHaveTextContent("已经看完1项完成");
  });

  it("编辑时回填全部字段，成功后按 updatedAt 重排并同步摘要", async () => {
    const user = userEvent.setup();
    const target = makeEntry({
      id: "target",
      title: "待编辑小说",
      mediaType: "novel",
      currentProgress: 8,
      totalProgress: null,
      status: "tracking",
      updatedAt: "2026-11-15T08:00:00.000Z",
    });
    const other = makeEntry({
      id: "other",
      title: "其他条目",
      updatedAt: "2026-11-16T08:00:00.000Z",
    });
    const updated = makeEntry({
      ...target,
      title: "编辑后的剧集",
      mediaType: "drama",
      currentProgress: 4,
      totalProgress: 10,
      status: "completed",
      updatedAt: "2026-11-17T08:00:00.000Z",
    });
    mockedListEntries.mockResolvedValue([other, target]);
    mockedUpdateEntry.mockResolvedValue(updated);
    render(<App />);

    await screen.findByRole("article", { name: target.title });
    await user.click(
      screen.getByRole("button", { name: `编辑《${target.title}》` }),
    );
    const dialog = screen.getByRole("dialog", { name: "编辑条目" });
    expect(within(dialog).getByLabelText("标题")).toHaveValue(target.title);
    expect(within(dialog).getByLabelText("类型")).toHaveValue("novel");
    expect(within(dialog).getByLabelText("当前进度（章）")).toHaveValue(8);
    expect(
      within(dialog).getByLabelText("总进度（章，选填）"),
    ).toHaveDisplayValue("");
    expect(within(dialog).getByLabelText("状态")).toHaveValue("tracking");

    const title = within(dialog).getByLabelText("标题");
    await user.clear(title);
    await user.type(title, "  编辑后的剧集  ");
    await user.selectOptions(within(dialog).getByLabelText("类型"), "drama");
    const currentProgress = within(dialog).getByLabelText("当前进度（集）");
    await user.clear(currentProgress);
    await user.type(currentProgress, "4");
    await user.type(within(dialog).getByLabelText("总进度（集，选填）"), "10");
    await user.selectOptions(within(dialog).getByLabelText("状态"), "completed");
    await user.click(within(dialog).getByRole("button", { name: "保存修改" }));

    expect(
      await screen.findByRole("article", { name: updated.title }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockedUpdateEntry).toHaveBeenCalledWith(target.id, {
      title: updated.title,
      mediaType: "drama",
      currentProgress: 4,
      totalProgress: 10,
      status: "completed",
    });
    const list = screen.getByRole("list", { name: "追更内容列表" });
    const articles = within(list).getAllByRole("article");
    expect(
      articles.map((article) => within(article).getByRole("heading").textContent),
    ).toEqual([updated.title, other.title]);
    const summary = screen.getByRole("region", { name: "内容库摘要" });
    expect(summary).toHaveTextContent("正在追更1项在追");
    expect(summary).toHaveTextContent("已经看完1项完成");
    expect(
      screen.getByRole("button", { name: `编辑《${updated.title}》` }),
    ).toHaveFocus();
  });

  it("逐字段校验空标题、非法整数和进度边界并关联错误说明", async () => {
    const user = userEvent.setup();
    mockedListEntries.mockResolvedValue([]);
    render(<App />);

    await screen.findByRole("heading", { name: "内容库还是空的" });
    await user.click(screen.getByRole("button", { name: "添加条目" }));
    const dialog = screen.getByRole("dialog", { name: "添加条目" });
    const title = within(dialog).getByLabelText("标题");
    const currentProgress = within(dialog).getByLabelText("当前进度（集）");
    const totalProgress = within(dialog).getByLabelText("总进度（集，选填）");
    const submit = within(dialog).getByRole("button", { name: "添加条目" });
    await user.type(title, "   ");
    await user.clear(currentProgress);
    await user.type(currentProgress, "-1");
    await user.type(totalProgress, "0");
    await user.click(submit);

    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(title).toHaveAccessibleDescription("请输入标题。");
    expect(title).toHaveFocus();
    expect(currentProgress).toHaveAttribute("aria-invalid", "true");
    expect(currentProgress).toHaveAccessibleDescription(
      "当前进度必须是非负整数。",
    );
    expect(totalProgress).toHaveAttribute("aria-invalid", "true");
    expect(totalProgress).toHaveAccessibleDescription(/总进度必须为空或正整数。/);

    await user.clear(title);
    await user.type(title, "合法标题");
    await user.clear(currentProgress);
    await user.type(currentProgress, "1.5");
    await user.clear(totalProgress);
    await user.type(totalProgress, "10.5");
    await user.click(submit);
    expect(currentProgress).toHaveAccessibleDescription(
      "当前进度必须是非负整数。",
    );
    expect(totalProgress).toHaveAccessibleDescription(/总进度必须为空或正整数。/);

    await user.clear(currentProgress);
    await user.type(currentProgress, "11");
    await user.clear(totalProgress);
    await user.type(totalProgress, "10");
    await user.click(submit);
    expect(currentProgress).toHaveAccessibleDescription(
      "当前进度不能大于总进度。",
    );
    expect(mockedCreateEntry).not.toHaveBeenCalled();
  });

  it("选择电影时为空总进度默认填 1，并随类型展示正确单位", async () => {
    const user = userEvent.setup();
    mockedListEntries.mockResolvedValue([]);
    render(<App />);

    await screen.findByRole("heading", { name: "内容库还是空的" });
    await user.click(screen.getByRole("button", { name: "添加条目" }));
    const dialog = screen.getByRole("dialog", { name: "添加条目" });
    await user.selectOptions(within(dialog).getByLabelText("类型"), "movie");

    expect(
      within(dialog).getByLabelText("总进度（部，选填）"),
    ).toHaveDisplayValue("1");
    expect(
      within(dialog).getByLabelText("当前进度（部）"),
    ).toBeInTheDocument();

    await user.selectOptions(within(dialog).getByLabelText("类型"), "novel");
    const totalProgress = within(dialog).getByLabelText("总进度（章，选填）");
    await user.clear(totalProgress);
    expect(totalProgress).toHaveDisplayValue("");
  });

  it("后端保存失败时在表单内显示写入错误并保留全部输入", async () => {
    const user = userEvent.setup();
    const existing = makeEntry({ title: "已有条目" });
    mockedListEntries.mockResolvedValue([existing]);
    mockedCreateEntry.mockRejectedValue(
      new Error("创建追更条目失败：database locked"),
    );
    render(<App />);

    await screen.findByRole("article", { name: existing.title });
    await user.click(screen.getByRole("button", { name: "添加条目" }));
    const dialog = screen.getByRole("dialog", { name: "添加条目" });
    await user.type(within(dialog).getByLabelText("标题"), "保留这些输入");
    await user.selectOptions(within(dialog).getByLabelText("类型"), "anime");
    const currentProgress = within(dialog).getByLabelText("当前进度（集）");
    await user.clear(currentProgress);
    await user.type(currentProgress, "2");
    await user.type(within(dialog).getByLabelText("总进度（集，选填）"), "10");
    await user.selectOptions(within(dialog).getByLabelText("状态"), "completed");
    await user.click(within(dialog).getByRole("button", { name: "添加条目" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "创建追更条目失败：database locked",
    );
    expect(within(dialog).getByLabelText("标题")).toHaveValue("保留这些输入");
    expect(within(dialog).getByLabelText("类型")).toHaveValue("anime");
    expect(currentProgress).toHaveValue(2);
    expect(within(dialog).getByLabelText("总进度（集，选填）")).toHaveValue(10);
    expect(within(dialog).getByLabelText("状态")).toHaveValue("completed");
    expect(screen.getByRole("dialog", { name: "添加条目" })).toBeVisible();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.queryByText(/本地内容库暂时无法读取/)).toBeNull();
  });

  it("删除需确认，取消不改数据，成功后同步摘要并防止重复删除", async () => {
    const user = userEvent.setup();
    const target = makeEntry({ id: "target", title: "准备删除" });
    const other = makeEntry({
      id: "other",
      title: "保留条目",
      status: "completed",
    });
    const pendingDelete = createDeferred<void>();
    mockedListEntries.mockResolvedValue([target, other]);
    mockedDeleteEntry.mockReturnValue(pendingDelete.promise);
    render(<App />);

    await screen.findByRole("article", { name: target.title });
    const deleteButton = screen.getByRole("button", {
      name: `删除《${target.title}》`,
    });
    await user.click(deleteButton);
    let dialog = screen.getByRole("dialog", { name: "删除条目" });
    expect(within(dialog).getByText(`《${target.title}》`)).toBeVisible();
    const cancelButton = within(dialog).getByRole("button", { name: "取消" });
    expect(cancelButton).toHaveFocus();
    await user.click(cancelButton);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("article", { name: target.title })).toBeVisible();
    expect(mockedDeleteEntry).not.toHaveBeenCalled();
    expect(deleteButton).toHaveFocus();

    await user.click(deleteButton);
    dialog = screen.getByRole("dialog", { name: "删除条目" });
    await user.click(within(dialog).getByRole("button", { name: "确认删除" }));
    const deletingButton = within(dialog).getByRole("button", {
      name: "删除中…",
    });
    expect(deletingButton).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "关闭对话框" }),
    ).toBeDisabled();
    await user.click(deletingButton);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "删除条目" })).toBeVisible();
    expect(mockedDeleteEntry).toHaveBeenCalledTimes(1);
    expect(mockedDeleteEntry).toHaveBeenCalledWith(target.id);

    await act(async () => {
      pendingDelete.resolve(undefined);
      await pendingDelete.promise;
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("article", { name: target.title })).toBeNull();
    expect(screen.getByRole("article", { name: other.title })).toBeVisible();
    const summary = screen.getByRole("region", { name: "内容库摘要" });
    expect(summary).toHaveTextContent("条目总数1项");
    expect(summary).toHaveTextContent("正在追更0项在追");
    expect(summary).toHaveTextContent("已经看完1项完成");
    expect(screen.getByRole("button", { name: "添加条目" })).toHaveFocus();
  });

  it("删除失败时保留对话框和条目，并允许取消", async () => {
    const user = userEvent.setup();
    const target = makeEntry({ title: "不能丢失的条目" });
    mockedListEntries.mockResolvedValue([target]);
    mockedDeleteEntry.mockRejectedValue("删除追更条目失败：database locked");
    render(<App />);

    await screen.findByRole("article", { name: target.title });
    await user.click(
      screen.getByRole("button", { name: `删除《${target.title}》` }),
    );
    const dialog = screen.getByRole("dialog", { name: "删除条目" });
    await user.click(within(dialog).getByRole("button", { name: "确认删除" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "删除追更条目失败：database locked",
    );
    expect(screen.getByRole("article", { name: target.title })).toBeVisible();
    expect(mockedDeleteEntry).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("article", { name: target.title })).toBeVisible();
  });
});
