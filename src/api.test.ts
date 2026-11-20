import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adjustProgress,
  createEntry,
  deleteEntry,
  emptyTrash,
  getLibraryErrorMessage,
  listEntries,
  listTrash,
  purgeEntry,
  restoreEntry,
  setEntryStatus,
  updateEntry,
} from "./api";
import type { EntryInput, MediaEntry } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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
