export type MediaType = "drama" | "anime" | "variety" | "novel" | "movie";

export type EntryStatus = "tracking" | "completed";

export interface MediaEntry {
  id: string;
  title: string;
  mediaType: MediaType;
  currentProgress: number;
  totalProgress: number | null;
  status: EntryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EntryInput {
  title: string;
  mediaType: MediaType;
  currentProgress: number;
  totalProgress: number | null;
  status: EntryStatus;
}

export const MEDIA_TYPE_LABELS: Record<MediaType, string> = {
  drama: "剧集",
  anime: "番剧",
  variety: "综艺",
  novel: "小说",
  movie: "电影",
};

export const MEDIA_TYPE_UNITS: Record<MediaType, string> = {
  drama: "集",
  anime: "集",
  variety: "集",
  novel: "章",
  movie: "部",
};

export const ENTRY_STATUS_LABELS: Record<EntryStatus, string> = {
  tracking: "在追",
  completed: "已完成",
};
