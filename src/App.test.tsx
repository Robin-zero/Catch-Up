import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adjustProgress,
  createEntry,
  deleteEntry,
  emptyTrash,
  getSettings,
  importMarkdown,
  listEntries,
  listTrash,
  purgeEntry,
  restoreEntry,
  saveSettings,
  searchTmdb,
  setEntryStatus,
  syncNow,
  updateEntry,
} from "./api";
import App from "./App";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ImportReport,
  type MediaEntry,
  type MediaType,
  type ScrapeCandidate,
  type SyncReport,
} from "./types";

vi.mock("./api", () => ({
  listEntries: vi.fn(),
  listTrash: vi.fn(),
  createEntry: vi.fn(),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn(),
  restoreEntry: vi.fn(),
  purgeEntry: vi.fn(),
  emptyTrash: vi.fn(),
  importMarkdown: vi.fn(),
  adjustProgress: vi.fn(),
  setEntryStatus: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  searchTmdb: vi.fn(),
  syncNow: vi.fn(),
  getLibraryErrorMessage: vi.fn(
    () => "本地内容库暂时无法读取，请检查应用状态后重试。",
  ),
}));

const mockedListEntries = vi.mocked(listEntries);
const mockedListTrash = vi.mocked(listTrash);
const mockedCreateEntry = vi.mocked(createEntry);
const mockedUpdateEntry = vi.mocked(updateEntry);
const mockedDeleteEntry = vi.mocked(deleteEntry);
const mockedRestoreEntry = vi.mocked(restoreEntry);
const mockedPurgeEntry = vi.mocked(purgeEntry);
const mockedEmptyTrash = vi.mocked(emptyTrash);
const mockedImportMarkdown = vi.mocked(importMarkdown);
const mockedAdjustProgress = vi.mocked(adjustProgress);
const mockedSetEntryStatus = vi.mocked(setEntryStatus);
const mockedGetSettings = vi.mocked(getSettings);
const mockedSaveSettings = vi.mocked(saveSettings);
const mockedSearchTmdb = vi.mocked(searchTmdb);
const mockedSyncNow = vi.mocked(syncNow);

function makeSyncReport(overrides: Partial<SyncReport> = {}): SyncReport {
  return {
    merged: 0,
    uploaded: 0,
    downloaded: 0,
    lastSyncedAt: "2026-11-20T04:05:06.000000000Z",
    ...overrides,
  };
}

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
  mockedListTrash.mockReset();
  mockedListTrash.mockResolvedValue([]);
  mockedCreateEntry.mockReset();
  mockedUpdateEntry.mockReset();
  mockedDeleteEntry.mockReset();
  mockedRestoreEntry.mockReset();
  mockedPurgeEntry.mockReset();
  mockedEmptyTrash.mockReset();
  mockedImportMarkdown.mockReset();
  mockedAdjustProgress.mockReset();
  mockedSetEntryStatus.mockReset();
  mockedGetSettings.mockReset();
  mockedGetSettings.mockResolvedValue({ ...DEFAULT_SETTINGS });
  mockedSaveSettings.mockReset();
  mockedSearchTmdb.mockReset();
  mockedSyncNow.mockReset();
  mockedSyncNow.mockResolvedValue(makeSyncReport());
});

