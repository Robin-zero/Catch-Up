import { DEFAULT_SETTINGS } from "./types";
import type {
  AppSettings,
  EntryInput,
  EntryStatus,
  ImportReport,
  MediaEntry,
  MediaType,
  ScrapeCandidate,
  SyncReport,
} from "./types";

/** 在浏览器（非 Tauri WebView）里调用 Tauri 的 `invoke` 会抛错。 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

const ENTRIES_KEY = "catchup.entries.v6";
const DELETED_KEY = "catchup.deleted.v6";
const SETTINGS_KEY = "catchup.settings.v1";
const COVER_DB = "catchup-covers";
const COVER_STORE = "covers";

function now(): string {
  return new Date().toISOString();
}

function uuid(): string {
  return "c_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function readList<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function writeList<T>(key: string, value: T[]): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export function readWebEntries(): MediaEntry[] {
  return readList<MediaEntry>(ENTRIES_KEY);
}

export function writeWebEntries(value: MediaEntry[]): void {
  writeList(ENTRIES_KEY, value);
}

function normalizeTitle(raw: string): string {
  return raw.trim();
}

function normalizeSeason(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  return text ? text : null;
}

function matchEntry(
  input: EntryInput,
  entry: MediaEntry,
  excludeId?: string,
): boolean {
  if (excludeId && entry.id === excludeId) return false;
  if (entry.status === "dropped") return false; // 已弃剧的旧条目不算重复
  return (
    normalizeTitle(entry.title) === normalizeTitle(input.title) &&
    entry.mediaType === input.mediaType &&
    (entry.season ?? null) === normalizeSeason(input.season)
  );
}

export function createWebEntry(input: EntryInput): MediaEntry {
  const entries = readWebEntries();
  if (entries.some((entry) => matchEntry(input, entry))) {
    throw new Error("已存在同名同类型条目。");
  }
  const entry: MediaEntry = {
    id: uuid(),
    title: normalizeTitle(input.title),
    mediaType: input.mediaType,
    currentProgress: input.currentProgress ?? 0,
    totalProgress: input.totalProgress ?? null,
    status: input.status ?? "tracking",
    season: normalizeSeason(input.season),
    rating: input.rating ?? null,
    platform: input.platform ?? null,
    coverUrl: input.coverUrl ?? null,
    overview: input.overview ?? null,
    createdAt: now(),
    updatedAt: now(),
  };
  entries.push(entry);
  writeWebEntries(entries);
  return entry;
}

export function updateWebEntry(
  id: string,
  input: EntryInput,
): MediaEntry {
  const entries = readWebEntries();
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error("条目不存在。");
  if (entries.some((entry) => matchEntry(input, entry, id))) {
    throw new Error("已存在同名同类型条目。");
  }
  const original = entries[index];
  const updated: MediaEntry = {
    ...original,
    title: normalizeTitle(input.title),
    mediaType: input.mediaType,
    currentProgress: input.currentProgress ?? 0,
    totalProgress: input.totalProgress ?? null,
    status: input.status ?? "tracking",
    season: normalizeSeason(input.season),
    rating: input.rating ?? null,
    platform: input.platform ?? null,
    coverUrl: input.coverUrl ?? null,
    overview: input.overview ?? null,
    updatedAt: now(),
  };
  entries[index] = updated;
  writeWebEntries(entries);
  return updated;
}

export function deleteWebEntry(id: string): void {
  const entries = readWebEntries();
  const entry = entries.find((item) => item.id === id);
  if (!entry) return;
  const updated: MediaEntry = { ...entry };
  const filtered = entries.filter((item) => item.id !== id);
  writeWebEntries(filtered);
  const deleted = readList<MediaEntry>(DELETED_KEY);
  // 保留被删除时的完整快照，通过 status === "deleted" 标记
  deleted.push({ ...updated, status: "dropped", updatedAt: now() });
  writeList(DELETED_KEY, deleted);
}

export function listWebTrash(): MediaEntry[] {
  return readList<MediaEntry>(DELETED_KEY);
}

export function restoreWebEntry(id: string): MediaEntry {
  const deleted = readList<MediaEntry>(DELETED_KEY);
  const index = deleted.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("回收站条目不存在。");
  const [entry] = deleted.splice(index, 1);
  writeList(DELETED_KEY, deleted);
  const restored: MediaEntry = { ...entry, updatedAt: now() };
  const entries = readWebEntries();
  entries.push(restored);
  writeWebEntries(entries);
  return restored;
}

export function purgeWebEntry(id: string): void {
  const deleted = readList<MediaEntry>(DELETED_KEY);
  writeList(
    DELETED_KEY,
    deleted.filter((item) => item.id !== id),
  );
}

export function emptyWebTrash(): void {
  writeList<MediaEntry>(DELETED_KEY, []);
}

export function adjustWebProgress(
  id: string,
  delta: number,
): MediaEntry {
  const entries = readWebEntries();
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error("条目不存在。");
  const original = entries[index];
  let next = original.currentProgress + delta;
  if (next < 0) next = 0;
  if (original.totalProgress !== null && next > original.totalProgress) {
    next = original.totalProgress;
  }
  const updated: MediaEntry = {
    ...original,
    currentProgress: next,
    updatedAt: now(),
  };
  entries[index] = updated;
  writeWebEntries(entries);
  return updated;
}

export function setWebEntryStatus(
  id: string,
  status: EntryStatus,
): MediaEntry {
  const entries = readWebEntries();
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error("条目不存在。");
  const updated: MediaEntry = {
    ...entries[index],
    status,
    updatedAt: now(),
  };
  entries[index] = updated;
  writeWebEntries(entries);
  return updated;
}

export function getWebSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveWebSettings(settings: AppSettings): AppSettings {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

/** 封面缓存到 IndexedDB，返回可用的 blob URL。 */
function coverDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(COVER_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(COVER_STORE)) {
        db.createObjectStore(COVER_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveWebCover(dataBase64: string): Promise<string> {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "image/*" });
  const db = await coverDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(COVER_STORE, "readwrite");
    tx.objectStore(COVER_STORE).put({ id: uuid(), blob });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return URL.createObjectURL(blob);
}

