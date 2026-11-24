import { DEFAULT_SETTINGS } from "./types";
import type {
  AppSettings,
  EntryInput,
  EntryStatus,
  ImportReport,
  MediaEntry,
  MediaType,
  ScrapeCandidate,
  SmartScrapeResult,
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
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    if (!merged.aiBaseUrl.trim()) {
      merged.aiBaseUrl = DEFAULT_SETTINGS.aiBaseUrl;
    }
    if (!merged.aiModel.trim()) {
      merged.aiModel = DEFAULT_SETTINGS.aiModel;
    }
    return merged;
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
      source: "TMDB",
      totalEpisodes: null,
    };
  });
}

function trimOrNull(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseYear(value: string | null | undefined): number | null {
  if (!value) return null;
  const year = Number(value.slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : null;
}

function cleanHtmlText(raw: string | null | undefined): string | null {
  if (!raw || typeof document === "undefined") return null;
  const container = document.createElement("div");
  container.innerHTML = raw;
  const text = (container.textContent ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 800) : null;
}

interface BangumiSubjectJson {
  id?: number;
  name?: string;
  name_cn?: string;
  summary?: string;
  date?: string;
  images?: { large?: string };
  rating?: { score?: number };
  eps?: number;
  volumes?: number;
}

async function fetchWebBangumi(
  query: string,
  subjectType: number,
  kind: ScrapeCandidate["kind"],
): Promise<ScrapeCandidate[]> {
  const response = await fetch("https://api.bgm.tv/v0/search/subjects?limit=10", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword: query, filter: { type: [subjectType] } }),
  });
  if (!response.ok) {
    throw new Error(`Bangumi 搜索失败（HTTP ${response.status}）`);
  }
  const payload = (await response.json()) as { data?: BangumiSubjectJson[] };
  return (payload.data ?? []).flatMap((item) => {
    const originalTitle = trimOrNull(item.name);
    const title = trimOrNull(item.name_cn) ?? originalTitle;
    if (!title) return [];
    const score = item.rating?.score ?? 0;
    const episodes = item.eps ?? item.volumes ?? null;
    return [
      {
        sourceId: item.id ?? 0,
        title,
        originalTitle,
        year: parseYear(item.date),
        posterUrl: trimOrNull(item.images?.large),
        rating: score > 0 ? roundOne(score) : null,
        overview: cleanHtmlText(item.summary),
        kind,
        source: "Bangumi",
        totalEpisodes: episodes && episodes > 0 ? episodes : null,
      },
    ];
  });
}

interface AniListMediaJson {
  id?: number;
  title?: { romaji?: string; native?: string; english?: string };
  startDate?: { year?: number };
  coverImage?: { large?: string };
  averageScore?: number;
  description?: string;
  episodes?: number;
  chapters?: number;
}

const ANILIST_QUERY = `query ($search: String, $type: MediaType) {
  Page(perPage: 10) {
    media(search: $search, type: $type, sort: SEARCH_MATCH) {
      id
      title { romaji native english }
      startDate { year }
      coverImage { large }
      averageScore
      description(asHtml: false)
      episodes
      chapters
    }
  }
}`;

async function fetchWebAniList(
  query: string,
  media: "ANIME" | "MANGA",
  kind: ScrapeCandidate["kind"],
): Promise<ScrapeCandidate[]> {
  const response = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: ANILIST_QUERY,
      variables: { search: query, type: media },
    }),
  });
  if (!response.ok) {
    throw new Error(`AniList 搜索失败（HTTP ${response.status}）`);
  }
  const payload = (await response.json()) as {
    data?: { Page?: { media?: AniListMediaJson[] } };
  };
  return (payload.data?.Page?.media ?? []).flatMap((item) => {
    const native = trimOrNull(item.title?.native);
    const romaji = trimOrNull(item.title?.romaji);
    const english = trimOrNull(item.title?.english);
    const title = english ?? romaji ?? native;
    if (!title) return [];
    const score = item.averageScore ?? 0;
    const episodes = item.episodes ?? item.chapters ?? null;
    return [
      {
        sourceId: item.id ?? 0,
        title,
        originalTitle: romaji ?? native,
        year: item.startDate?.year ?? null,
        posterUrl: trimOrNull(item.coverImage?.large),
        rating: score > 0 ? roundOne(score / 10) : null,
        overview: cleanHtmlText(item.description),
        kind,
        source: "AniList",
        totalEpisodes: episodes && episodes > 0 ? episodes : null,
      },
    ];
  });
}