describe("内容库", () => {
  it("启动时显示明确的加载状态", () => {
    mockedListEntries.mockReturnValue(new Promise(() => {}));
    mockedListTrash.mockReturnValue(new Promise(() => {}));
    mockedGetSettings.mockReturnValue(new Promise(() => {}));

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
      season: null,
      rating: null,
      platform: null,
      coverUrl: null,
      overview: null,
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
      season: null,
      rating: null,
      platform: null,
      coverUrl: null,
      overview: null,
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

describe("回收站", () => {
  it("从侧边栏进入回收站，显示数量与操作，并隐藏新增按钮和状态筛选", async () => {
    const user = userEvent.setup();
    const trashed = makeEntry({ id: "trash-1", title: "回收的剧" });
    mockedListEntries.mockResolvedValue([makeEntry({ title: "库里的剧" })]);
    mockedListTrash.mockResolvedValue([trashed]);

    render(<App />);

    await screen.findByRole("article", { name: "库里的剧" });
    const sidebar = screen.getByRole("complementary", { name: "侧边栏" });
    await user.click(
      within(sidebar).getByRole("button", { name: /回收站/ }),
    );

    expect(
      await screen.findByRole("heading", { name: "回收站" }),
    ).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "回收站列表" });
    expect(
      within(list).getByRole("article", { name: "回收的剧" }),
    ).toBeVisible();
    expect(
      within(sidebar).getByRole("button", { name: /回收站/ }),
    ).toHaveTextContent("1");
    expect(
      screen.getByText("回收站中的条目会在 30 天后自动清除"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("类型筛选")).toBeInTheDocument();
    expect(screen.queryByLabelText("状态筛选")).toBeNull();
    expect(screen.queryByRole("button", { name: "添加条目" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "回收站" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "清空回收站" }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "恢复《回收的剧》" }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "彻底删除《回收的剧》" }),
    ).toBeInTheDocument();
  });

  it("恢复条目后从回收站移除，并按更新时间回到主库", async () => {
    const user = userEvent.setup();
    const older = makeEntry({
      id: "older",
      title: "较早的剧",
      updatedAt: "2026-11-10T01:30:00.000Z",
    });
    const restored = makeEntry({
      id: "restore-1",
      title: "恢复的剧",
      updatedAt: "2026-11-19T01:30:00.000Z",
    });
    mockedListEntries.mockResolvedValue([older]);
    mockedListTrash.mockResolvedValue([restored]);
    mockedRestoreEntry.mockResolvedValue(restored);

    render(<App />);

    await screen.findByRole("article", { name: "较早的剧" });
    const sidebar = screen.getByRole("complementary", { name: "侧边栏" });
    await user.click(
      within(sidebar).getByRole("button", { name: /回收站/ }),
    );
    const list = await screen.findByRole("list", { name: "回收站列表" });
    await user.click(
      within(list).getByRole("button", { name: "恢复《恢复的剧》" }),
    );

    expect(mockedRestoreEntry).toHaveBeenCalledWith("restore-1");
    expect(
      await screen.findByRole("heading", { name: "回收站是空的" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "回收站列表" })).toBeNull();
    expect(
      within(sidebar).getByRole("button", { name: /回收站/ }),
    ).toHaveTextContent("0");

    await user.click(
      within(sidebar).getByRole("button", { name: /全部条目/ }),
    );
    const libraryList = await screen.findByRole("list", {
      name: "追更内容列表",
    });
    const articles = within(libraryList).getAllByRole("article");
    expect(articles).toHaveLength(2);
    expect(articles[0]).toHaveTextContent("恢复的剧");
    expect(articles[1]).toHaveTextContent("较早的剧");
  });

  it("彻底删除需要二次确认，取消后条目和数据保持不变", async () => {
    const user = userEvent.setup();
    const trashed = makeEntry({ id: "purge-1", title: "要删的剧" });
    mockedListEntries.mockResolvedValue([]);
    mockedListTrash.mockResolvedValue([trashed]);

    render(<App />);

    const sidebar = screen.getByRole("complementary", { name: "侧边栏" });
    await user.click(
      within(sidebar).getByRole("button", { name: /回收站/ }),
    );
    const list = await screen.findByRole("list", { name: "回收站列表" });
    await user.click(
      within(list).getByRole("button", { name: "彻底删除《要删的剧》" }),
    );

    const dialog = screen.getByRole("dialog", { name: "彻底删除条目" });
    expect(dialog).toHaveTextContent("删除后将无法恢复");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockedPurgeEntry).not.toHaveBeenCalled();
    expect(
      screen.getByRole("article", { name: "要删的剧" }),
    ).toBeVisible();
  });

  it("确认彻底删除后从列表和侧边栏计数中移除", async () => {
    const user = userEvent.setup();
    const target = makeEntry({ id: "purge-2", title: "确认删除的剧" });
    const keep = makeEntry({ id: "keep-1", title: "保留的剧" });
    mockedListEntries.mockResolvedValue([]);
    mockedListTrash.mockResolvedValue([target, keep]);
    mockedPurgeEntry.mockResolvedValue(undefined);

    render(<App />);

    const sidebar = screen.getByRole("complementary", { name: "侧边栏" });
    await user.click(
      within(sidebar).getByRole("button", { name: /回收站/ }),
    );
    const list = await screen.findByRole("list", { name: "回收站列表" });
    await user.click(
      within(list).getByRole("button", { name: "彻底删除《确认删除的剧》" }),
    );
    const dialog = screen.getByRole("dialog", { name: "彻底删除条目" });
    await user.click(
      within(dialog).getByRole("button", { name: "彻底删除" }),
    );

    expect(mockedPurgeEntry).toHaveBeenCalledWith("purge-2");
    expect(
      await screen.findByRole("article", { name: "保留的剧" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("article", { name: "确认删除的剧" }),
    ).toBeNull();
    expect(
      within(sidebar).getByRole("button", { name: /回收站/ }),
    ).toHaveTextContent("1");
  });

  it("清空回收站需要确认，确认后显示空态与 30 天提示", async () => {
    const user = userEvent.setup();
    mockedListEntries.mockResolvedValue([]);
    mockedListTrash.mockResolvedValue([
      makeEntry({ id: "empty-1", title: "第一条" }),
      makeEntry({ id: "empty-2", title: "第二条" }),
    ]);
    mockedEmptyTrash.mockResolvedValue(undefined);

    render(<App />);

    const sidebar = screen.getByRole("complementary", { name: "侧边栏" });
    await user.click(
      within(sidebar).getByRole("button", { name: /回收站/ }),
    );
    await screen.findByRole("list", { name: "回收站列表" });
    await user.click(screen.getByRole("button", { name: "清空回收站" }));

    const dialog = screen.getByRole("dialog", { name: "清空回收站" });
    expect(dialog).toHaveTextContent("2 个条目");
    await user.click(
      within(dialog).getByRole("button", { name: "清空回收站" }),
    );

    expect(mockedEmptyTrash).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("heading", { name: "回收站是空的" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("回收站中的条目会在 30 天后自动清除"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "回收站列表" })).toBeNull();
    expect(
      within(sidebar).getByRole("button", { name: /回收站/ }),
    ).toHaveTextContent("0");
  });

  it("取消清空回收站不会删除任何条目", async () => {
    const user = userEvent.setup();
    mockedListEntries.mockResolvedValue([]);
    mockedListTrash.mockResolvedValue([
      makeEntry({ id: "cancel-1", title: "不会消失的条目" }),
    ]);

    render(<App />);

    const sidebar = screen.getByRole("complementary", { name: "侧边栏" });
    await user.click(
      within(sidebar).getByRole("button", { name: /回收站/ }),
    );
    await screen.findByRole("list", { name: "回收站列表" });
    await user.click(screen.getByRole("button", { name: "清空回收站" }));
    const dialog = screen.getByRole("dialog", { name: "清空回收站" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(mockedEmptyTrash).not.toHaveBeenCalled();
    expect(
      screen.getByRole("article", { name: "不会消失的条目" }),
    ).toBeVisible();
  });

  it("回收站为空时显示空态、30 天提示，清空按钮禁用", async () => {
    const user = userEvent.setup();
    mockedListEntries.mockResolvedValue([]);
    mockedListTrash.mockResolvedValue([]);

    render(<App />);

    const sidebar = screen.getByRole("complementary", { name: "侧边栏" });
    await user.click(
      within(sidebar).getByRole("button", { name: /回收站/ }),
    );

    expect(
      await screen.findByRole("heading", { name: "回收站是空的" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("回收站中的条目会在 30 天后自动清除"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清空回收站" })).toBeDisabled();
    expect(
      within(sidebar).getByRole("button", { name: /回收站/ }),
    ).toHaveTextContent("0");
  });

  it("回收站忽略主库状态筛选，并支持标题搜索与类型筛选", async () => {
    const user = userEvent.setup();
    mockedListEntries.mockResolvedValue([
      makeEntry({ id: "lib-tracking", title: "在追的剧", status: "tracking" }),
      makeEntry({
        id: "lib-completed",
        title: "看完的剧",
        status: "completed",
      }),
    ]);
    const trashedDrama = makeEntry({
      id: "trash-drama",
      title: "回收的剧集",
      mediaType: "drama",
      status: "tracking",
    });
    const trashedNovel = makeEntry({
      id: "trash-novel",
      title: "回收的小说",
      mediaType: "novel",
      status: "completed",
    });
    mockedListTrash.mockResolvedValue([trashedDrama, trashedNovel]);

    render(<App />);

    await screen.findByRole("article", { name: "在追的剧" });
    await user.selectOptions(screen.getByLabelText("状态筛选"), "completed");
    const sidebar = screen.getByRole("complementary", { name: "侧边栏" });
    await user.click(
      within(sidebar).getByRole("button", { name: /回收站/ }),
    );
    const list = await screen.findByRole("list", { name: "回收站列表" });
    expect(
      within(list).getByRole("article", { name: "回收的剧集" }),
    ).toBeVisible();
    expect(
      within(list).getByRole("article", { name: "回收的小说" }),
    ).toBeVisible();

    await user.selectOptions(screen.getByLabelText("类型筛选"), "novel");
    expect(
      screen.queryByRole("article", { name: "回收的剧集" }),
    ).toBeNull();
    expect(
      screen.getByRole("article", { name: "回收的小说" }),
    ).toBeVisible();

    await user.type(screen.getByLabelText("搜索标题"), "小说");
    expect(
      screen.getByRole("article", { name: "回收的小说" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("article", { name: "回收的剧集" }),
    ).toBeNull();
  });
});

describe("短剧与条目元数据", () => {
  it("短剧使用“短剧”标签和“集”单位，并出现在侧边栏与类型筛选中", async () => {
    const user = userEvent.setup();
    const shortDrama = makeEntry({
      id: "short-drama",
      title: "闪婚之后",
      mediaType: "short_drama",
      currentProgress: 3,
      totalProgress: 10,
    });
    mockedListEntries.mockResolvedValue([shortDrama]);

    render(<App />);

    const card = await screen.findByRole("article", {
      name: shortDrama.title,
    });
    expect(within(card).getByText("短剧")).toBeInTheDocument();
    expect(within(card).getByText("3 / 10 集")).toBeInTheDocument();
    expect(within(card).getByText("30%")).toBeInTheDocument();

    const sidebar = screen.getByRole("complementary", { name: "侧边栏" });
    expect(
      within(sidebar).getByRole("button", { name: /短剧/ }),
    ).toHaveTextContent("1");

    await user.selectOptions(
      screen.getByLabelText("类型筛选"),
      "short_drama",
    );
    expect(screen.getByRole("article", { name: shortDrama.title })).toBeVisible();
  });

  it("条目卡片展示季、评分与平台标签，并保留类型与更新时间", async () => {
    mockedListEntries.mockResolvedValue([
      makeEntry({
        title: "漫长的季节",
        season: 2,
        rating: 8.6,
        platform: "腾讯视频",
      }),
    ]);

    render(<App />);

    const card = await screen.findByRole("article", {
      name: "漫长的季节",
    });
    expect(within(card).getByText("剧集")).toBeInTheDocument();
    expect(within(card).getByText("第 2 季")).toBeInTheDocument();
    expect(within(card).getByText("★ 8.6")).toBeInTheDocument();
    expect(within(card).getByText("腾讯视频")).toBeInTheDocument();
    expect(within(card).getByText(/^更新于 /)).toBeInTheDocument();
    expect(within(card).getByText("3 / 12 集")).toBeInTheDocument();
    expect(within(card).getByText("25%")).toBeInTheDocument();
  });

  it("有封面 URL 时在类型图标位置显示缩略图", async () => {
    const coverUrl = "https://example.com/poster.jpg";
    mockedListEntries.mockResolvedValue([
      makeEntry({ title: "有封面的剧", coverUrl }),
    ]);

    render(<App />);

    const card = await screen.findByRole("article", { name: "有封面的剧" });
    const image = card.querySelector("img.entry__cover");
    expect(image).not.toBeNull();
    expect(image).toHaveAttribute("src", coverUrl);
    expect(card.querySelector(".media-type__icon")).toBeNull();
  });

  it("封面加载失败后回退为类型图标", async () => {
    mockedListEntries.mockResolvedValue([
      makeEntry({
        title: "封面失效的剧",
        coverUrl: "https://example.com/broken.jpg",
      }),
    ]);

    render(<App />);

    const card = await screen.findByRole("article", { name: "封面失效的剧" });
    const image = card.querySelector("img.entry__cover");
    expect(image).not.toBeNull();

    fireEvent.error(image!);

    expect(card.querySelector("img.entry__cover")).toBeNull();
    expect(card.querySelector(".media-type__icon")).not.toBeNull();
  });

  it("已弃剧使用独立胶囊样式，并支持状态筛选与表单状态", async () => {
    const user = userEvent.setup();
    const dropped = makeEntry({
      id: "dropped",
      title: "已经弃掉的剧",
      status: "dropped",
    });
    const tracking = makeEntry({
      id: "tracking",
      title: "还在追的剧",
      status: "tracking",
    });
    mockedListEntries.mockResolvedValue([dropped, tracking]);

    render(<App />);

    const droppedCard = await screen.findByRole("article", {
      name: dropped.title,
    });
    const pill = within(droppedCard).getByText("已弃剧");
    expect(pill).toHaveClass("status-pill", "status-pill--dropped");

    await user.selectOptions(
      screen.getByLabelText("状态筛选"),
      "dropped",
    );
    expect(screen.getByRole("article", { name: dropped.title })).toBeVisible();
    expect(screen.queryByRole("article", { name: tracking.title })).toBeNull();

    await user.click(screen.getByRole("button", { name: "添加条目" }));
    const dialog = screen.getByRole("dialog", { name: "添加条目" });
    const statusSelect = within(dialog).getByLabelText("状态");
    expect(
      within(dialog).getByRole("option", { name: "已弃剧" }),
    ).toBeInTheDocument();
    await user.selectOptions(statusSelect, "dropped");
    expect(statusSelect).toHaveValue("dropped");
  });

  it("待看条目使用独立胶囊，快捷按钮为开始追更并切换到在追", async () => {
    const user = userEvent.setup();
    const toWatch = makeEntry({
      id: "to-watch",
      title: "准备追的新剧",
      status: "to_watch",
    });
    mockedListEntries.mockResolvedValue([toWatch]);
    mockedSetEntryStatus.mockResolvedValue({
      ...toWatch,
      status: "tracking",
      updatedAt: "2026-11-20T05:00:00.000Z",
    });

    render(<App />);

    const card = await screen.findByRole("article", { name: toWatch.title });
    const pill = within(card).getByText("待看");
    expect(pill).toHaveClass("status-pill", "status-pill--to_watch");

    await user.click(
      within(card).getByRole("button", { name: "开始追更《准备追的新剧》" }),
    );

    expect(mockedSetEntryStatus).toHaveBeenCalledWith(toWatch.id, "tracking");
  });

  it("表单保存季、评分、平台、封面和简介，并渲染后端结果", async () => {
    const user = userEvent.setup();
    const coverUrl = "https://example.com/new.jpg";
    const created = makeEntry({
      id: "created-meta",
      title: "新短剧",
      mediaType: "short_drama",
      currentProgress: 0,
      totalProgress: null,
      season: 2,
      rating: 8.6,
      platform: "腾讯视频",
      coverUrl,
      overview: "一句话简介",
    });
    mockedListEntries.mockResolvedValue([]);
    mockedCreateEntry.mockResolvedValue(created);

    render(<App />);

    await screen.findByRole("heading", { name: "内容库还是空的" });
    await user.click(screen.getByRole("button", { name: "添加条目" }));
    const dialog = screen.getByRole("dialog", { name: "添加条目" });
    await user.type(within(dialog).getByLabelText("标题"), "新短剧");
    await user.selectOptions(within(dialog).getByLabelText("类型"), "short_drama");
    await user.type(within(dialog).getByLabelText("季"), "2");
    await user.type(within(dialog).getByLabelText("评分"), "8.6");
    await user.type(within(dialog).getByLabelText("平台"), "腾讯视频");
    await user.type(within(dialog).getByLabelText("封面 URL"), coverUrl);
    await user.type(within(dialog).getByLabelText("简介"), "一句话简介");
    await user.click(within(dialog).getByRole("button", { name: "添加条目" }));

    expect(
      await screen.findByRole("article", { name: created.title }),
    ).toBeInTheDocument();
    expect(mockedCreateEntry).toHaveBeenCalledWith({
      title: "新短剧",
      mediaType: "short_drama",
      currentProgress: 0,
      totalProgress: null,
      status: "tracking",
      season: 2,
      rating: 8.6,
      platform: "腾讯视频",
      coverUrl,
      overview: "一句话简介",
    });

    const card = screen.getByRole("article", { name: created.title });
    expect(within(card).getByText("短剧")).toBeInTheDocument();
    expect(within(card).getByText("第 2 季")).toBeInTheDocument();
    expect(within(card).getByText("★ 8.6")).toBeInTheDocument();
    expect(within(card).getByText("腾讯视频")).toBeInTheDocument();
    expect(card.querySelector("img.entry__cover")).toHaveAttribute(
      "src",
      coverUrl,
    );
  });

  it("季和评分的非法值在字段旁提示并阻止提交", async () => {
    const user = userEvent.setup();
    mockedListEntries.mockResolvedValue([]);

    render(<App />);

    await screen.findByRole("heading", { name: "内容库还是空的" });
    await user.click(screen.getByRole("button", { name: "添加条目" }));
    const dialog = screen.getByRole("dialog", { name: "添加条目" });
    await user.type(within(dialog).getByLabelText("标题"), "校验条目");
    const season = within(dialog).getByLabelText("季");
    const rating = within(dialog).getByLabelText("评分");
    await user.type(season, "0");
    await user.type(rating, "10.5");
    await user.click(within(dialog).getByRole("button", { name: "添加条目" }));

    expect(season).toHaveAttribute("aria-invalid", "true");
    expect(season).toHaveAccessibleDescription("季数必须是 1 到 999 的整数。");
    expect(season).toHaveFocus();
    expect(rating).toHaveAttribute("aria-invalid", "true");
    expect(rating).toHaveAccessibleDescription(
      "评分必须是 0 到 10 之间的数字，且最多 1 位小数。",
    );
    expect(mockedCreateEntry).not.toHaveBeenCalled();

    await user.clear(season);
    await user.type(season, "2");
    await user.clear(rating);
    await user.type(rating, "8.25");
    await user.click(within(dialog).getByRole("button", { name: "添加条目" }));

    expect(season).not.toHaveAttribute("aria-invalid");
    expect(rating).toHaveAccessibleDescription(
      "评分必须是 0 到 10 之间的数字，且最多 1 位小数。",
    );
    expect(rating).toHaveFocus();
    expect(mockedCreateEntry).not.toHaveBeenCalled();
  });

  it("封面只接受 http/https 链接，留空的可选字段提交为 null", async () => {
    const user = userEvent.setup();
    const created = makeEntry({ id: "created-empty-options", title: "合法条目" });
    mockedListEntries.mockResolvedValue([]);
    mockedCreateEntry.mockResolvedValue(created);

    render(<App />);

    await screen.findByRole("heading", { name: "内容库还是空的" });
    await user.click(screen.getByRole("button", { name: "添加条目" }));
    const dialog = screen.getByRole("dialog", { name: "添加条目" });
    await user.type(within(dialog).getByLabelText("标题"), "合法条目");
    const cover = within(dialog).getByLabelText("封面 URL");
    await user.type(cover, "ftp://example.com/a.jpg");
    await user.click(within(dialog).getByRole("button", { name: "添加条目" }));

    expect(cover).toHaveAttribute("aria-invalid", "true");
    expect(cover).toHaveAccessibleDescription(
      "封面必须是以 http:// 或 https:// 开头的链接。",
    );
    expect(cover).toHaveFocus();
    expect(mockedCreateEntry).not.toHaveBeenCalled();

    await user.clear(cover);
    await user.click(within(dialog).getByRole("button", { name: "添加条目" }));

    expect(
      await screen.findByRole("article", { name: created.title }),
    ).toBeInTheDocument();
    expect(mockedCreateEntry).toHaveBeenCalledWith({
      title: "合法条目",
      mediaType: "drama",
      currentProgress: 0,
      totalProgress: null,
      status: "tracking",
      season: null,
      rating: null,
      platform: null,
      coverUrl: null,
      overview: null,
    });
  });
});

describe("Markdown 清单导入", () => {
  async function openImportDialog() {
    const user = userEvent.setup();
    mockedListEntries.mockResolvedValue([]);
    render(<App />);
    await screen.findByRole("heading", { name: "内容库还是空的" });
    const sidebar = screen.getByRole("complementary", { name: "侧边栏" });
    await user.click(
      within(sidebar).getByRole("button", { name: "导入 Markdown" }),
    );
    return {
      user,
      dialog: screen.getByRole("dialog", { name: "导入 Markdown" }),
    };
  }

  it("从侧边栏打开导入对话框，展示两种格式示例与默认剧集", async () => {
    const { dialog } = await openImportDialog();

    const textarea = within(dialog).getByLabelText("Markdown 内容");
    expect(textarea).toHaveFocus();
    expect(within(dialog).getByLabelText("默认类型")).toHaveValue("drama");
    expect(within(dialog).getByLabelText("从本地文件读取")).toHaveAttribute(
      "accept",
      ".md,.markdown,text/markdown,text/plain",
    );
    expect(within(dialog).getByText(/标题 \| 类型 \| 第N季/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/自动识别季、进度、平台和评分/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "开始导入" }),
    ).toBeVisible();

    const mobileButton = screen
      .getAllByRole("button", { name: "导入 Markdown" })
      .find((button) => button.classList.contains("topbar__import-button"));
    expect(mobileButton).toBeDefined();
  });

  it("提交时调用 import_markdown 并传递 Markdown 与默认类型", async () => {
    const { user, dialog } = await openImportDialog();
    const markdown =
      "庆余年 | 剧集 | 第2季 | 3/36 | 腾讯视频 | 8.6";
    mockedImportMarkdown.mockResolvedValue({
      imported: 1,
      skipped: 0,
      errors: [],
      entries: [makeEntry({ id: "imported", title: "庆余年" })],
    });

    fireEvent.change(within(dialog).getByLabelText("Markdown 内容"), {
      target: { value: markdown },
    });
    await user.selectOptions(within(dialog).getByLabelText("默认类型"), "anime");
    await user.click(within(dialog).getByRole("button", { name: "开始导入" }));

    expect(
      await within(dialog).findByText(/成功导入 1 条，跳过 0 条/),
    ).toBeInTheDocument();
    expect(mockedImportMarkdown).toHaveBeenCalledWith(markdown, "anime");
  });

  it("展示成功、跳过数量与逐条错误信息", async () => {
    const { user, dialog } = await openImportDialog();
    mockedImportMarkdown.mockResolvedValue({
      imported: 2,
      skipped: 1,
      errors: ["第 3 行：评分必须在 0 到 10 之间。"],
      entries: [
        makeEntry({ id: "a", title: "第一条" }),
        makeEntry({ id: "b", title: "第二条" }),
      ],
    });

    fireEvent.change(within(dialog).getByLabelText("Markdown 内容"), {
      target: { value: "- 第一条\n- 第二条\n- 第三条 11分" },
    });
    await user.click(within(dialog).getByRole("button", { name: "开始导入" }));

    const status = await within(dialog).findByRole("status");
    expect(status).toHaveTextContent("成功导入 2 条，跳过 1 条。");
    const errors = within(dialog).getByRole("list", { name: "导入错误" });
    expect(within(errors).getAllByRole("listitem")).toHaveLength(1);
    expect(
      within(errors).getByText("第 3 行：评分必须在 0 到 10 之间。"),
    ).toBeInTheDocument();
  });

  it("导入成功后刷新主库并保持当前筛选", async () => {
    const importedEntry = makeEntry({
      id: "imported-refresh",
      title: "刚导入的剧",
      mediaType: "anime",
    });
    mockedListEntries
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([importedEntry]);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "内容库还是空的" });
    await user.selectOptions(screen.getByLabelText("类型筛选"), "anime");
    const sidebar = screen.getByRole("complementary", { name: "侧边栏" });
    await user.click(
      within(sidebar).getByRole("button", { name: "导入 Markdown" }),
    );
    const dialog = screen.getByRole("dialog", { name: "导入 Markdown" });
    mockedImportMarkdown.mockResolvedValue({
      imported: 1,
      skipped: 0,
      errors: [],
      entries: [importedEntry],
    });

    fireEvent.change(within(dialog).getByLabelText("Markdown 内容"), {
      target: { value: "- 刚导入的剧 番剧" },
    });
    await user.click(within(dialog).getByRole("button", { name: "开始导入" }));

    expect(
      await screen.findByRole("article", { name: "刚导入的剧" }),
    ).toBeInTheDocument();
    expect(mockedListEntries).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("类型筛选")).toHaveValue("anime");

    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "导入 Markdown" })).toBeNull();
    expect(
      screen.getByRole("article", { name: "刚导入的剧" }),
    ).toBeInTheDocument();
  });

  it("导入失败时显示提示、保留输入且不关闭对话框", async () => {
    const { user, dialog } = await openImportDialog();
    const markdown = "- 保留这一行";
    mockedImportMarkdown.mockRejectedValue(new Error("backend unavailable"));

    fireEvent.change(within(dialog).getByLabelText("Markdown 内容"), {
      target: { value: markdown },
    });
    await user.click(within(dialog).getByRole("button", { name: "开始导入" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "backend unavailable",
    );
    expect(within(dialog).getByLabelText("Markdown 内容")).toHaveValue(
      markdown,
    );
    expect(
      screen.getByRole("dialog", { name: "导入 Markdown" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "开始导入" }),
    ).toBeEnabled();
  });

  it("导入中禁用重复提交，完成后恢复操作", async () => {
    const { user, dialog } = await openImportDialog();
    const deferred = createDeferred<ImportReport>();
    mockedImportMarkdown.mockReturnValue(deferred.promise);

    fireEvent.change(within(dialog).getByLabelText("Markdown 内容"), {
      target: { value: "- 慢速导入" },
    });
    const submit = within(dialog).getByRole("button", { name: "开始导入" });
    await user.click(submit);

    expect(submit).toBeDisabled();
    expect(within(dialog).getByLabelText("Markdown 内容")).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "导入中…" }),
    ).toBeDisabled();
    await user.click(
      within(dialog).getByRole("button", { name: "导入中…" }),
    );
    expect(mockedImportMarkdown).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve({
        imported: 1,
        skipped: 0,
        errors: [],
        entries: [makeEntry({ id: "slow", title: "慢速导入" })],
      });
    });

    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "开始导入" }),
      ).toBeEnabled(),
    );
    expect(
      within(dialog).getByText(/成功导入 1 条，跳过 0 条/),
    ).toBeInTheDocument();
  });
});

