export type MediaType =
  | "drama"
  | "anime"
  | "variety"
  | "novel"
  | "movie"
  | "short_drama";

export type EntryStatus = "tracking" | "completed" | "dropped";

export interface MediaEntry {
  id: string;
  title: string;
  mediaType: MediaType;
  currentProgress: number;
  totalProgress: number | null;
  status: EntryStatus;
  season?: number | null;
  rating?: number | null;
  platform?: string | null;
  coverUrl?: string | null;
  overview?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportReport {
  imported: number;
  skipped: number;
  errors: string[];
  entries: MediaEntry[];
}

export interface AppSettings {
  tmdbApiKey: string;
  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;
  webdavEnabled: boolean;
  lastSyncedAt: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  tmdbApiKey: "",
  webdavUrl: "",
  webdavUsername: "",
  webdavPassword: "",
  webdavEnabled: false,
  lastSyncedAt: null,
};

export interface ScrapeCandidate {
  sourceId: number;
  title: string;
  originalTitle: string | null;
  year: number | null;
  posterUrl: string | null;
  rating: number | null;
  overview: string | null;
  kind: "movie" | "tv";
}

export interface EntryInput {
  title: string;
  mediaType: MediaType;
  currentProgress: number;
  totalProgress: number | null;
  status: EntryStatus;
  season?: number | null;
  rating?: number | null;
  platform?: string | null;
  coverUrl?: string | null;
  overview?: string | null;
}

export const MEDIA_TYPE_LABELS: Record<MediaType, string> = {
  drama: "剧集",
  anime: "番剧",
  variety: "综艺",
  novel: "小说",
  movie: "电影",
  short_drama: "短剧",
};

export const MEDIA_TYPE_UNITS: Record<MediaType, string> = {
  drama: "集",
  anime: "集",
  variety: "集",
  novel: "章",
  movie: "部",
  short_drama: "集",
};

export const ENTRY_STATUS_LABELS: Record<EntryStatus, string> = {
  tracking: "在追",
  completed: "已完成",
  dropped: "已弃剧",
};

export const PLATFORM_PRESETS = [
  "腾讯视频",
  "爱奇艺",
  "优酷",
  "芒果TV",
  "哔哩哔哩",
  "红果短剧",
  "Netflix",
  "其他",
] as const;