export async function cacheWebCoverFromUrl(url: string): Promise<string> {
  if (!/^https?:/i.test(url)) {
    throw new Error("封面链接必须以 http 或 https 开头。");
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载封面失败：HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const db = await coverDb();
  const key = uuid();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(COVER_STORE, "readwrite");
    tx.objectStore(COVER_STORE).put({ id: key, blob });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return URL.createObjectURL(blob);
}

export async function searchWebTmdb(
  query: string,
  mediaType?: MediaType,
): Promise<ScrapeCandidate[]> {
  const settings = getWebSettings();
  if (!settings.tmdbApiKey) {
    throw new Error("请先在设置中填写 TMDB API Key。");
  }
  const tmdbType = mediaType === "movie" ? "movie" : "tv";
  const url =
    `https://api.themoviedb.org/3/search/${tmdbType}` +
    `?api_key=${encodeURIComponent(settings.tmdbApiKey)}` +
    `&query=${encodeURIComponent(query.trim())}&language=zh-CN`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`搜索失败：HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    results: Array<{
      id: number;
      title?: string;
      name?: string;
      original_title?: string;
      original_name?: string;
      first_air_date?: string;
      release_date?: string;
      poster_path?: string;
      vote_average?: number;
      overview?: string;
    }>;
  };
  return payload.results.slice(0, 10).map((item) => {
    const title = item.title ?? item.name ?? "";
    const originalTitle = item.original_title ?? item.original_name ?? null;
    const date = item.first_air_date ?? item.release_date ?? "";
    return {
      sourceId: item.id,
      title,
      originalTitle,
      year: date ? Number(date.slice(0, 4)) : null,
      posterUrl: item.poster_path
        ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
        : null,
      rating: item.vote_average ?? null,
      overview: item.overview ?? null,
      kind: tmdbType === "movie" ? "movie" : "tv",
    };
  });
}

export function syncWebNow(): SyncReport {
  const settings = getWebSettings();
  if (!settings.webdavEnabled) {
    throw new Error("尚未开启 WebDAV 同步。");
  }
  const now_ = now();
  const updated = saveWebSettings({ ...settings, lastSyncedAt: now_ });
  return { merged: 0, uploaded: 0, downloaded: 0, lastSyncedAt: updated.lastSyncedAt! };
}

/** Excel 导入解析 —— 浏览器端实现（简化版，不依赖 xlsx 包）。
 *  支持 CSV 和 TSV；xlsx 需要真正的解析库，这里用 csv 默认 + 下载按钮提示。
 */
export async function importWebExcel(
  dataBase64: string,
  defaultMediaType?: MediaType,
): Promise<ImportReport> {
  const text = atob(dataBase64);
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.length > 0);
  if (lines.length < 2) {
    return { imported: 0, skipped: 0, errors: ["文件内容为空。"], entries: [] };
  }
  const separator = lines[0].includes(",") && !lines[0].includes("\t") ? "," : "\t";
  const headers = lines[0].split(separator).map((h) => h.trim());
  const headerIndex = (name: string) =>
    headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const result: ImportReport = { imported: 0, skipped: 0, errors: [], entries: [] };
  const existing = readWebEntries();
  const mediaMap: Record<string, MediaType> = {
    剧集: "drama",
    drama: "drama",
    番剧: "anime",
    anime: "anime",
    综艺: "variety",
    variety: "variety",
    小说: "novel",
    novel: "novel",
    电影: "movie",
    movie: "movie",
    短剧: "short_drama",
    short_drama: "short_drama",
  };
  const statusMap: Record<string, EntryStatus> = {
    在追: "tracking",
    tracking: "tracking",
    待看: "to_watch",
    to_watch: "to_watch",
    已完成: "completed",
    completed: "completed",
    已弃剧: "dropped",
    dropped: "dropped",
  };

  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(separator);
    const title = cols[headerIndex("标题")]?.trim();
    if (!title) {
      result.skipped += 1;
      continue;
    }
    const mediaLabel = cols[headerIndex("类型")]?.trim() || "";
    const mediaType =
      mediaMap[mediaLabel.toLowerCase()] ??
      mediaMap[mediaLabel] ??
      defaultMediaType ??
      null;
    if (!mediaType) {
      result.errors.push(`第 ${i + 1} 行：类型无效。`);
      result.skipped += 1;
      continue;
    }
    const statusLabel = cols[headerIndex("状态")]?.trim() || "在追";
    const status = statusMap[statusLabel.toLowerCase()] ?? statusMap[statusLabel] ?? "tracking";
    const entry: MediaEntry = {
      id: uuid(),
      title,
      mediaType,
      currentProgress: Number(cols[headerIndex("当前进度")] ?? 0) || 0,
      totalProgress:
        Number(cols[headerIndex("总进度")] ?? "") || null,
      status,
      season: normalizeSeason(cols[headerIndex("季")]),
      rating: Number(cols[headerIndex("评分")] ?? "") || null,
      platform: cols[headerIndex("平台")]?.trim() || null,
      coverUrl: cols[headerIndex("封面")]?.trim() || null,
      overview: cols[headerIndex("简介")]?.trim() || null,
      createdAt: now(),
      updatedAt: now(),
    };
    if (existing.some((e) => e.title === entry.title && e.mediaType === entry.mediaType)) {
      result.skipped += 1;
      continue;
    }
    existing.push(entry);
    result.entries.push(entry);
    result.imported += 1;
  }
  writeWebEntries(existing);
  return result;
}

/** Web 端下载模板：纯 CSV 实现（通用 Excel 兼容），避免依赖 xlsx 库。 */
export function generateWebTemplate(): string {
  const headers = ["标题", "类型", "季", "当前进度", "总进度", "状态", "平台", "评分", "封面", "简介"];
  const sample = [
    "庆余年",
    "剧集",
    "2",
    "3",
    "36",
    "在追",
    "腾讯视频",
    "8.6",
    "https://example.com/cover.jpg",
    "一段示例简介",
  ];
  const escape = (val: string) =>
    val.includes(",") || val.includes('"')
      ? `"${val.replace(/"/g, '""')}"`
      : val;
  const content = [headers, sample]
    .map((row) => row.map(escape).join(","))
    .join("\r\n");
  return btoa(unescape(encodeURIComponent("\uFEFF" + content))); // BOM 让 Excel 正确识别 UTF-8
}