interface TvmazeShowJson {
  id?: number;
  name?: string;
  premiered?: string;
  image?: { medium?: string; original?: string };
  rating?: { average?: number };
  summary?: string;
}

async function fetchWebTvmaze(query: string): Promise<ScrapeCandidate[]> {
  const response = await fetch(
    `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`,
  );
  if (!response.ok) {
    throw new Error(`TVMaze 搜索失败（HTTP ${response.status}）`);
  }
  const payload = (await response.json()) as Array<{ show?: TvmazeShowJson }>;
  return payload.flatMap((item) => {
    const show = item.show;
    const title = trimOrNull(show?.name);
    if (!show || !title) return [];
    const average = show.rating?.average ?? 0;
    return [
      {
        sourceId: show.id ?? 0,
        title,
        originalTitle: null,
        year: parseYear(show.premiered),
        posterUrl:
          trimOrNull(show.image?.original) ?? trimOrNull(show.image?.medium),
        rating: average > 0 ? roundOne(average) : null,
        overview: cleanHtmlText(show.summary),
        kind: "tv" as const,
        source: "TVMaze",
        totalEpisodes: null,
      },
    ];
  });
}

function normalizeScrapeKey(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function scrapeSourcePriority(source: string | null | undefined): number {
  switch (source) {
    case "TMDB":
    case "Bangumi":
      return 6;
    case "AniList":
      return 4;
    case "TVMaze":
      return 3;
    case "Open Library":
      return 2;
    default:
      return 0;
  }
}

function scrapeMatchScore(
  candidate: ScrapeCandidate,
  key: string,
): { exact: boolean; score: number } {
  if (!key) return { exact: false, score: 20 };
  let best = 20;
  for (const title of [candidate.title, candidate.originalTitle]) {
    const normalized = normalizeScrapeKey(title ?? "");
    if (!normalized) continue;
    if (normalized === key) return { exact: true, score: 100 };
    if (normalized.includes(key) || key.includes(normalized)) {
      best = Math.max(best, 55);
    }
  }
  return { exact: false, score: best };
}

function rankScrapeCandidates(
  candidates: ScrapeCandidate[],
  query: string,
): ScrapeCandidate[] {
  const key = normalizeScrapeKey(query);
  const ranked = candidates.map((candidate) => {
    const match = scrapeMatchScore(candidate, key);
    let score = match.score + scrapeSourcePriority(candidate.source);
    if (candidate.posterUrl) score += 10;
    if (candidate.overview) score += 5;
    if (candidate.rating !== null) score += 3;
    if (candidate.year) score += 2;
    if (candidate.totalEpisodes) score += 3;
    return { candidate, exact: match.exact, score };
  });
  ranked.sort((left, right) => {
    if (left.exact !== right.exact) return left.exact ? -1 : 1;
    if (left.score !== right.score) return right.score - left.score;
    return left.candidate.title.localeCompare(right.candidate.title, "zh-CN");
  });
  const seen = new Set<string>();
  const result: ScrapeCandidate[] = [];
  for (const item of ranked) {
    const dedupeKey = `${normalizeScrapeKey(item.candidate.title)}|${
      item.candidate.year ?? 0
    }`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push(item.candidate);
    if (result.length >= 12) break;
  }
  return result;
}

interface AiPayloadJson {
  title?: string | null;
  originalTitle?: string | null;
  year?: number | string | null;
  rating?: number | string | null;
  overview?: string | null;
  platform?: string | null;
  posterUrl?: string | null;
}

const AI_SYSTEM_PROMPT =
  "你是影视、动漫元数据助手。根据用户给出的作品名称与类型，返回真实存在的元数据。" +
  "只输出一个 JSON 对象，不要输出 Markdown 代码块或解释文字。字段如下：" +
  "title（中文标题，字符串）、originalTitle（原名，字符串或 null）、year（首播或出版年份，整数或 null）、" +
  "rating（0 到 10 的评分，数字或 null）、overview（不超过 150 字的中文简介，字符串或 null）、" +
  "platform（主要播出或阅读平台，字符串或 null）、posterUrl（公开可访问的 http/https 封面图片地址，字符串或 null）。" +
  "不确定的字段一律填 null，禁止编造不存在的信息。";

function aiMediaLabel(mediaType?: MediaType): string {
  switch (mediaType) {
    case "anime":
      return "番剧";
    case "movie":
      return "电影";
    case "variety":
      return "综艺";
    case "short_drama":
      return "短剧";
    case "drama":
      return "剧集";
    default:
      return "影视作品";
  }
}

function aiCandidateKind(mediaType?: MediaType): ScrapeCandidate["kind"] {
  if (mediaType === "movie") return "movie";
  if (mediaType === "anime") return "anime";
  return "tv";
}

function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function coerceAiYear(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 1000 && value <= 2100 ? value : null;
  }
  if (typeof value === "string") {
    const year = Number(value.trim().slice(0, 4));
    return Number.isInteger(year) && year >= 1000 && year <= 2100 ? year : null;
  }
  return null;
}

