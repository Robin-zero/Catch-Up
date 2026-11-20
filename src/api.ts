import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  EntryInput,
  EntryStatus,
  ImportReport,
  MediaEntry,
  MediaType,
  ScrapeCandidate,
} from "./types";

export function listEntries(): Promise<MediaEntry[]> {
  return invoke<MediaEntry[]>("list_entries");
}

export function createEntry(input: EntryInput): Promise<MediaEntry> {
  return invoke<MediaEntry>("create_entry", { input });
}

export function updateEntry(id: string, input: EntryInput): Promise<MediaEntry> {
  return invoke<MediaEntry>("update_entry", { id, input });
}

export function importMarkdown(
  markdown: string,
  defaultMediaType: MediaType,
): Promise<ImportReport> {
  return invoke<ImportReport>("import_markdown", {
    markdown,
    defaultMediaType,
  });
}

export function deleteEntry(id: string): Promise<void> {
  return invoke<void>("delete_entry", { id });
}

export function adjustProgress(id: string, delta: number): Promise<MediaEntry> {
  return invoke<MediaEntry>("adjust_progress", { id, delta });
}

export function setEntryStatus(
  id: string,
  status: EntryStatus,
): Promise<MediaEntry> {
  return invoke<MediaEntry>("set_entry_status", { id, status });
}

export function listTrash(): Promise<MediaEntry[]> {
  return invoke<MediaEntry[]>("list_trash");
}

export function restoreEntry(id: string): Promise<MediaEntry> {
  return invoke<MediaEntry>("restore_entry", { id });
}

export function purgeEntry(id: string): Promise<void> {
  return invoke<void>("purge_entry", { id });
}

export function emptyTrash(): Promise<void> {
  return invoke<void>("empty_trash");
}

export function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

export function saveSettings(settings: AppSettings): Promise<AppSettings> {
  return invoke<AppSettings>("save_settings", { settings });
}

export function searchTmdb(
  query: string,
  mediaType?: MediaType,
): Promise<ScrapeCandidate[]> {
  return invoke<ScrapeCandidate[]>("search_tmdb", {
    query,
    mediaType: mediaType ?? null,
  });
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

  return "本地内容库暂时无法读取，请重试。若问题持续，请重新启动应用。";
}
