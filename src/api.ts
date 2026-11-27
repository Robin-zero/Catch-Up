export { isTauri } from "./web";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppSettings,
  EntryInput,
  EntryStatus,
  ImportReport,
  MediaEntry,
  MediaType,
  ScrapeCandidate,
  SmartScrapeResult,
  SyncProgress,
  SyncReport,
} from "./types";
import {
  adjustWebProgress,
  cacheWebCoverFromUrl,
  createWebEntry,
  deleteWebEntry,
  emptyWebTrash,
  generateWebTemplate,
  getWebSettings,
  importWebExcel,
  isTauri,
  listWebTrash,
  purgeWebEntry,
  restoreWebEntry,
  saveWebCover,
  aiScrapeWeb,
  saveWebSettings,
  searchWebTmdb,
  smartScrapeWeb,
  setWebEntryStatus,
  syncWebNow,
  testAiConnectionWeb,
  testWebdavConnectionWeb,
  updateWebEntry,
  readWebEntries,
} from "./web";

export function listEntries(): Promise<MediaEntry[]> {
  if (!isTauri()) return Promise.resolve(readWebEntries());
  return invoke<MediaEntry[]>("list_entries");
}

export function createEntry(input: EntryInput): Promise<MediaEntry> {
  if (!isTauri()) return Promise.resolve(createWebEntry(input));
  return invoke<MediaEntry>("create_entry", { input });
}

export function updateEntry(id: string, input: EntryInput): Promise<MediaEntry> {
  if (!isTauri()) return Promise.resolve(updateWebEntry(id, input));
  return invoke<MediaEntry>("update_entry", { id, input });
}

export function importExcel(
  dataBase64: string,
  defaultMediaType?: MediaType,
): Promise<ImportReport> {
  if (!isTauri())
    return importWebExcel(dataBase64, defaultMediaType);
  return invoke<ImportReport>("import_excel", {
    data: dataBase64,
    defaultMediaType: defaultMediaType ?? null,
  });
}

export function downloadExcelTemplate(): Promise<string> {
  if (!isTauri()) return Promise.resolve(generateWebTemplate());
  return invoke<string>("download_excel_template");
}

export function saveCoverImage(
  dataBase64: string,
  extension: string,
): Promise<string> {
  if (!isTauri()) return saveWebCover(dataBase64);
  return invoke<string>("save_cover_image", {
    data: dataBase64,
    extension,
  });
}

export function cacheCoverFromUrl(url: string): Promise<string> {
  if (!isTauri()) return cacheWebCoverFromUrl(url);
  return invoke<string>("cache_cover_from_url", { url });
}

export function deleteEntry(id: string): Promise<void> {
  if (!isTauri()) {
    deleteWebEntry(id);
    return Promise.resolve();
  }
  return invoke<void>("delete_entry", { id });
}

export function adjustProgress(id: string, delta: number): Promise<MediaEntry> {
  if (!isTauri()) return Promise.resolve(adjustWebProgress(id, delta));
  return invoke<MediaEntry>("adjust_progress", { id, delta });
}

export function setEntryStatus(
  id: string,
  status: EntryStatus,
): Promise<MediaEntry> {
  if (!isTauri()) return Promise.resolve(setWebEntryStatus(id, status));
  return invoke<MediaEntry>("set_entry_status", { id, status });
}

export function listTrash(): Promise<MediaEntry[]> {
  if (!isTauri()) return Promise.resolve(listWebTrash());
  return invoke<MediaEntry[]>("list_trash");
}

export function restoreEntry(id: string): Promise<MediaEntry> {
  if (!isTauri()) return Promise.resolve(restoreWebEntry(id));
  return invoke<MediaEntry>("restore_entry", { id });
}

export function purgeEntry(id: string): Promise<void> {
  if (!isTauri()) {
    purgeWebEntry(id);
    return Promise.resolve();
  }
  return invoke<void>("purge_entry", { id });
}

