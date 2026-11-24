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

interface OpenLibraryDocJson {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  ratings_average?: number;
}

async function fetchWebOpenLibrary(query: string): Promise<ScrapeCandidate[]> {
  const fields =
    "key,title,author_name,first_publish_year,cover_i,ratings_average";
  const response = await fetch(
    `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=10&fields=${fields}`,
  );
  if (!response.ok) {
    throw new Error(`Open Library 搜索失败（HTTP ${response.status}）`);
  }
  const payload = (await response.json()) as { docs?: OpenLibraryDocJson[] };
  return (payload.docs ?? []).flatMap((item) => {
    const title = trimOrNull(item.title);
    if (!title) return [];
    const authors = (item.author_name ?? [])
      .map((name) => name.trim())
      .filter(Boolean);
    const average = item.ratings_average ?? 0;
    return [
      {
        sourceId: item.cover_i ?? 0,
        title,
        originalTitle: null,
        year: item.first_publish_year ?? null,
        posterUrl: item.cover_i
          ? `https://covers.openlibrary.org/b/id/${item.cover_i}-L.jpg`
          : null,
        rating: average > 0 ? roundOne(average * 2) : null,
        overview: authors.length > 0 ? `作者：${authors.join("、")}` : null,
        kind: "novel" as const,
        source: "Open Library",
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
    case "AI":
      return 1;
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
  "你是影视、动漫、小说元数据助手。根据用户给出的作品名称与类型，返回真实存在的元数据。" +
  "只输出一个 JSON 对象，不要输出 Markdown 代码块或解释文字。字段如下：" +
  "title（中文标题，字符串）、originalTitle（原名，字符串或 null）、year（首播或出版年份，整数或 null）、" +
  "rating（0 到 10 的评分，数字或 null）、overview（不超过 150 字的中文简介，字符串或 null）、" +
  "platform（主要播出或阅读平台，字符串或 null）、posterUrl（公开可访问的 http/https 封面图片地址，字符串或 null）。" +
  "不确定的字段一律填 null，禁止编造不存在的信息。";

function aiMediaLabel(mediaType?: MediaType): string {
  switch (mediaType) {
    case "anime":
      return "番剧";
    case "novel":
      return "小说";
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
  if (mediaType === "novel") return "novel";
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
  } else if (mediaType === "novel") {
    tasks.push(fetchWebBangumi(trimmed, 1, "novel"));
    tasks.push(fetchWebAniList(trimmed, "MANGA", "novel"));
    tasks.push(fetchWebOpenLibrary(trimmed));
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