function coerceAiRating(value: unknown): number | null {
  const rating =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(rating) || rating < 0 || rating > 10) return null;
  return roundOne(rating);
}

function truncateText(
  value: string | null | undefined,
  limit: number,
): string | null {
  const text = trimOrNull(value);
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function mapAiContent(
  content: string,
  mediaType?: MediaType,
): ScrapeCandidate | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("AI 返回内容中缺少 JSON 对象");
  }
  let payload: AiPayloadJson;
  try {
    payload = JSON.parse(content.slice(start, end + 1)) as AiPayloadJson;
  } catch {
    throw new Error("解析 AI 返回内容失败");
  }
  const title = trimOrNull(payload.title);
  if (!title) return null;
  const year = coerceAiYear(payload.year);
  const poster = trimOrNull(payload.posterUrl);
  return {
    sourceId: hashText(`${title}|${year ?? ""}`),
    title,
    originalTitle: trimOrNull(payload.originalTitle),
    year,
    posterUrl: poster && /^https?:\/\//i.test(poster) ? poster : null,
    rating: coerceAiRating(payload.rating),
    overview: truncateText(payload.overview, 800),
    kind: aiCandidateKind(mediaType),
    source: "AI",
    totalEpisodes: null,
    platform: truncateText(payload.platform, 60),
  };
}

async function requestAiCandidate(
  settings: AppSettings,
  query: string,
  mediaType?: MediaType,
): Promise<ScrapeCandidate | null> {
  const base = settings.aiBaseUrl.trim().replace(/\/+$/, "");
  const model = settings.aiModel.trim();
  if (!base || !model) return null;
  const url = base.endsWith("/chat/completions")
    ? base
    : `${base}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = settings.aiApiKey.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: AI_SYSTEM_PROMPT },
        {
          role: "user",
          content: `作品名称：${query}\n类型：${aiMediaLabel(mediaType)}\n请只返回 JSON。`,
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`AI 请求失败（HTTP ${response.status}）`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices
    ?.map((choice) => choice.message?.content)
    .find((value): value is string => Boolean(value));
  if (!content) {
    throw new Error("AI 未返回可用内容");
  }
  return mapAiContent(content, mediaType);
}

function isConfidentScrape(candidates: ScrapeCandidate[], key: string): boolean {
  return (
    candidates.length > 0 &&
    Boolean(key) &&
    [candidates[0].title, candidates[0].originalTitle].some(
      (title) => normalizeScrapeKey(title ?? "") === key,
    )
  );
}

export async function smartScrapeWeb(
  query: string,
  mediaType?: MediaType,
): Promise<SmartScrapeResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("请输入要搜索的标题");
  }
  const settings = getWebSettings();
  const hasTmdbKey = Boolean(settings.tmdbApiKey.trim());
  if (mediaType === "movie" && !hasTmdbKey) {
    throw new Error("电影目前只有 TMDB 数据源，请先在设置中填写 TMDB API Key");
  }

  const tasks: Array<Promise<ScrapeCandidate[]>> = [];
  if (mediaType === "anime") {
    tasks.push(fetchWebBangumi(trimmed, 2, "anime"));
    tasks.push(fetchWebAniList(trimmed, "ANIME", "anime"));
  } else if (mediaType === "movie") {
    tasks.push(searchWebTmdb(trimmed, "movie"));
  } else {
    if (hasTmdbKey) {
      tasks.push(searchWebTmdb(trimmed, mediaType));
    }
    tasks.push(fetchWebTvmaze(trimmed));
    tasks.push(fetchWebBangumi(trimmed, 6, "tv"));
  }

  const settled = await Promise.allSettled(tasks);
  const candidates: ScrapeCandidate[] = [];
  const errors: string[] = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      candidates.push(...outcome.value);
    } else {
      errors.push(
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason),
      );
    }
  }

  if (candidates.length === 0 && errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  const ranked = rankScrapeCandidates(candidates, trimmed);
  const key = normalizeScrapeKey(trimmed);
  return { candidates: ranked, confident: isConfidentScrape(ranked, key) };
}

export async function aiScrapeWeb(
  query: string,
  mediaType?: MediaType,
): Promise<SmartScrapeResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("请输入要搜索的标题");
  }
  const settings = getWebSettings();
  if (!settings.aiEnabled) {
    throw new Error("请先在设置中开启 AI 补全");
  }

  const candidate = await requestAiCandidate(settings, trimmed, mediaType);
  if (!candidate) {
    return { candidates: [], confident: false };
  }
  return {
    candidates: [candidate],
    confident: isConfidentScrape([candidate], normalizeScrapeKey(trimmed)),
  };
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

/** 浏览器端只做一次只读请求，验证地址与账号是否可用。 */
export async function testWebdavConnectionWeb(
  settings: AppSettings,
): Promise<string> {
  const raw = settings.webdavUrl.trim();
  if (!raw) {
    throw new Error("请填写 WebDAV 服务器地址");
  }
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error("WebDAV 服务器地址仅支持 http 或 https 链接");
  }
  const normalized = raw.replace(/\/+$/, "");
  const url = normalized.toLowerCase().endsWith(".json")
    ? normalized
    : `${normalized}/catchup-sync.json`;
  const headers: Record<string, string> = {};
  const username = settings.webdavUsername.trim();
  if (username) {
    const bytes = new TextEncoder().encode(
      `${username}:${settings.webdavPassword}`,
    );
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    headers.Authorization = `Basic ${btoa(binary)}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers });
  } catch {
    throw new Error("无法连接 WebDAV，请检查地址、网络或跨域设置。");
  }
  if (response.status >= 200 && response.status < 300) {
    return "连接成功，已找到同步数据。";
  }
  if (response.status === 404) {
    return "连接成功，远端暂无同步数据。";
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `WebDAV 认证失败（HTTP ${response.status}），请检查用户名与密码。`,
    );
  }
  throw new Error(
    `连接 WebDAV 失败（HTTP ${response.status}），请检查地址与访问权限。`,
  );
}