export function emptyTrash(): Promise<void> {
  if (!isTauri()) {
    emptyWebTrash();
    return Promise.resolve();
  }
  return invoke<void>("empty_trash");
}

export function getSettings(): Promise<AppSettings> {
  if (!isTauri()) return Promise.resolve(getWebSettings());
  return invoke<AppSettings>("get_settings");
}

export function saveSettings(settings: AppSettings): Promise<AppSettings> {
  if (!isTauri()) return Promise.resolve(saveWebSettings(settings));
  return invoke<AppSettings>("save_settings", { settings });
}

export function searchTmdb(
  query: string,
  mediaType?: MediaType,
): Promise<ScrapeCandidate[]> {
  if (!isTauri()) return searchWebTmdb(query, mediaType);
  return invoke<ScrapeCandidate[]>("search_tmdb", {
    query,
    mediaType: mediaType ?? null,
  });
}

export function smartScrape(
  query: string,
  mediaType?: MediaType,
): Promise<SmartScrapeResult> {
  if (!isTauri()) return smartScrapeWeb(query, mediaType);
  return invoke<SmartScrapeResult>("smart_scrape", {
    query,
    mediaType: mediaType ?? null,
  });
}

export function aiScrape(
  query: string,
  mediaType?: MediaType,
): Promise<SmartScrapeResult> {
  if (!isTauri()) return aiScrapeWeb(query, mediaType);
  return invoke<SmartScrapeResult>("ai_scrape", {
    query,
    mediaType: mediaType ?? null,
  });
}

export function syncNow(): Promise<SyncReport> {
  if (!isTauri()) return Promise.resolve(syncWebNow());
  return invoke<SyncReport>("sync_now");
}

export function onSyncProgress(
  handler: (progress: SyncProgress) => void,
): Promise<() => void> {
  if (!isTauri()) return Promise.resolve(() => {});
  return listen<SyncProgress>("sync-progress", (event) => {
    handler(event.payload);
  });
}

export interface UpdateInfo {
  available: boolean;
  version: string;
  currentVersion: string;
  body?: string;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  if (!isTauri()) {
    return {
      available: false,
      version: "",
      currentVersion: "web",
    };
  }
  try {
    const updater = await import("@tauri-apps/plugin-updater");
    const update: Awaited<ReturnType<typeof updater.check>> =
      await updater.check();
    if (!update) {
      // 未检测到更新时，Update 类的 currentVersion 取不到；
      // 我们用默认的空字符串，UI 展示时可据此回退。
      return {
        available: false,
        version: "",
        currentVersion: "",
      };
    }
    return {
      available: true,
      version: update.version,
      currentVersion: update.currentVersion,
      body: update.body,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    throw new Error(`检查更新失败：${message}`);
  }
}

export async function downloadAndInstallUpdate(): Promise<void> {
  if (!isTauri()) return;
  const updater = await import("@tauri-apps/plugin-updater");
  const update = await updater.check();
  if (!update) {
    throw new Error("当前已是最新版本");
  }
  await update.downloadAndInstall();
}

export function testAiConnection(settings: AppSettings): Promise<string> {
  if (!isTauri()) return testAiConnectionWeb(settings);
  return invoke<string>("test_ai_connection", { settings });
}

export function testWebdavConnection(settings: AppSettings): Promise<string> {
  if (!isTauri()) return testWebdavConnectionWeb(settings);
  return invoke<string>("test_webdav_connection", { settings });
}

export function getLibraryErrorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  if (/permission|denied|unauthorized|forbidden/i.test(message)) {
    return "没有权限读取本地内容库，请检查应用权限后重试。";
  }

  if (/network|fetch|connect|timeout|timed out/i.test(message)) {
    return "暂时无法连接本地数据服务，请检查应用状态后重试。";
  }

  if (message === "已存在同名同类型条目。") {
    return message;
  }

  return "本地内容库暂时无法读取，请重试。若问题持续，请重新启动应用。";
}
