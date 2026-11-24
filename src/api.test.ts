import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adjustProgress,
  createEntry,
  deleteEntry,
  downloadExcelTemplate,
  emptyTrash,
  getLibraryErrorMessage,
  getSettings,
  importExcel,
  listEntries,
  listTrash,
  purgeEntry,
  restoreEntry,
  saveSettings,
  searchTmdb,
  setEntryStatus,
  smartScrape,
  aiScrape,
  updateEntry,
} from "./api";
import {
  DEFAULT_SETTINGS,
  type EntryInput,
  type MediaEntry,
  type ScrapeCandidate,
} from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// api.ts 会在浏览器中检测 window.__TAURI__ 来决定是否走 Tauri 后端。
// 这里给它一个空对象，让所有调用都走被 mock 的 invoke 路径。
(window as unknown as { __TAURI__: unknown }).__TAURI__ = {};

const mockedInvoke = vi.mocked(invoke);

const input: EntryInput = {
  title: "测试条目",
  mediaType: "drama",
  currentProgress: 2,
  totalProgress: 10,
  status: "tracking",
};

const entry: MediaEntry = {
  id: "entry-1",
  ...input,
  createdAt: "2026-11-17T00:00:00.000Z",
  updatedAt: "2026-11-17T00:00:00.000Z",
};

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe("Tauri 数据访问", () => {
  it("通过 list_entries 读取并返回后端条目", async () => {
    mockedInvoke.mockResolvedValue([entry]);

    await expect(listEntries()).resolves.toEqual([entry]);
    expect(mockedInvoke).toHaveBeenCalledWith("list_entries");
  });

  it("不会把读取拒绝伪造成成功", async () => {
    mockedInvoke.mockRejectedValue("database locked");

    await expect(listEntries()).rejects.toBe("database locked");
  });

  it("通过 create_entry 传递完整输入", async () => {
    mockedInvoke.mockResolvedValue(entry);

    await expect(createEntry(input)).resolves.toEqual(entry);
    expect(mockedInvoke).toHaveBeenCalledWith("create_entry", { input });
  });

  it("通过 import_excel 传递 base64 数据与可选默认类型", async () => {
    const report = {
      imported: 1,
      skipped: 0,
      errors: [],
      entries: [entry],
    };
    mockedInvoke.mockResolvedValue(report);

    await expect(importExcel("UEsDBA==", "anime")).resolves.toEqual(report);
    expect(mockedInvoke).toHaveBeenCalledWith("import_excel", {
      data: "UEsDBA==",
      defaultMediaType: "anime",
    });

    mockedInvoke.mockClear();
    await importExcel("UEsDBA==");
    expect(mockedInvoke).toHaveBeenCalledWith("import_excel", {
      data: "UEsDBA==",
      defaultMediaType: null,
    });
  });

  it("通过 download_excel_template 返回 base64 模板", async () => {
    mockedInvoke.mockResolvedValue("UEsDBA==");

    await expect(downloadExcelTemplate()).resolves.toBe("UEsDBA==");
    expect(mockedInvoke).toHaveBeenCalledWith("download_excel_template");
  });

  it("通过 update_entry 传递条目 id 和完整输入", async () => {
    mockedInvoke.mockResolvedValue(entry);

    await expect(updateEntry(entry.id, input)).resolves.toEqual(entry);
    expect(mockedInvoke).toHaveBeenCalledWith("update_entry", {
      id: entry.id,
      input,
    });
  });

  it("通过 delete_entry 删除指定条目", async () => {
    mockedInvoke.mockResolvedValue(undefined);

    await expect(deleteEntry(entry.id)).resolves.toBeUndefined();
    expect(mockedInvoke).toHaveBeenCalledWith("delete_entry", {
      id: entry.id,
    });
  });

  it("通过 adjust_progress 传递进度增量", async () => {
    mockedInvoke.mockResolvedValue(entry);

    await expect(adjustProgress(entry.id, 1)).resolves.toEqual(entry);
    expect(mockedInvoke).toHaveBeenCalledWith("adjust_progress", {
      id: entry.id,
      delta: 1,
    });
  });

  it("通过 set_entry_status 更新状态", async () => {
    mockedInvoke.mockResolvedValue({ ...entry, status: "completed" });

    await expect(setEntryStatus(entry.id, "completed")).resolves.toEqual({
      ...entry,
      status: "completed",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("set_entry_status", {
      id: entry.id,
      status: "completed",
    });
  });

  it("通过 list_trash 读取回收站条目", async () => {
    mockedInvoke.mockResolvedValue([entry]);

    await expect(listTrash()).resolves.toEqual([entry]);
    expect(mockedInvoke).toHaveBeenCalledWith("list_trash");
  });

  it("通过 restore_entry 恢复指定条目", async () => {
    mockedInvoke.mockResolvedValue(entry);

    await expect(restoreEntry(entry.id)).resolves.toEqual(entry);
    expect(mockedInvoke).toHaveBeenCalledWith("restore_entry", {
      id: entry.id,
    });
  });

  it("通过 purge_entry 彻底删除指定条目", async () => {
    mockedInvoke.mockResolvedValue(undefined);

    await expect(purgeEntry(entry.id)).resolves.toBeUndefined();
    expect(mockedInvoke).toHaveBeenCalledWith("purge_entry", {
      id: entry.id,
    });
  });

  it("通过 empty_trash 清空回收站", async () => {
    mockedInvoke.mockResolvedValue(undefined);

    await expect(emptyTrash()).resolves.toBeUndefined();
    expect(mockedInvoke).toHaveBeenCalledWith("empty_trash");
  });

  it("通过 get_settings 读取设置", async () => {
    const settings = { ...DEFAULT_SETTINGS, tmdbApiKey: "key" };
    mockedInvoke.mockResolvedValue(settings);

    await expect(getSettings()).resolves.toEqual(settings);
    expect(mockedInvoke).toHaveBeenCalledWith("get_settings");
  });

  it("通过 save_settings 保存完整设置", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      tmdbApiKey: "key",
      webdavUrl: "https://dav.example.com",
      webdavUsername: "alice",
    };
    mockedInvoke.mockResolvedValue(settings);

    await expect(saveSettings(settings)).resolves.toEqual(settings);
    expect(mockedInvoke).toHaveBeenCalledWith("save_settings", { settings });
  });

  it("通过 search_tmdb 传递查询与媒体类型", async () => {
    const candidate: ScrapeCandidate = {
      sourceId: 1,
      title: "沙丘 2",
      originalTitle: "Dune: Part Two",
      year: 2024,
      posterUrl: "https://image.tmdb.org/t/p/w500/poster.jpg",
      rating: 8.2,
      overview: "简介",
      kind: "movie",
    };
    mockedInvoke.mockResolvedValue([candidate]);

    await expect(searchTmdb("沙丘", "movie")).resolves.toEqual([candidate]);
    expect(mockedInvoke).toHaveBeenCalledWith("search_tmdb", {
      query: "沙丘",
      mediaType: "movie",
    });

    mockedInvoke.mockClear();
    await searchTmdb("漫长的季节");
    expect(mockedInvoke).toHaveBeenCalledWith("search_tmdb", {
      query: "漫长的季节",
      mediaType: null,
    });
  });

  it("通过 smart_scrape 传递查询与媒体类型", async () => {
    const candidate: ScrapeCandidate = {
      sourceId: 302267,
      title: "葬送的芙莉莲",
      originalTitle: "Sousou no Frieren",
      year: 2023,
      posterUrl: "https://lain.bgm.tv/pic/cover/l/frieren.jpg",
      rating: 8.9,
      overview: "简介",
      kind: "anime",
      source: "Bangumi",
      totalEpisodes: 28,
    };
    const result = { candidates: [candidate], confident: true };
    mockedInvoke.mockResolvedValue(result);

    await expect(smartScrape("葬送的芙莉莲", "anime")).resolves.toEqual(result);
    expect(mockedInvoke).toHaveBeenCalledWith("smart_scrape", {
      query: "葬送的芙莉莲",
      mediaType: "anime",
    });

    mockedInvoke.mockClear();
    await smartScrape("漫长的季节");
    expect(mockedInvoke).toHaveBeenCalledWith("smart_scrape", {
      query: "漫长的季节",
      mediaType: null,
    });
  });

  it("通过 ai_scrape 触发独立 AI 补全", async () => {
    const result = { candidates: [], confident: false };
    mockedInvoke.mockResolvedValue(result);

    await expect(aiScrape("沙丘", "movie")).resolves.toEqual(result);
    expect(mockedInvoke).toHaveBeenCalledWith("ai_scrape", {
      query: "沙丘",
      mediaType: "movie",
    });
  });
});

describe("中文错误转换", () => {
  it("为连接、权限和未知错误提供可理解提示", () => {
    expect(getLibraryErrorMessage(new Error("network timeout"))).toMatch(
      /无法连接本地数据服务/,
    );
    expect(getLibraryErrorMessage("permission denied")).toMatch(
      /没有权限读取本地内容库/,
    );
    expect(getLibraryErrorMessage({ unexpected: true })).toMatch(
      /本地内容库暂时无法读取/,
    );
  });
});