/** 浏览器端用最小请求验证 AI 接口、Key 与模型。 */
export async function testAiConnectionWeb(
  settings: AppSettings,
): Promise<string> {
  const base = settings.aiBaseUrl.trim().replace(/\/+$/, "");
  const model = settings.aiModel.trim();
  if (!base) {
    throw new Error("请填写 AI 接口地址");
  }
  if (!model) {
    throw new Error("请填写 AI 模型名称");
  }
  const url = base.endsWith("/chat/completions")
    ? base
    : `${base}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = settings.aiApiKey.trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
  } catch {
    throw new Error("无法连接 AI 接口，请检查地址、网络或跨域设置。");
  }
  if (!response.ok) {
    throw new Error(`AI 请求失败（HTTP ${response.status}），请检查配置。`);
  }
  return `连接成功，模型 ${model} 可用。`;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function readZipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  let eocd = -1;
  const minimum = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (readUint32(bytes, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("无法读取 xlsx 文件结构。");
  }

  const count = readUint16(bytes, eocd + 10);
  let pointer = readUint32(bytes, eocd + 16);
  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index += 1) {
    if (
      pointer + 46 > bytes.length ||
      readUint32(bytes, pointer) !== 0x02014b50
    ) {
      break;
    }
    const method = readUint16(bytes, pointer + 10);
    const compressedSize = readUint32(bytes, pointer + 20);
    const nameLength = readUint16(bytes, pointer + 28);
    const extraLength = readUint16(bytes, pointer + 30);
    const commentLength = readUint16(bytes, pointer + 32);
    const localOffset = readUint32(bytes, pointer + 42);
    const name = decoder.decode(
      bytes.subarray(pointer + 46, pointer + 46 + nameLength),
    );
    entries.set(name, { name, method, compressedSize, localOffset });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readZipEntry(
  bytes: Uint8Array,
  entries: Map<string, ZipEntry>,
  name: string,
): Promise<Uint8Array | null> {
  const entry = entries.get(name);
  if (!entry) {
    return null;
  }
  if (readUint32(bytes, entry.localOffset) !== 0x04034b50) {
    throw new Error("xlsx 文件结构损坏，无法读取内容。");
  }
  const nameLength = readUint16(bytes, entry.localOffset + 26);
  const extraLength = readUint16(bytes, entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) {
    return compressed;
  }
  if (entry.method !== 8 || typeof DecompressionStream === "undefined") {
    throw new Error("当前浏览器不支持解析该 xlsx 文件，请改用 CSV 或桌面端导入。");
  }
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(compressed as unknown as BufferSource);
      controller.close();
    },
  });
  const reader = source
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const output = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.length;
  }
  return output;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, value: string) =>
      String.fromCodePoint(Number(value)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlText(fragment: string): string {
  return decodeXmlEntities(
    (fragment.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? [])
      .map((item) => item.replace(/^<t\b[^>]*>/, "").replace(/<\/t>$/, ""))
      .join(""),
  );
}

function parseSharedStrings(xml: string): string[] {
  return (xml.match(/<si\b[^>]*>[\s\S]*?<\/si>/g) ?? []).map((item) =>
    xmlText(item),
  );
}

function columnIndexFromName(name: string): number {
  let index = 0;
  for (const char of name) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function parseWorksheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const rowXml of xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const cells: string[] = [];
    for (const cellXml of rowXml.match(
      /<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g,
    ) ?? []) {
      const reference = /\br="([A-Z]+)\d+"/.exec(cellXml)?.[1];
      const index = reference ? columnIndexFromName(reference) : cells.length;
      const type = /\bt="([^"]+)"/.exec(cellXml)?.[1];
      let value = "";
      if (type === "inlineStr") {
        value = xmlText(cellXml);
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] ?? "";
        value =
          type === "s"
            ? (shared[Number(raw)] ?? "")
            : decodeXmlEntities(raw);
      }
      cells[index] = value;
    }
    const rowNumber = Number(/\br="(\d+)"/.exec(rowXml)?.[1]);
    const position = rowNumber > 0 ? rowNumber - 1 : rows.length;
    rows[position] = cells;
  }
  return rows;
}

function resolveWorksheetPath(
  entries: Map<string, ZipEntry>,
  workbookXml: string,
  relsXml: string | null,
): string {
  const relationId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbookXml)?.[1];
  if (relationId && relsXml) {
    for (const relation of relsXml.match(/<Relationship\b[^>]*\/?>/g) ?? []) {
      if (/\bId="([^"]+)"/.exec(relation)?.[1] !== relationId) {
        continue;
      }
      const target = /\bTarget="([^"]+)"/.exec(relation)?.[1];
      if (!target) {
        break;
      }
      if (target.startsWith("/")) {
        return target.slice(1);
      }
      return target.startsWith("xl/") ? target : `xl/${target}`;
    }
  }
  return entries.has("xl/worksheets/sheet1.xml")
    ? "xl/worksheets/sheet1.xml"
    : "";
}

function zipDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

function zipBaseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

function resolveZipTarget(baseDirectory: string, target: string): string {
  if (target.startsWith("/")) {
    return target.slice(1);
  }
  const segments = baseDirectory.split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.join("/");
}

function parseRelationships(xml: string): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const relation of xml.match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = /\bId="([^"]+)"/.exec(relation)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(relation)?.[1];
    if (id && target) {
      relationships.set(id, target);
    }
  }
  return relationships;
}

function imageMimeType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    default:
      return "image/jpeg";
  }
}

/** 读取工作表中嵌入的封面图片，按行号映射为 data URL。 */
async function readEmbeddedCovers(
  bytes: Uint8Array,
  entries: Map<string, ZipEntry>,
  sheetPath: string,
  sheetXml: string,
): Promise<Map<number, string>> {
  const covers = new Map<number, string>();
  const drawingId = /<drawing\b[^>]*\br:id="([^"]+)"/.exec(sheetXml)?.[1];
  if (!drawingId) {
    return covers;
  }
  const decoder = new TextDecoder();
  const sheetDirectory = zipDirectory(sheetPath);
  const sheetRels = await readZipEntry(
    bytes,
    entries,
    `${sheetDirectory}/_rels/${zipBaseName(sheetPath)}.rels`,
  );
  if (!sheetRels) {
    return covers;
  }
  const drawingTarget = parseRelationships(decoder.decode(sheetRels)).get(
    drawingId,
  );
  if (!drawingTarget) {
    return covers;
  }
  const drawingPath = resolveZipTarget(sheetDirectory, drawingTarget);
  const drawingBytes = await readZipEntry(bytes, entries, drawingPath);
  if (!drawingBytes) {
    return covers;
  }
  const drawingDirectory = zipDirectory(drawingPath);
  const drawingRelsBytes = await readZipEntry(
    bytes,
    entries,
    `${drawingDirectory}/_rels/${zipBaseName(drawingPath)}.rels`,
  );
  const drawingRelationships = drawingRelsBytes
    ? parseRelationships(decoder.decode(drawingRelsBytes))
    : new Map<string, string>();
  const drawingXml = decoder.decode(drawingBytes);

  const anchors =
    drawingXml.match(
      /<(?:xdr:)?(?:twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/(?:xdr:)?(?:twoCellAnchor|oneCellAnchor)>/g,
    ) ?? [];
  for (const anchor of anchors) {
    const from = /<(?:xdr:)?from>([\s\S]*?)<\/(?:xdr:)?from>/.exec(anchor)?.[1];
    if (!from) {
      continue;
    }
    const column = Number(/<(?:xdr:)?col>(\d+)<\/(?:xdr:)?col>/.exec(from)?.[1]);
    const row = Number(/<(?:xdr:)?row>(\d+)<\/(?:xdr:)?row>/.exec(from)?.[1]);
    if (column !== 8 || !Number.isFinite(row)) {
      continue;
    }
    const embedId = /<(?:a:)?blip\b[^>]*\br:embed="([^"]+)"/.exec(anchor)?.[1];
    if (!embedId) {
      continue;
    }
    const imageTarget = drawingRelationships.get(embedId);
    if (!imageTarget) {
      continue;
    }
    const imagePath = resolveZipTarget(drawingDirectory, imageTarget);
    const imageBytes = await readZipEntry(bytes, entries, imagePath);
    if (!imageBytes) {
      continue;
    }
    covers.set(
      row,
      `data:${imageMimeType(imagePath)};base64,${bytesToBase64(imageBytes)}`,
    );
  }
  return covers;
}

async function readXlsxRows(
  bytes: Uint8Array,
): Promise<{ rows: string[][]; covers: Map<number, string> }> {
  const entries = readZipEntries(bytes);
  const decoder = new TextDecoder();
  const workbookName = entries.has("xl/workbook.xml")
    ? "xl/workbook.xml"
    : [...entries.keys()].find((name) => /(^|\/)workbook\.xml$/.test(name));
  if (!workbookName) {
    throw new Error("xlsx 文件缺少工作簿信息。");
  }
  const workbookBytes = await readZipEntry(bytes, entries, workbookName);
  if (!workbookBytes) {
    throw new Error("xlsx 文件缺少工作簿信息。");
  }
  const workbookXml = decoder.decode(workbookBytes);
  const relsBytes = await readZipEntry(
    bytes,
    entries,
    "xl/_rels/workbook.xml.rels",
  );
  const sheetPath = resolveWorksheetPath(
    entries,
    workbookXml,
    relsBytes ? decoder.decode(relsBytes) : null,
  );
  if (!sheetPath) {
    throw new Error("xlsx 文件没有可用的工作表。");
  }
  const sheetBytes = await readZipEntry(bytes, entries, sheetPath);
  if (!sheetBytes) {
    throw new Error("xlsx 文件没有可用的工作表。");
  }
  const sheetXml = decoder.decode(sheetBytes);
  const sharedBytes = await readZipEntry(
    bytes,
    entries,
    "xl/sharedStrings.xml",
  );
  const shared = sharedBytes
    ? parseSharedStrings(decoder.decode(sharedBytes))
    : [];
  return {
    rows: parseWorksheetRows(sheetXml, shared),
    covers: await readEmbeddedCovers(bytes, entries, sheetPath, sheetXml),
  };
}

function splitDelimitedLine(line: string, separator: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === separator) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function parseDelimitedRows(text: string): string[][] {
  const normalized = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }
  const separator =
    lines[0].includes(",") && !lines[0].includes("\t") ? "," : "\t";
  return lines.map((line) => splitDelimitedLine(line, separator));
}

function importRows(
  rows: string[][],
  defaultMediaType?: MediaType,
  coversByRow: Map<number, string> = new Map(),
): ImportReport {
  const result: ImportReport = { imported: 0, skipped: 0, errors: [], entries: [] };
  const headerRowIndex = rows.findIndex((row) =>
    row?.some((cell) => cell.trim() === "标题"),
  );
  const headerRow = rows[headerRowIndex >= 0 ? headerRowIndex : 0] ?? [];
  const headers = headerRow.map((header) => header.trim());
  const headerIndex = (name: string) =>
    headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());

  const titleColumn = headerIndex("标题");
  if (titleColumn < 0) {
    throw new Error("缺少“标题”列，请使用导入模板重新填写。");
  }

  const existing = readWebEntries();
  const mediaMap: Record<string, MediaType> = {
    剧集: "drama",
    drama: "drama",
    番剧: "anime",
    anime: "anime",
    综艺: "variety",
    variety: "variety",
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

  const startRow = headerRowIndex >= 0 ? headerRowIndex + 1 : 1;
  for (let index = startRow; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.every((cell) => !cell.trim())) {
      continue;
    }
    const column = (name: string) => {
      const position = headerIndex(name);
      return position >= 0 ? (row[position] ?? "").trim() : "";
    };

    const title = column("标题");
    if (!title) {
      result.skipped += 1;
      result.errors.push(`第 ${index + 1} 行：标题不能为空。`);
      continue;
    }
    const mediaLabel = column("类型");
    const mediaType =
      mediaMap[mediaLabel.toLowerCase()] ??
      mediaMap[mediaLabel] ??
      defaultMediaType ??
      null;
    if (!mediaType) {
      result.errors.push(`第 ${index + 1} 行：类型无效。`);
      result.skipped += 1;
      continue;
    }
    const statusLabel = column("状态") || "在追";
    const status =
      statusMap[statusLabel.toLowerCase()] ?? statusMap[statusLabel] ?? "tracking";
    const isMovie = mediaType === "movie";
    const entry: MediaEntry = {
      id: uuid(),
      title,
      mediaType,
      currentProgress: isMovie ? 0 : Number(column("当前进度")) || 0,
      totalProgress: isMovie ? null : Number(column("总进度")) || null,
      status,
      season: isMovie ? null : normalizeSeason(column("季")),
      rating: Number(column("评分")) || null,
      platform: column("平台") || null,
      coverUrl: column("封面") || coversByRow.get(index) || null,
      overview: column("简介") || null,
      createdAt: now(),
      updatedAt: now(),
    };
    const duplicate = existing.find(
      (item) => item.title === entry.title && item.mediaType === entry.mediaType,
    );
    if (duplicate) {
      result.skipped += 1;
      if (!duplicate.coverUrl && entry.coverUrl) {
        duplicate.coverUrl = entry.coverUrl;
        duplicate.updatedAt = now();
      }
      continue;
    }
    existing.push(entry);
    result.entries.push(entry);
    result.imported += 1;
  }
  writeWebEntries(existing);
  return result;
}

/** Excel 导入解析：浏览器端支持 CSV/TSV 与 xlsx（包括压缩条目）。 */
export async function importWebExcel(
  dataBase64: string,
  defaultMediaType?: MediaType,
): Promise<ImportReport> {
  const bytes = base64ToBytes(dataBase64);
  const isZip =
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04;
  const content = isZip
    ? await readXlsxRows(bytes)
    : {
        rows: parseDelimitedRows(new TextDecoder().decode(bytes)),
        covers: new Map<number, string>(),
      };
  if (content.rows.length === 0) {
    return { imported: 0, skipped: 0, errors: ["文件内容为空。"], entries: [] };
  }
  return importRows(content.rows, defaultMediaType, content.covers);
}

/**
 * Web 端 xlsx 模板：结构与 src-tauri/src/excel.rs 中的生成逻辑保持一致。
 * 修改列、样式或下拉选项时，请同步更新两端。
 */
const TEMPLATE_HEADERS = [
  "标题",
  "类型",
  "季",
  "当前进度",
  "总进度",
  "状态",
  "平台",
  "评分",
  "封面",
  "简介",
];

const TEMPLATE_SAMPLE: Array<string | number> = [
  "庆余年",
  "剧集",
  "2",
  3,
  36,
  "在追",
  "腾讯视频",
  8.6,
  "https://example.com/cover.jpg",
  "一段示例简介",
];

const TEMPLATE_COLUMN_WIDTHS = [22, 10, 8, 10, 9, 8, 12, 7, 32, 32];

const TEMPLATE_MEDIA_TYPES = ["剧集", "番剧", "综艺", "电影", "短剧"];
const TEMPLATE_STATUSES = ["在追", "待看", "已完成", "已弃剧"];
const TEMPLATE_PLATFORMS = [
  "腾讯视频",
  "爱奇艺",
  "优酷",
  "芒果TV",
  "哔哩哔哩",
  "红果短剧",
  "Netflix",
  "其他",
];

/** 与桌面端模板一致的单元格样式索引。 */
const TEMPLATE_CELL_STYLES = {
  header: 1,
  text: 2,
  integer: 3,
  rating: 4,
  link: 5,
  overview: 6,
} as const;

const TEMPLATE_COLUMN_STYLES: Array<number | undefined> = [
  undefined,
  undefined,
  undefined,
  TEMPLATE_CELL_STYLES.integer,
  TEMPLATE_CELL_STYLES.integer,
  undefined,
  undefined,
  TEMPLATE_CELL_STYLES.rating,
  TEMPLATE_CELL_STYLES.link,
  undefined,
];

const TEMPLATE_ROW_STYLES = [
  TEMPLATE_CELL_STYLES.text,
  TEMPLATE_CELL_STYLES.text,
  TEMPLATE_CELL_STYLES.text,
  TEMPLATE_CELL_STYLES.integer,
  TEMPLATE_CELL_STYLES.integer,
  TEMPLATE_CELL_STYLES.text,
  TEMPLATE_CELL_STYLES.text,
  TEMPLATE_CELL_STYLES.rating,
  TEMPLATE_CELL_STYLES.link,
  TEMPLATE_CELL_STYLES.overview,
];

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 生成不压缩的 ZIP，用于组装最小可用的 xlsx 工作簿。 */
function buildZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;
  // 固定为 1980-01-01 00:00，保证每次生成的内容一致。
  const dosTime = 0;
  const dosDate = 0x21;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const checksum = crc32(file.data);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, file.data.length, true);
    localView.setUint32(22, file.data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, file.data.length, true);
    centralView.setUint32(24, file.data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    localChunks.push(local, file.data);
    centralChunks.push(central);
    offset += local.length + file.data.length;
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const chunks = [...localChunks, ...centralChunks, end];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.length;
  }
  return output;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index: number): string {
  let name = "";
  let current = index + 1;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

function templateCell(
  value: string | number,
  row: number,
  column: number,
  style: number,
): string {
  const reference = `${columnName(column)}${row}`;
  if (typeof value === "number") {
    return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  }
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function templateValidation(
  sqref: string,
  values: string[],
  title: string,
  message: string,
  errorTitle: string,
  errorMessage: string,
): string {
  return `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${sqref}" promptTitle="${escapeXml(title)}" prompt="${escapeXml(message)}" errorTitle="${escapeXml(errorTitle)}" error="${escapeXml(errorMessage)}"><formula1>"${escapeXml(values.join(","))}"</formula1></dataValidation>`;
}