describe("设置中心", () => {
  async function renderApp() {
    mockedListEntries.mockResolvedValue([]);
    render(<App />);
    await screen.findByRole("heading", { name: "内容库还是空的" });
    await waitFor(() => expect(mockedGetSettings).toHaveBeenCalledTimes(1));
  }

  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    const sidebar = screen.getByRole("complementary", { name: "侧边栏" });
    await user.click(within(sidebar).getByRole("button", { name: "设置" }));
    return screen.getByRole("dialog", { name: "设置" });
  }

  it("从侧边栏打开设置并回填已保存的设置", async () => {
    mockedGetSettings.mockResolvedValue({
      tmdbApiKey: "tmdb-abc",
      webdavUrl: "https://dav.example.com/catchup",
      webdavUsername: "alice",
      webdavPassword: "secret",
      webdavEnabled: true,
      lastSyncedAt: "2026-11-01T08:00:00.000Z",
      libraryView: "grid",
    });
    const user = userEvent.setup();
    await renderApp();

    const dialog = await openSettings(user);

    expect(within(dialog).getByLabelText("TMDB API Key")).toHaveValue(
      "tmdb-abc",
    );
    expect(within(dialog).getByLabelText("服务器地址")).toHaveValue(
      "https://dav.example.com/catchup",
    );
    expect(within(dialog).getByLabelText("用户名")).toHaveValue("alice");
    expect(within(dialog).getByLabelText("密码")).toHaveValue("secret");
    expect(
      within(dialog).getByRole("checkbox", {
        name: "启用 WebDAV 自动同步",
      }),
    ).toBeChecked();
    expect(within(dialog).getByLabelText("上次同步")).not.toHaveValue(
      "尚未同步",
    );
    const mobileButton = screen
      .getAllByRole("button", { name: "设置" })
      .find((button) => button.classList.contains("topbar__settings-button"));
    expect(mobileButton).toBeDefined();
  });

  it("保存设置时传递完整参数、关闭对话框并提示成功", async () => {
    const user = userEvent.setup();
    await renderApp();
    const dialog = await openSettings(user);
    mockedSaveSettings.mockImplementation(async (settings) => settings);

    const apiKey = within(dialog).getByLabelText("TMDB API Key");
    await user.type(apiKey, "new-key");
    await user.click(within(dialog).getByRole("button", { name: "保存设置" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull(),
    );
    expect(mockedSaveSettings).toHaveBeenCalledWith({
      ...DEFAULT_SETTINGS,
      tmdbApiKey: "new-key",
    });
    expect(screen.getByRole("status")).toHaveTextContent("设置已保存");
  });

  it("保存失败时保留输入并显示错误", async () => {
    const user = userEvent.setup();
    await renderApp();
    const dialog = await openSettings(user);
    mockedSaveSettings.mockRejectedValue("设置保存失败，请重试。");

    const apiKey = within(dialog).getByLabelText("TMDB API Key");
    await user.type(apiKey, "draft-key");
    await user.click(within(dialog).getByRole("button", { name: "保存设置" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "设置保存失败，请重试。",
    );
    expect(within(dialog).getByLabelText("TMDB API Key")).toHaveValue(
      "draft-key",
    );
    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
  });

  it("启用 WebDAV 时在前端校验必填项并阻止保存", async () => {
    const user = userEvent.setup();
    await renderApp();
    const dialog = await openSettings(user);

    await user.click(
      within(dialog).getByRole("checkbox", {
        name: "启用 WebDAV 自动同步",
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "保存设置" }));

    expect(
      within(dialog).getByText("启用自动同步时请填写服务器地址。"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("启用自动同步时请填写用户名。")).toBeInTheDocument();
    expect(mockedSaveSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
  });
});

describe("WebDAV 自动同步", () => {
  const enabledSettings: Partial<AppSettings> = {
    webdavUrl: "https://dav.example.com/catchup",
    webdavUsername: "alice",
    webdavPassword: "secret",
    webdavEnabled: true,
  };

  function sidebarSyncButton() {
    const sidebar = screen.getByRole("complementary", { name: "侧边栏" });
    return within(sidebar).getByRole("button", { name: /同步状态/ });
  }

  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    const sidebar = screen.getByRole("complementary", { name: "侧边栏" });
    await user.click(within(sidebar).getByRole("button", { name: "设置" }));
    return screen.getByRole("dialog", { name: "设置" });
  }

  function renderWith(settings: Partial<AppSettings> = {}) {
    mockedGetSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      ...settings,
    });
    render(<App />);
  }

  it("启动时自动同步一次，成功后刷新列表并显示已同步", async () => {
    const remoteEntry = makeEntry({ id: "remote", title: "来自远端" });
    mockedListEntries.mockResolvedValueOnce([]).mockResolvedValue([remoteEntry]);
    mockedSyncNow.mockResolvedValue(
      makeSyncReport({ merged: 1, downloaded: 1 }),
    );

    renderWith(enabledSettings);

    expect(
      await screen.findByRole("article", { name: "来自远端" }),
    ).toBeInTheDocument();
    expect(mockedSyncNow).toHaveBeenCalledTimes(1);
    expect(mockedListEntries).toHaveBeenCalledTimes(2);
    expect(sidebarSyncButton()).toHaveTextContent("已同步");
  });

  it("同步失败时保留本地条目并在设置中显示错误", async () => {
    const localEntry = makeEntry({ id: "local", title: "本地仍可用" });
    mockedListEntries.mockResolvedValue([localEntry]);
    mockedSyncNow.mockRejectedValue(new Error("WebDAV 服务器返回 500"));

    renderWith(enabledSettings);

    expect(
      await screen.findByRole("article", { name: "本地仍可用" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(sidebarSyncButton()).toHaveTextContent("同步失败"),
    );

    const user = userEvent.setup();
    const dialog = await openSettings(user);
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "WebDAV 服务器返回 500",
    );
    expect(
      screen.getByRole("article", { name: "本地仍可用" }),
    ).toBeInTheDocument();
  });

  it("设置中显示上次同步时间，并在同步中禁用立即同步", async () => {
    mockedListEntries.mockResolvedValue([]);
    mockedSyncNow.mockReturnValue(new Promise(() => {}));
    renderWith({
      ...enabledSettings,
      lastSyncedAt: "2026-11-01T08:00:00.000Z",
    });
    await screen.findByRole("heading", { name: "内容库还是空的" });

    const user = userEvent.setup();
    const dialog = await openSettings(user);

    expect(within(dialog).getByLabelText("上次同步")).not.toHaveValue(
      "尚未同步",
    );
    expect(
      within(dialog).getByRole("button", { name: "同步中…" }),
    ).toBeDisabled();
  });

  it("保存启用设置后点击立即同步，展示合并结果并更新上次同步", async () => {
    const user = userEvent.setup();
    mockedListEntries.mockResolvedValue([]);
    mockedSaveSettings.mockImplementation(async (settings) => settings);
    mockedSyncNow.mockResolvedValue(
      makeSyncReport({ merged: 2, uploaded: 1, downloaded: 1 }),
    );

    renderWith();
    await screen.findByRole("heading", { name: "内容库还是空的" });
    let dialog = await openSettings(user);
    await user.type(
      within(dialog).getByLabelText("服务器地址"),
      "https://dav.example.com/catchup",
    );
    await user.type(within(dialog).getByLabelText("用户名"), "alice");
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: "启用 WebDAV 自动同步",
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "保存设置" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull(),
    );
    expect(mockedSyncNow).not.toHaveBeenCalled();

    dialog = await openSettings(user);
    await user.click(
      within(dialog).getByRole("button", { name: "立即同步" }),
    );

    await waitFor(() => expect(mockedSyncNow).toHaveBeenCalledTimes(1));
    expect(
      await within(dialog).findByText(/同步完成：合并 2 项/),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText("上次同步")).not.toHaveValue(
      "尚未同步",
    );
  });

  it("未启用自动同步时，写操作不会触发同步", async () => {
    const entry = makeEntry({
      id: "local",
      title: "仅本地条目",
      currentProgress: 1,
      totalProgress: 2,
    });
    mockedListEntries.mockResolvedValue([entry]);
    mockedAdjustProgress.mockResolvedValue(
      makeEntry({
        ...entry,
        currentProgress: 2,
        status: "completed",
      }),
    );

    renderWith();
    const card = await screen.findByRole("article", { name: "仅本地条目" });
    const user = userEvent.setup();
    await user.click(
      within(card).getByRole("button", {
        name: "《仅本地条目》进度加一",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 2300));
    expect(mockedSyncNow).not.toHaveBeenCalled();
    expect(sidebarSyncButton()).toHaveTextContent("仅本地");
  });

  it("写操作成功后防抖两秒只触发一次同步", async () => {
    const entry = makeEntry({
      id: "local",
      title: "防抖条目",
      currentProgress: 1,
      totalProgress: 2,
    });
    const updated = makeEntry({
      ...entry,
      currentProgress: 2,
      status: "completed",
    });
    mockedListEntries.mockResolvedValue([entry]);
    mockedAdjustProgress.mockResolvedValue(updated);

    renderWith(enabledSettings);
    await screen.findByRole("article", { name: "防抖条目" });
    await waitFor(() => expect(mockedSyncNow).toHaveBeenCalledTimes(1));

    const user = userEvent.setup();
    await user.click(
      within(
        screen.getByRole("article", { name: "防抖条目" }),
      ).getByRole("button", { name: "《防抖条目》进度加一" }),
    );
    expect(mockedAdjustProgress).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(mockedSyncNow).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(mockedSyncNow).toHaveBeenCalledTimes(2), {
      timeout: 2500,
    });
  });
});

describe("TMDB 元数据刮削", () => {
  const candidate: ScrapeCandidate = {
    sourceId: 693134,
    title: "沙丘 2",
    originalTitle: "Dune: Part Two",
    year: 2024,
    posterUrl: "https://image.tmdb.org/t/p/w500/poster.jpg",
    rating: 8.2,
    overview: "保罗与弗雷曼人联手，向背叛者复仇。",
    kind: "movie",
  };

  async function renderApp(settings: Partial<AppSettings> = {}) {
    mockedGetSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      ...settings,
    });
    mockedListEntries.mockResolvedValue([]);
    render(<App />);
    await screen.findByRole("heading", { name: "内容库还是空的" });
    await waitFor(() => expect(mockedGetSettings).toHaveBeenCalledTimes(1));
  }

  async function openCreateForm(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "添加条目" }));
    return screen.getByRole("dialog", { name: "添加条目" });
  }

  async function openScrapeDialog(
    user: ReturnType<typeof userEvent.setup>,
    form: HTMLElement,
  ) {
    await user.click(
      within(form).getByRole("button", { name: "从 TMDB 刮削" }),
    );
    return screen.getByRole("dialog", { name: "从 TMDB 刮削" });
  }

  it("在添加表单标题旁打开刮削对话框并预填当前标题", async () => {
    const user = userEvent.setup();
    await renderApp({ tmdbApiKey: "tmdb-key" });
    const form = await openCreateForm(user);
    await user.type(within(form).getByLabelText("标题"), "沙丘");

    const scrape = await openScrapeDialog(user, form);

    expect(within(scrape).getByLabelText("搜索标题")).toHaveValue("沙丘");
    expect(mockedSearchTmdb).not.toHaveBeenCalled();
  });

  it("缺少 API Key 时提示并可直接打开设置", async () => {
    const user = userEvent.setup();
    await renderApp();
    const form = await openCreateForm(user);
    const scrape = await openScrapeDialog(user, form);

    expect(within(scrape).getByRole("alert")).toHaveTextContent(
      "请先在设置中填写 TMDB API Key",
    );
    expect(within(scrape).getByRole("button", { name: "搜索" })).toBeDisabled();

    await user.click(within(scrape).getByRole("button", { name: "打开设置" }));

    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
  });

  it("渲染搜索结果中的封面、原名、年份、评分和简介", async () => {
    const user = userEvent.setup();
    await renderApp({ tmdbApiKey: "tmdb-key" });
    const form = await openCreateForm(user);
    await user.type(within(form).getByLabelText("标题"), "沙丘");
    const scrape = await openScrapeDialog(user, form);
    mockedSearchTmdb.mockResolvedValue([candidate]);

    await user.click(within(scrape).getByRole("button", { name: "搜索" }));

    const result = await within(scrape).findByRole("article", {
      name: "沙丘 2",
    });
    expect(within(result).getByText("Dune: Part Two · 2024 年")).toBeInTheDocument();
    expect(within(result).getByText("评分 8.2")).toBeInTheDocument();
    expect(
      within(result).getByText("保罗与弗雷曼人联手，向背叛者复仇。"),
    ).toBeInTheDocument();
    expect(result.querySelector("img")).toHaveAttribute(
      "src",
      "https://image.tmdb.org/t/p/w500/poster.jpg",
    );
    expect(mockedSearchTmdb).toHaveBeenCalledWith("沙丘", "drama");
  });

  it("使用结果回填封面、评分和简介且不覆盖已有标题，其它输入保持", async () => {
    const user = userEvent.setup();
    await renderApp({ tmdbApiKey: "tmdb-key" });
    const form = await openCreateForm(user);
    await user.selectOptions(within(form).getByLabelText("类型"), "movie");
    await user.type(within(form).getByLabelText("标题"), "我的沙丘");
    await user.type(within(form).getByLabelText("平台"), "腾讯视频");
    await user.type(within(form).getByLabelText(/当前进度/), "1");
    const scrape = await openScrapeDialog(user, form);
    mockedSearchTmdb.mockResolvedValue([candidate]);
    await user.click(within(scrape).getByRole("button", { name: "搜索" }));

    await user.click(
      await within(scrape).findByRole("button", { name: "使用此结果" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "从 TMDB 刮削" }),
      ).toBeNull(),
    );
    expect(within(form).getByLabelText("标题")).toHaveValue("我的沙丘");
    expect(within(form).getByLabelText("封面 URL")).toHaveValue(
      "https://image.tmdb.org/t/p/w500/poster.jpg",
    );
    expect(within(form).getByLabelText("评分")).toHaveValue(8.2);
    expect(within(form).getByLabelText("简介")).toHaveValue(
      "保罗与弗雷曼人联手，向背叛者复仇。",
    );
    expect(within(form).getByLabelText("平台")).toHaveValue("腾讯视频");
    expect(within(form).getByLabelText(/当前进度/)).toHaveValue(1);
    expect(mockedSearchTmdb).toHaveBeenCalledWith("我的沙丘", "movie");
  });

  it("标题为空时使用结果标题填充", async () => {
    const user = userEvent.setup();
    await renderApp({ tmdbApiKey: "tmdb-key" });
    const form = await openCreateForm(user);
    await user.selectOptions(within(form).getByLabelText("类型"), "movie");
    const scrape = await openScrapeDialog(user, form);
    mockedSearchTmdb.mockResolvedValue([candidate]);
    fireEvent.change(within(scrape).getByLabelText("搜索标题"), {
      target: { value: "沙丘" },
    });
    await user.click(within(scrape).getByRole("button", { name: "搜索" }));

    await user.click(
      await within(scrape).findByRole("button", { name: "使用此结果" }),
    );

    expect(within(form).getByLabelText("标题")).toHaveValue("沙丘 2");
  });

  it("搜索失败时显示中文错误并保留打开设置入口", async () => {
    const user = userEvent.setup();
    await renderApp({ tmdbApiKey: "tmdb-key" });
    const form = await openCreateForm(user);
    await user.type(within(form).getByLabelText("标题"), "沙丘");
    const scrape = await openScrapeDialog(user, form);
    mockedSearchTmdb.mockRejectedValue(
      "TMDB 请求失败（HTTP 500），请稍后重试。",
    );

    await user.click(within(scrape).getByRole("button", { name: "搜索" }));

    expect(await within(scrape).findByRole("alert")).toHaveTextContent(
      "TMDB 请求失败（HTTP 500），请稍后重试。",
    );
    expect(
      within(scrape).getByRole("button", { name: "打开设置" }),
    ).toBeInTheDocument();
    expect(within(scrape).getByLabelText("搜索标题")).toHaveValue("沙丘");
  });

  it("搜索中禁用重复提交，空结果给出提示", async () => {
    const user = userEvent.setup();
    await renderApp({ tmdbApiKey: "tmdb-key" });
    const form = await openCreateForm(user);
    await user.type(within(form).getByLabelText("标题"), "不存在的剧");
    const scrape = await openScrapeDialog(user, form);
    const deferred = createDeferred<ScrapeCandidate[]>();
    mockedSearchTmdb.mockReturnValue(deferred.promise);

    const submit = within(scrape).getByRole("button", { name: "搜索" });
    await user.click(submit);
    expect(within(scrape).getByRole("button", { name: "搜索中…" })).toBeDisabled();
    expect(mockedSearchTmdb).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve([]);
    });

    expect(
      await within(scrape).findByText(
        "没有找到匹配的结果，试试其他关键词。",
      ),
    ).toBeInTheDocument();
    expect(within(scrape).getByRole("button", { name: "搜索" })).toBeEnabled();
  });
});