function templateSheetXml(): string {
  const headerRow = TEMPLATE_HEADERS.map((header, columnIndex) =>
    templateCell(
      header,
      1,
      columnIndex,
      TEMPLATE_CELL_STYLES.header,
    ),
  ).join("");
  const sampleRow = TEMPLATE_SAMPLE.map((value, columnIndex) =>
    templateCell(value, 2, columnIndex, TEMPLATE_ROW_STYLES[columnIndex]),
  ).join("");
  const columns = TEMPLATE_COLUMN_WIDTHS.map((width, index) => {
    const style = TEMPLATE_COLUMN_STYLES[index];
    const styleAttribute = style === undefined ? "" : ` style="${style}"`;
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"${styleAttribute}/>`;
  }).join("");
  const validations = [
    templateValidation(
      "B2:B1001",
      TEMPLATE_MEDIA_TYPES,
      "选择类型",
      "请从下拉列表中选择内容类型",
      "类型无效",
      "请从下拉列表中选择有效的类型",
    ),
    templateValidation(
      "F2:F1001",
      TEMPLATE_STATUSES,
      "选择状态",
      "请从下拉列表中选择追更状态",
      "状态无效",
      "请从下拉列表中选择有效的状态",
    ),
    templateValidation(
      "G2:G1001",
      TEMPLATE_PLATFORMS,
      "选择平台",
      "请从下拉列表中选择平台，选填",
      "平台无效",
      "请从下拉列表中选择有效的平台",
    ),
  ].join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:J2"/><sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${columns}</cols><sheetData><row r="1" ht="24" customHeight="1">${headerRow}</row><row r="2">${sampleRow}</row></sheetData><autoFilter ref="A1:J2"/><dataValidations count="3">${validations}</dataValidations></worksheet>`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Web 端下载模板：生成与桌面端一致的 xlsx 文件。 */
export function generateWebTemplate(): string {
  const encoder = new TextEncoder();
  const files = [
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="追更导入模板" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: "xl/styles.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF1F4E79"/></left><right style="thin"><color rgb="FF1F4E79"/></right><top style="thin"><color rgb="FF1F4E79"/></top><bottom style="thin"><color rgb="FF1F4E79"/></bottom><diagonal/></border><border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right><top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="1" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`,
    },
    { name: "xl/worksheets/sheet1.xml", content: templateSheetXml() },
  ].map((file) => ({ name: file.name, data: encoder.encode(file.content) }));

  return bytesToBase64(buildZip(files));
}
