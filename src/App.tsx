import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  adjustProgress,
  cacheCoverFromUrl,
  createEntry,
  deleteEntry,
  downloadExcelTemplate,
  emptyTrash,
  getLibraryErrorMessage,
  getSettings,
  importExcel,
  isTauri,
  listEntries,
  listTrash,
  purgeEntry,
  restoreEntry,
  saveCoverImage,
  saveSettings,
  searchTmdb,
  setEntryStatus,
  syncNow,
  updateEntry,
} from "./api";
import {
  DEFAULT_SETTINGS,
  ENTRY_STATUS_LABELS,
  LAYOUT_LABELS,
  MEDIA_TYPE_LABELS,
  MEDIA_TYPE_UNITS,
  PLATFORM_PRESETS,
  THEME_LABELS,
  type AppSettings,
  type EntryInput,
  type ImportReport,
  type LibraryView,
  type MediaEntry,
  type MediaType,
  type ScrapeCandidate,
  type SyncReport,
  type ThemeMode,
} from "./types";

type LibraryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; entries: MediaEntry[] };

type AppView = "library" | "trash";

type SyncPhase = "local" | "syncing" | "synced" | "error";

interface SyncState {
  phase: SyncPhase;
  lastSyncedAt: string | null;
  message?: string;
  report?: SyncReport;
}

const SYNC_DEBOUNCE_MS = 2000;

const syncClockFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function formatSyncClock(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : syncClockFormatter.format(parsed);
}

function getSyncLabel(settings: AppSettings, syncState: SyncState): string {
  if (!settings.webdavEnabled) {
    return "仅本地";
  }
  if (syncState.phase === "syncing") {
    return "同步中…";
  }
  if (syncState.phase === "synced") {
    const clock = formatSyncClock(syncState.lastSyncedAt);
    return clock ? `已同步 ${clock}` : "已同步";
  }
  if (syncState.phase === "error") {
    return "同步失败";
  }
  return "等待同步";
}

function getSyncErrorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return message.trim() || "WebDAV 同步失败，请检查设置后重试。";
}

const updatedAtFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const MEDIA_TYPE_ICONS: Record<MediaType, ReactNode> = {
  drama: (
    <>
      <rect x="4" y="6" width="16" height="14" rx="2.5" />
      <path d="m9 3 3 3 3-3M10 11l5 3-5 3V11Z" />
    </>
  ),
  anime: (
    <>
      <path d="m12 3 2.2 5.1L20 9l-4.2 3.8 1.2 5.7-5-3-5 3 1.2-5.7L4 9l5.8-.9L12 3Z" />
      <path d="M5 19.5h14" />
    </>
  ),
  variety: (
    <>
      <rect x="8" y="3" width="8" height="13" rx="4" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
    </>
  ),
  novel: (
    <>
      <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H11a2 2 0 0 1 2 2v17a3 3 0 0 0-3-3H4V4.5Z" />
      <path d="M20 4.5A2.5 2.5 0 0 0 17.5 2H13v19a3 3 0 0 1 3-3h4V4.5Z" />
    </>
  ),
  movie: (
    <>
      <path d="M4 9h16v11H4zM4 4h16v5H4zM8 4l3 5M14 4l3 5" />
    </>
  ),
  short_drama: (
    <>
      <rect x="8" y="3" width="8" height="18" rx="2.5" />
      <path d="m10.8 9 3.2 2-3.2 2V9ZM4.5 7.5H7M4.5 12H7M4.5 16.5H7M17 7.5h2.5M17 12h2.5M17 16.5h2.5" />
    </>
  ),
};

const MEDIA_TYPES = Object.keys(MEDIA_TYPE_LABELS) as MediaType[];
const ENTRY_STATUSES = ["tracking", "completed", "dropped", "to_watch"] as const;

function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span className="brand-mark" aria-hidden="true" style={{ width: size, height: size }}>
      <svg viewBox="0 0 32 32" fill="none">
        <path d="M9 7.5h11.5A2.5 2.5 0 0 1 23 10v15H11.5A3.5 3.5 0 0 1 8 21.5V8.5" />
        <path d="M9 7.5v13a4 4 0 0 1 4-4h10M13 12h5" />
        <path className="brand-mark__check" d="m17 17 2.2 2.2L24 14" />
      </svg>
    </span>
  );
}

function MediaTypeIcon({ type }: { type: MediaType }) {
  return (
    <svg
      className="media-type__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {MEDIA_TYPE_ICONS[type]}
    </svg>
  );
}

function EntryTile({
  type,
  coverUrl,
}: {
  type: MediaType;
  coverUrl?: string | null;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  const [failedCoverUrl, setFailedCoverUrl] = useState<string | null>(null);
  const showCover =
    Boolean(coverUrl) && !(coverFailed && failedCoverUrl === coverUrl);

  return (
    <span
      className={`entry__tile entry__tile--${type}${
        showCover ? " entry__tile--cover" : ""
      }`}
      aria-hidden="true"
    >
      {showCover && coverUrl ? (
        <img
          className="entry__cover"
          src={resolveCoverSrc(coverUrl)}
          alt=""
          loading="lazy"
          onError={() => {
            setFailedCoverUrl(coverUrl);
            setCoverFailed(true);
          }}
        />
      ) : (
        <MediaTypeIcon type={type} />
      )}
    </span>
  );
}

function LoadingState() {
  return (
    <div className="content-state content-state--loading" role="status" aria-live="polite">
      <div className="skeleton-list" aria-hidden="true">
        {[0, 1, 2, 3].map((row) => (
          <div className="skeleton-row" key={row}>
            <span className="skeleton skeleton--tile" />
            <span className="skeleton-lines">
              <span className="skeleton skeleton--title" />
              <span className="skeleton skeleton--meta" />
            </span>
            <span className="skeleton skeleton--bar" />
          </div>
        ))}
      </div>
      <p className="content-state__loading-text">正在整理你的内容库…</p>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="content-state content-state--empty">
      <span className="content-state__icon" aria-hidden="true">
        <svg viewBox="0 0 48 48" fill="none">
          <path d="M10 36.5h28" className="empty-shelf" />
          <rect x="13" y="14" width="9" height="22.5" rx="1.5" />
          <rect x="24" y="9" width="9" height="27.5" rx="1.5" />
          <path d="m35 15 5.5-1.6L44 35.5l-5.5 1.6L35 15Z" />
          <path d="M16.5 20h2.5M16.5 24h2.5M27.5 15h2.5M27.5 19h2.5" />
          <path d="m27.5 28 2 2 4-4.5" className="empty-check" />
        </svg>
      </span>
      <h3>内容库还是空的</h3>
      <p>好故事值得被记住。这里会安静地收下你的每一次追更。</p>
      <button className="primary-button" type="button" onClick={onAdd}>
        添加第一个条目
      </button>
    </div>
  );
}

function NoResultsState({ onClear }: { onClear: () => void }) {
  return (
    <div className="content-state content-state--no-results">
      <span className="content-state__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 5 5M8 10.5h5" />
        </svg>
      </span>
      <h3>没有找到匹配的条目</h3>
      <p>试试其他关键词或筛选条件，完整内容库不会受影响。</p>
      <button className="secondary-button" type="button" onClick={onClear}>
        清除搜索和筛选
      </button>
    </div>
  );
}

function TrashEmptyState() {
  return (
    <div className="content-state content-state--empty content-state--trash">
      <span className="content-state__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M4 6h16M9 3h6M6.5 6l.9 14h9.2l.9-14M10 10v6M14 10v6" />
        </svg>
      </span>
      <h3>回收站是空的</h3>
      <p>删除的条目会先放在这里，30 天后自动清除。</p>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="content-state content-state--error" role="alert">
      <span className="content-state__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M12 8v5M12 16.5v.5" />
          <path d="M10.3 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </svg>
      </span>
      <h3>内容库读取失败</h3>
      <p>{message}</p>
      <button className="secondary-button" type="button" onClick={onRetry}>
        重新加载
      </button>
    </div>
  );
}

interface DialogProps {
  title: string;
  titleId: string;
  busy?: boolean;
  active?: boolean;
  initialFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

function Dialog({
  title,
  titleId,
  busy = false,
  active = true,
  initialFocusRef,
  fallbackFocusRef,
  onClose,
  children,
  className = "",
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const fallbackFocus = fallbackFocusRef?.current;
    initialFocusRef.current?.focus();

    return () => {
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      } else {
        fallbackFocus?.focus();
      }
    };
  }, [active, fallbackFocusRef, initialFocusRef]);

  useEffect(() => {
    if (!active) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (!busy) {
          event.preventDefault();
          closeRef.current();
        }
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) {
        return;
      }

      const focusableElements = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getAttribute("aria-hidden") !== "true");
      const first = focusableElements[0];
      const last = focusableElements.at(-1);

      if (!first || !last) {
        event.preventDefault();
        return;
      }

      const activeElement = document.activeElement;
      if (!dialogRef.current.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, active]);

  return (
    <div
      className="dialog-backdrop"
      inert={!active}
      aria-hidden={active ? undefined : true}
      onMouseDown={(event) => {
        if (active && !busy && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={`dialog ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
      >
        <span className="dialog__grabber" aria-hidden="true" />
        <div className="dialog__header">
          <h2 id={titleId}>{title}</h2>
          <button
            className="icon-button dialog__close"
            type="button"
            aria-label="关闭对话框"
            disabled={busy}
            onClick={onClose}
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

type EditorState =
  | { mode: "create" }
  | { mode: "edit"; entry: MediaEntry }
  | null;

interface EntryFormValues {
  title: string;
  mediaType: MediaType;
  currentProgress: string;
  totalProgress: string;
  status: MediaEntry["status"];
  season: string;
  rating: string;
  platform: string;
  coverUrl: string;
  overview: string;
}

type EntryField =
  | "title"
  | "currentProgress"
  | "totalProgress"
  | "season"
  | "rating"
  | "platform"
  | "coverUrl"
  | "overview";
type EntryFormErrors = Partial<Record<EntryField | "form", string>>;

function getWriteErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("读取文件失败"));
        return;
      }
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function triggerBase64Download(
  base64: string,
  filename: string,
  mime: string,
): void {
  const dataUrl = `data:${mime};base64,${base64}`;
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** 远程链接直接使用，本地封面路径转换为 asset 协议地址。 */
function resolveCoverSrc(source: string): string {
  if (/^(https?:|data:|blob:)/i.test(source)) {
    return source;
  }
  try {
    return convertFileSrc(source);
  } catch {
    return source;
  }
}

function EntryFormDialog({
  editor,
  settings,
  settingsOpen,
  fallbackFocusRef,
  onOpenSettings,
  onClose,
  onSaved,
}: {
  editor: Exclude<EditorState, null>;
  settings: AppSettings;
  settingsOpen: boolean;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onOpenSettings: () => void;
  onClose: () => void;
  onSaved: (entry: MediaEntry) => void;
}) {
  const editingEntry = editor.mode === "edit" ? editor.entry : null;
  const [values, setValues] = useState<EntryFormValues>(() => ({
    title: editingEntry?.title ?? "",
    mediaType: editingEntry?.mediaType ?? "drama",
    currentProgress: editingEntry ? String(editingEntry.currentProgress) : "0",
    totalProgress: editingEntry?.totalProgress
      ? String(editingEntry.totalProgress)
      : "",
    status: editingEntry?.status ?? "tracking",
    season:
      editingEntry?.season !== null && editingEntry?.season !== undefined
        ? String(editingEntry.season)
        : "",
    rating:
      editingEntry?.rating !== null && editingEntry?.rating !== undefined
        ? String(editingEntry.rating)
        : "",
    platform: editingEntry?.platform ?? "",
    coverUrl: editingEntry?.coverUrl ?? "",
    overview: editingEntry?.overview ?? "",
  }));
  const [errors, setErrors] = useState<EntryFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [scrapeOpen, setScrapeOpen] = useState(false);
  const [importingCover, setImportingCover] = useState(false);
  const savingRef = useRef(false);
  const coverFileRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const currentProgressRef = useRef<HTMLInputElement>(null);
  const totalProgressRef = useRef<HTMLInputElement>(null);
  const seasonRef = useRef<HTMLInputElement>(null);
  const ratingRef = useRef<HTMLInputElement>(null);
  const platformRef = useRef<HTMLInputElement>(null);
  const coverUrlRef = useRef<HTMLInputElement>(null);
  const overviewRef = useRef<HTMLTextAreaElement>(null);
  const unit = MEDIA_TYPE_UNITS[values.mediaType];
  const titleId = "entry-form-title";

  function changeField<Field extends keyof EntryFormValues>(
    field: Field,
    value: EntryFormValues[Field],
  ) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({
      ...current,
      [field]: undefined,
      ...(field === "currentProgress" || field === "totalProgress"
        ? { currentProgress: undefined, totalProgress: undefined }
        : {}),
      form: undefined,
    }));
  }

  function applyScrapeCandidate(candidate: ScrapeCandidate) {
    const posterUrl = candidate.posterUrl ?? null;
    setValues((current) => ({
      ...current,
      title: current.title.trim() ? current.title : candidate.title,
      coverUrl: posterUrl ?? current.coverUrl,
      rating:
        candidate.rating !== null ? String(candidate.rating) : current.rating,
      overview: candidate.overview ?? current.overview,
    }));
    setErrors((current) => ({
      ...current,
      title: undefined,
      coverUrl: undefined,
      rating: undefined,
      overview: undefined,
      form: undefined,
    }));
    setScrapeOpen(false);

    // 刮削封面下载到本地缓存，后续直接从本地读取。
    if (posterUrl) {
      void cacheCoverFromUrl(posterUrl)
        .then((localPath) => {
          if (typeof localPath !== "string" || !localPath) {
            return;
          }
          setValues((current) =>
            current.coverUrl === posterUrl
              ? { ...current, coverUrl: localPath }
              : current,
          );
        })
        .catch(() => {
          // 缓存失败时保留远程链接，不阻断用户操作。
        });
    }
  }

  async function handleCoverFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      setErrors((current) => ({ ...current, coverUrl: "请选择图片文件。" }));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setErrors((current) => ({
        ...current,
        coverUrl: "封面图片不能超过 10MB。",
      }));
      return;
    }

    setImportingCover(true);
    try {
      const data = await readFileAsBase64(file);
      const extension = file.name.includes(".")
        ? file.name.split(".").pop()?.toLowerCase() ?? ""
        : "";
      const localPath = await saveCoverImage(data, extension);
      setValues((current) => ({ ...current, coverUrl: localPath }));
      setErrors((current) => ({
        ...current,
        coverUrl: undefined,
        form: undefined,
      }));
    } catch (error) {
      setErrors((current) => ({
        ...current,
        coverUrl: getWriteErrorMessage(error, "导入本地图片失败，请重试。"),
      }));
    } finally {
      setImportingCover(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current) {
      return;
    }

    const nextErrors: EntryFormErrors = {};
    const title = values.title.trim();
    const currentProgressText = values.currentProgress.trim();
    const totalProgressText = values.totalProgress.trim();
    const seasonText = values.season.trim();
    const ratingText = values.rating.trim();
    const platform = values.platform.trim();
    const coverUrl = values.coverUrl.trim();
    const overview = values.overview.trim();
    const currentProgress = Number(currentProgressText);
    const totalProgress = totalProgressText ? Number(totalProgressText) : null;

    if (!title) {
      nextErrors.title = "请输入标题。";
    }
    if (
      !/^\d+$/.test(currentProgressText) ||
      !Number.isSafeInteger(currentProgress)
    ) {
      nextErrors.currentProgress = "当前进度必须是非负整数。";
    }
    if (
      totalProgress !== null &&
      (!/^\d+$/.test(totalProgressText) ||
        !Number.isSafeInteger(totalProgress) ||
        totalProgress <= 0)
    ) {
      nextErrors.totalProgress = "总进度必须为空或正整数。";
    }
    if (
      !nextErrors.currentProgress &&
      !nextErrors.totalProgress &&
      totalProgress !== null &&
      currentProgress > totalProgress
    ) {
      nextErrors.currentProgress = "当前进度不能大于总进度。";
    }
    if (seasonText.length > 20) {
      nextErrors.season = "季不能超过 20 个字符。";
    }
    if (
      ratingText &&
      !/^(?:10(?:\.0)?|[0-9](?:\.[0-9])?)$/.test(ratingText)
    ) {
      nextErrors.rating = "评分必须是 0 到 10 之间的数字，且最多 1 位小数。";
    }
    if (
      coverUrl &&
      !/^https?:\/\//i.test(coverUrl) &&
      !/^[a-zA-Z]:[\\/]/.test(coverUrl) &&
      !coverUrl.startsWith("/")
    ) {
      nextErrors.coverUrl = "封面需为 http(s) 链接或本地图片。";
    }
    if (platform.length > 60) {
      nextErrors.platform = "平台名称不能超过 60 个字符。";
    }
    if (overview.length > 2000) {
      nextErrors.overview = "简介不能超过 2000 个字符。";
    }

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      const focusTargets: Array<
        [EntryField, RefObject<HTMLElement | null>]
      > = [
        ["title", titleRef],
        ["currentProgress", currentProgressRef],
        ["totalProgress", totalProgressRef],
        ["season", seasonRef],
        ["rating", ratingRef],
        ["coverUrl", coverUrlRef],
        ["platform", platformRef],
        ["overview", overviewRef],
      ];
      focusTargets.find(([field]) => nextErrors[field])?.[1].current?.focus();
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setErrors({});
    const input: EntryInput = {
      title,
      mediaType: values.mediaType,
      currentProgress,
      totalProgress,
      status: values.status,
      season: seasonText || null,
      rating: ratingText ? Number(ratingText) : null,
      platform: platform || null,
      coverUrl: coverUrl || null,
      overview: overview || null,
    };

    try {
      const savedEntry = editingEntry
        ? await updateEntry(editingEntry.id, input)
        : await createEntry(input);
      onSaved(savedEntry);
    } catch (error) {
      setErrors({
        form: getWriteErrorMessage(error, "保存条目失败，请重试。"),
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <>
      <Dialog
        title={editingEntry ? "编辑条目" : "添加条目"}
        titleId={titleId}
        busy={saving}
        active={!scrapeOpen && !settingsOpen}
        initialFocusRef={titleRef}
        fallbackFocusRef={fallbackFocusRef}
        onClose={onClose}
        className="dialog--form"
      >
      <form className="entry-form" noValidate onSubmit={handleSubmit}>
        <div className="dialog__body entry-form__body">
          {errors.form ? (
            <p className="form-error" role="alert">
              {errors.form}
            </p>
          ) : null}
          <fieldset className="entry-form__fields" disabled={saving}>
            <div className="form-field">
              <div className="entry-form__title-row">
                <label htmlFor="entry-title">标题</label>
                <button
                  className="link-button entry-form__scrape-button"
                  type="button"
                  disabled={saving}
                  onClick={() => setScrapeOpen(true)}
                >
                  从 TMDB 刮削
                </button>
              </div>
              <input
                id="entry-title"
                name="title"
                type="text"
                value={values.title}
                required
                placeholder="例如：漫长的季节"
                aria-invalid={errors.title ? true : undefined}
                aria-describedby={errors.title ? "entry-title-error" : undefined}
                ref={titleRef}
                onChange={(event) => changeField("title", event.target.value)}
              />
              {errors.title ? (
                <p className="field-error" id="entry-title-error">
                  {errors.title}
                </p>
              ) : null}
            </div>

            <div className="form-field">
              <label htmlFor="entry-media-type">类型</label>
              <select
                id="entry-media-type"
                name="mediaType"
                value={values.mediaType}
                onChange={(event) => {
                  const mediaType = event.target.value as MediaType;
                  setValues((current) => ({
                    ...current,
                    mediaType,
                    totalProgress:
                      mediaType === "movie" && !current.totalProgress.trim()
                        ? "1"
                        : current.totalProgress,
                  }));
                  setErrors((current) => ({
                    ...current,
                    currentProgress: undefined,
                    totalProgress: undefined,
                    form: undefined,
                  }));
                }}
              >
                {MEDIA_TYPES.map((mediaType) => (
                  <option key={mediaType} value={mediaType}>
                    {MEDIA_TYPE_LABELS[mediaType]}
                  </option>
                ))}
              </select>
            </div>

            <div className="entry-form__progress-row">
              <div className="form-field">
                <label htmlFor="entry-current-progress">
                  当前进度（{unit}）
                </label>
                <input
                  id="entry-current-progress"
                  name="currentProgress"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="1"
                  value={values.currentProgress}
                  required
                  aria-invalid={errors.currentProgress ? true : undefined}
                  aria-describedby={
                    errors.currentProgress
                      ? "entry-current-progress-error"
                      : undefined
                  }
                  ref={currentProgressRef}
                  onChange={(event) =>
                    changeField("currentProgress", event.target.value)
                  }
                />
                {errors.currentProgress ? (
                  <p className="field-error" id="entry-current-progress-error">
                    {errors.currentProgress}
                  </p>
                ) : null}
              </div>

              <div className="form-field">
                <label htmlFor="entry-total-progress">
                  总进度（{unit}，选填）
                </label>
                <input
                  id="entry-total-progress"
                  name="totalProgress"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  value={values.totalProgress}
                  aria-invalid={errors.totalProgress ? true : undefined}
                  aria-describedby={`entry-total-progress-hint${
                    errors.totalProgress ? " entry-total-progress-error" : ""
                  }`}
                  ref={totalProgressRef}
                  onChange={(event) =>
                    changeField("totalProgress", event.target.value)
                  }
                />
                <p className="field-hint" id="entry-total-progress-hint">
                  留空表示总进度未知
                </p>
                {errors.totalProgress ? (
                  <p className="field-error" id="entry-total-progress-error">
                    {errors.totalProgress}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="form-field">
              <label htmlFor="entry-status">状态</label>
              <select
                id="entry-status"
                name="status"
                value={values.status}
                onChange={(event) =>
                  changeField(
                    "status",
                    event.target.value as EntryFormValues["status"],
                  )
                }
              >
                {ENTRY_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {ENTRY_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>

            <div className="entry-form__progress-row">
              <div className="form-field">
                <label htmlFor="entry-season">季</label>
                <input
                  id="entry-season"
                  name="season"
                  type="text"
                  maxLength={20}
                  placeholder="如 1、年番"
                  value={values.season}
                  aria-invalid={errors.season ? true : undefined}
                  aria-describedby={
                    errors.season ? "entry-season-error" : undefined
                  }
                  ref={seasonRef}
                  onChange={(event) =>
                    changeField("season", event.target.value)
                  }
                />
                {errors.season ? (
                  <p className="field-error" id="entry-season-error">
                    {errors.season}
                  </p>
                ) : (
                  <p className="field-hint">选填，可填数字或自定义文本</p>
                )}
              </div>

              <div className="form-field">
                <label htmlFor="entry-platform">平台</label>
                <input
                  id="entry-platform"
                  name="platform"
                  type="text"
                  list="entry-platform-options"
                  maxLength={60}
                  placeholder="如 腾讯视频"
                  value={values.platform}
                  aria-invalid={errors.platform ? true : undefined}
                  aria-describedby={
                    errors.platform ? "entry-platform-error" : undefined
                  }
                  ref={platformRef}
                  onChange={(event) =>
                    changeField("platform", event.target.value)
                  }
                />
                <datalist id="entry-platform-options">
                  {PLATFORM_PRESETS.map((platform) => (
                    <option key={platform} value={platform} />
                  ))}
                </datalist>
                {errors.platform ? (
                  <p className="field-error" id="entry-platform-error">
                    {errors.platform}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="entry-form__progress-row">
              <div className="form-field">
                <label htmlFor="entry-rating">评分</label>
                <input
                  id="entry-rating"
                  name="rating"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="10"
                  step="0.1"
                  placeholder="如 8.6"
                  value={values.rating}
                  aria-invalid={errors.rating ? true : undefined}
                  aria-describedby={
                    errors.rating ? "entry-rating-error" : undefined
                  }
                  ref={ratingRef}
                  onChange={(event) =>
                    changeField("rating", event.target.value)
                  }
                />
                {errors.rating ? (
                  <p className="field-error" id="entry-rating-error">
                    {errors.rating}
                  </p>
                ) : (
                  <p className="field-hint">选填，0–10，最多 1 位小数</p>
                )}
              </div>

              <div className="form-field">
                <label htmlFor="entry-cover-url">封面</label>
                <div className="cover-picker">
                  <input
                    id="entry-cover-url"
                    name="coverUrl"
                    type="text"
                    placeholder="https://… 或选择本地图片"
                    value={values.coverUrl}
                    aria-invalid={errors.coverUrl ? true : undefined}
                    aria-describedby={
                      errors.coverUrl ? "entry-cover-url-error" : undefined
                    }
                    ref={coverUrlRef}
                    onChange={(event) =>
                      changeField("coverUrl", event.target.value)
                    }
                  />
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={saving || importingCover}
                    onClick={() => coverFileRef.current?.click()}
                  >
                    {importingCover ? "导入中…" : "本地图片"}
                  </button>
                  <input
                    ref={coverFileRef}
                    className="cover-picker__file"
                    type="file"
                    accept="image/*"
                    aria-label="选择本地封面图片"
                    onChange={(event) => {
                      void handleCoverFile(event);
                    }}
                  />
                </div>
                {errors.coverUrl ? (
                  <p className="field-error" id="entry-cover-url-error">
                    {errors.coverUrl}
                  </p>
                ) : (
                  <p className="field-hint">选填，支持链接或本地图片</p>
                )}
                {values.coverUrl ? (
                  <img
                    className="cover-picker__preview"
                    src={resolveCoverSrc(values.coverUrl)}
                    alt="封面预览"
                  />
                ) : null}
              </div>
            </div>

            <div className="form-field">
              <label htmlFor="entry-overview">简介</label>
              <textarea
                id="entry-overview"
                name="overview"
                rows={3}
                maxLength={2000}
                placeholder="选填，最多 2000 字"
                value={values.overview}
                aria-invalid={errors.overview ? true : undefined}
                aria-describedby={
                  errors.overview ? "entry-overview-error" : undefined
                }
                ref={overviewRef}
                onChange={(event) =>
                  changeField("overview", event.target.value)
                }
              />
              {errors.overview ? (
                <p className="field-error" id="entry-overview-error">
                  {errors.overview}
                </p>
              ) : null}
            </div>
          </fieldset>
        </div>
        <div className="dialog__actions">
          <button
            className="secondary-button"
            type="button"
            disabled={saving}
            onClick={onClose}
          >
            取消
          </button>
          <button className="primary-button" type="submit" disabled={saving}>
            {saving
              ? "保存中…"
              : editingEntry
                ? "保存修改"
                : "添加条目"}
          </button>
        </div>
      </form>
      </Dialog>

      {scrapeOpen ? (
        <ScrapeDialog
          initialTitle={values.title}
          mediaType={values.mediaType}
          settings={settings}
          active={!settingsOpen}
          fallbackFocusRef={fallbackFocusRef}
          onClose={() => setScrapeOpen(false)}
          onOpenSettings={onOpenSettings}
          onSelect={applyScrapeCandidate}
        />
      ) : null}
    </>
  );
}

function DeleteEntryDialog({
  entry,
  fallbackFocusRef,
  onClose,
  onDeleted,
}: {
  entry: MediaEntry;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deletingRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function handleDelete() {
    if (deletingRef.current) {
      return;
    }

    deletingRef.current = true;
    setDeleting(true);
    setError(null);
    try {
      await deleteEntry(entry.id);
      onDeleted(entry.id);
    } catch (deleteError) {
      setError(getWriteErrorMessage(deleteError, "删除条目失败，请重试。"));
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  return (
    <Dialog
      title="删除条目"
      titleId="delete-entry-title"
      busy={deleting}
      initialFocusRef={cancelRef}
      fallbackFocusRef={fallbackFocusRef}
      onClose={onClose}
      className="dialog--confirm"
    >
      <div className="dialog__body">
        <p className="dialog__description">
          确定要删除<strong className="delete-entry__title">《{entry.title}》</strong>
          吗？删除后可在回收站中找回。
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="dialog__actions">
        <button
          className="secondary-button"
          type="button"
          disabled={deleting}
          ref={cancelRef}
          onClick={onClose}
        >
          取消
        </button>
        <button
          className="danger-button"
          type="button"
          disabled={deleting}
          onClick={() => {
            void handleDelete();
          }}
        >
          {deleting ? "删除中…" : "确认删除"}
        </button>
      </div>
    </Dialog>
  );
}

function ConfirmActionDialog({
  title,
  titleId,
  description,
  confirmLabel,
  busyLabel,
  fallbackError,
  fallbackFocusRef,
  onClose,
  onConfirm,
}: {
  title: string;
  titleId: string;
  description: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  fallbackError: string;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function handleConfirm() {
    if (busyRef.current) {
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (actionError) {
      setError(getWriteErrorMessage(actionError, fallbackError));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={title}
      titleId={titleId}
      busy={busy}
      initialFocusRef={cancelRef}
      fallbackFocusRef={fallbackFocusRef}
      onClose={onClose}
      className="dialog--confirm"
    >
      <div className="dialog__body">
        <p className="dialog__description">{description}</p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="dialog__actions">
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          ref={cancelRef}
          onClick={onClose}
        >
          取消
        </button>
        <button
          className="danger-button"
          type="button"
          disabled={busy}
          onClick={() => {
            void handleConfirm();
          }}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

function ImportExcelDialog({
  fallbackFocusRef,
  onClose,
  onImported,
}: {
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onImported: () => void;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [dataBase64, setDataBase64] = useState<string | null>(null);
  const [defaultMediaType, setDefaultMediaType] = useState<MediaType>("drama");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);
  const importingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleId = "import-excel-title";

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    try {
      const base64 = await readFileAsBase64(file);
      setFileName(file.name);
      setDataBase64(base64);
      setReport(null);
      setError(null);
    } catch {
      setError("读取文件失败，请重试。");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (importingRef.current) {
      return;
    }
    if (!dataBase64) {
      setReport(null);
      setError("请先选择一个 Excel 或 CSV 文件。");
      fileInputRef.current?.focus();
      return;
    }

    importingRef.current = true;
    setImporting(true);
    setReport(null);
    setError(null);
    try {
      const result = await importExcel(dataBase64, defaultMediaType);
      setReport(result);
      onImported();
    } catch (importError) {
      setError(getWriteErrorMessage(importError, "导入失败，请重试。"));
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }

  async function handleDownloadTemplate() {
    if (downloadingTemplate) {
      return;
    }
    setDownloadingTemplate(true);
    setError(null);
    setTemplateNotice(null);
    try {
      const base64 = await downloadExcelTemplate();
      if (isTauri()) {
        triggerBase64Download(
          base64,
          "追更导入模板.xlsx",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
      } else {
        triggerBase64Download(base64, "追更导入模板.csv", "text/csv;charset=utf-8");
      }
      setTemplateNotice("模板已下载，请到下载目录查看。");
    } catch {
      setError("下载模板失败，请重试。");
    } finally {
      setDownloadingTemplate(false);
    }
  }

  return (
    <Dialog
      title="导入 Excel"
      titleId={titleId}
      busy={importing}
      initialFocusRef={fileInputRef}
      fallbackFocusRef={fallbackFocusRef}
      onClose={onClose}
      className="dialog--import"
    >
      <form className="import-form" noValidate onSubmit={handleSubmit}>
        <div className="dialog__body">
          <div className="import-help">
            <p>支持 .xlsx / .xls / .csv 文件。</p>
            <p>
              建议先<strong>下载模板</strong>，按列填写标题、类型、季、当前进度、总进度、平台与评分后再导入。
            </p>
            <p className="import-help__hint">未标明类型的行将使用下方默认类型。</p>
          </div>

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}

          {templateNotice ? (
            <p className="form-success" role="status">
              {templateNotice}
            </p>
          ) : null}

          <fieldset className="import-form__fields" disabled={importing}>
            <div className="form-field">
              <label htmlFor="import-excel-file">选择文件</label>
              <input
                id="import-excel-file"
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(event) => {
                  void handleFileChange(event);
                }}
              />
              {fileName ? (
                <p className="field-hint">已选择：{fileName}</p>
              ) : null}
            </div>

            <div className="form-field">
              <label htmlFor="import-default-media-type">默认类型</label>
              <select
                id="import-default-media-type"
                value={defaultMediaType}
                onChange={(event) =>
                  setDefaultMediaType(event.target.value as MediaType)
                }
              >
                {MEDIA_TYPES.map((mediaType) => (
                  <option key={mediaType} value={mediaType}>
                    {MEDIA_TYPE_LABELS[mediaType]}
                  </option>
                ))}
              </select>
              <p className="field-hint">文件中未标明类型时使用</p>
            </div>

            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                void handleDownloadTemplate();
              }}
              disabled={downloadingTemplate}
            >
              {downloadingTemplate ? "下载中…" : "下载模板"}
            </button>
          </fieldset>

          {report ? (
            <div className="import-report" role="status">
              <p className="import-report__summary">
                成功导入 {report.imported} 条，跳过 {report.skipped} 条。
              </p>
              {report.errors.length > 0 ? (
                <>
                  <p className="import-report__label">未导入的行：</p>
                  <ul className="import-report__errors" aria-label="导入错误">
                    {report.errors.map((message, index) => (
                      <li key={`${index}-${message}`}>{message}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="dialog__actions">
          <button
            className="secondary-button"
            type="button"
            disabled={importing}
            onClick={onClose}
          >
            关闭
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={importing || !dataBase64}
          >
            {importing ? "导入中…" : "开始导入"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function SettingsDialog({
  settings,
  syncState,
  fallbackFocusRef,
  onClose,
  onSaved,
  onSyncNow,
}: {
  settings: AppSettings;
  syncState: SyncState;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: (settings: AppSettings) => void;
  onSyncNow: () => void;
}) {
  const [values, setValues] = useState<AppSettings>(() => ({ ...settings }));
  const [errors, setErrors] = useState<
    Partial<
      Record<"tmdbApiKey" | "webdavUrl" | "webdavUsername" | "form", string>
    >
  >({});
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const savingRef = useRef(false);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const webdavUrlRef = useRef<HTMLInputElement>(null);
  const webdavUsernameRef = useRef<HTMLInputElement>(null);
  const titleId = "settings-title";
  const syncing = syncState.phase === "syncing";
  const lastSyncedLabel = settings.lastSyncedAt
    ? updatedAtFormatter.format(new Date(settings.lastSyncedAt))
    : "尚未同步";

  useEffect(() => {
    setValues((current) =>
      current.lastSyncedAt === settings.lastSyncedAt
        ? current
        : { ...current, lastSyncedAt: settings.lastSyncedAt },
    );
  }, [settings.lastSyncedAt]);

  function changeValue<Field extends keyof AppSettings>(
    field: Field,
    value: AppSettings[Field],
  ) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined, form: undefined }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current) {
      return;
    }

    const nextErrors: typeof errors = {};
    const webdavUrl = values.webdavUrl.trim();
    if (webdavUrl && !/^https?:\/\//i.test(webdavUrl)) {
      nextErrors.webdavUrl = "服务器地址必须以 http:// 或 https:// 开头。";
    }
    if (values.webdavEnabled && !webdavUrl) {
      nextErrors.webdavUrl = "启用自动同步时请填写服务器地址。";
    }
    if (values.webdavEnabled && !values.webdavUsername.trim()) {
      nextErrors.webdavUsername = "启用自动同步时请填写用户名。";
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      if (nextErrors.webdavUrl) {
        webdavUrlRef.current?.focus();
      } else if (nextErrors.webdavUsername) {
        webdavUsernameRef.current?.focus();
      }
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setErrors({});
    try {
      const saved = await saveSettings({
        ...values,
        lastSyncedAt: settings.lastSyncedAt,
      });
      onSaved(saved);
    } catch (error) {
      setErrors({
        form: getWriteErrorMessage(error, "保存设置失败，请重试。"),
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog
      title="设置"
      titleId={titleId}
      busy={saving}
      initialFocusRef={apiKeyRef}
      fallbackFocusRef={fallbackFocusRef}
      onClose={onClose}
      className="dialog--settings"
    >
      <form className="settings-form" noValidate onSubmit={handleSubmit}>
        <div className="dialog__body settings-form__body">
          {errors.form ? (
            <p className="form-error" role="alert">
              {errors.form}
            </p>
          ) : null}

          <section
            className="settings-section"
            aria-labelledby="settings-appearance-heading"
          >
            <div className="settings-section__heading">
              <h3 id="settings-appearance-heading">外观</h3>
              <p>选择应用主题；列表/网格布局在内容库顶部工具栏切换。</p>
            </div>
            <div className="settings-section__fields">
              <div className="form-field">
                <label htmlFor="settings-theme-group">主题</label>
                <div
                  id="settings-theme-group"
                  className="layout-toggle"
                  role="group"
                  aria-label="主题"
                >
                  {(Object.keys(THEME_LABELS) as ThemeMode[]).map(
                    (themeKey) => (
                      <button
                        key={themeKey}
                        className="layout-toggle__option"
                        type="button"
                        aria-pressed={values.theme === themeKey}
                        onClick={() => changeValue("theme", themeKey)}
                      >
                        {THEME_LABELS[themeKey]}
                      </button>
                    ),
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="settings-tmdb-heading">
            <div className="settings-section__heading">
              <h3 id="settings-tmdb-heading">TMDB 元数据</h3>
              <p>用于在添加或编辑条目时刮削标题、封面、评分与简介。</p>
            </div>
            <div className="settings-section__fields">
              <div className="form-field">
                <label htmlFor="settings-tmdb-api-key">TMDB API Key</label>
                <div className="password-field">
                  <input
                    id="settings-tmdb-api-key"
                    type={showApiKey ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={200}
                    value={values.tmdbApiKey}
                    aria-invalid={errors.tmdbApiKey ? true : undefined}
                    aria-describedby="settings-tmdb-api-key-hint"
                    ref={apiKeyRef}
                    onChange={(event) =>
                      changeValue("tmdbApiKey", event.target.value)
                    }
                  />
                  <button
                    className="secondary-button password-field__toggle"
                    type="button"
                    aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                    onClick={() => setShowApiKey((current) => !current)}
                  >
                    {showApiKey ? "隐藏" : "显示"}
                  </button>
                </div>
                <p className="field-hint" id="settings-tmdb-api-key-hint">
                  在 themoviedb.org 免费申请，保存后立即生效。
                </p>
                {errors.tmdbApiKey ? (
                  <p className="field-error">{errors.tmdbApiKey}</p>
                ) : null}
              </div>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="settings-webdav-heading">
            <div className="settings-section__heading">
              <h3 id="settings-webdav-heading">WebDAV 同步</h3>
              <p>按更新时间合并不同设备的内容库，删除操作会通过回收站同步。</p>
            </div>
            <div className="settings-section__fields">
              <div className="form-field">
                <label htmlFor="settings-webdav-url">服务器地址</label>
                <input
                  id="settings-webdav-url"
                  type="url"
                  inputMode="url"
                  maxLength={500}
                  placeholder="https://dav.example.com/catchup"
                  value={values.webdavUrl}
                  aria-invalid={errors.webdavUrl ? true : undefined}
                  aria-describedby={
                    errors.webdavUrl ? "settings-webdav-url-error" : undefined
                  }
                  ref={webdavUrlRef}
                  onChange={(event) =>
                    changeValue("webdavUrl", event.target.value)
                  }
                />
                {errors.webdavUrl ? (
                  <p className="field-error" id="settings-webdav-url-error">
                    {errors.webdavUrl}
                  </p>
                ) : null}
              </div>

              <div className="settings-section__row">
                <div className="form-field">
                  <label htmlFor="settings-webdav-username">用户名</label>
                  <input
                    id="settings-webdav-username"
                    type="text"
                    autoComplete="username"
                    maxLength={200}
                    value={values.webdavUsername}
                    aria-invalid={
                      errors.webdavUsername ? true : undefined
                    }
                    aria-describedby={
                      errors.webdavUsername
                        ? "settings-webdav-username-error"
                        : undefined
                    }
                    ref={webdavUsernameRef}
                    onChange={(event) =>
                      changeValue("webdavUsername", event.target.value)
                    }
                  />
                  {errors.webdavUsername ? (
                    <p
                      className="field-error"
                      id="settings-webdav-username-error"
                    >
                      {errors.webdavUsername}
                    </p>
                  ) : null}
                </div>

                <div className="form-field">
                  <label htmlFor="settings-webdav-password">密码</label>
                  <input
                    id="settings-webdav-password"
                    type="password"
                    autoComplete="current-password"
                    maxLength={500}
                    value={values.webdavPassword}
                    onChange={(event) =>
                      changeValue("webdavPassword", event.target.value)
                    }
                  />
                </div>
              </div>

              <label className="settings-checkbox" htmlFor="settings-webdav-enabled">
                <input
                  id="settings-webdav-enabled"
                  type="checkbox"
                  checked={values.webdavEnabled}
                  onChange={(event) =>
                    changeValue("webdavEnabled", event.target.checked)
                  }
                />
                <span>启用 WebDAV 自动同步</span>
              </label>

              <div className="settings-sync">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!settings.webdavEnabled || syncing}
                  onClick={onSyncNow}
                >
                  {syncing ? "同步中…" : "立即同步"}
                </button>
                <p className="field-hint">
                  修改服务器信息后请先保存设置，再立即同步。
                </p>
              </div>
              {syncState.phase === "synced" && syncState.report ? (
                <p className="settings-sync-result" role="status">
                  同步完成：合并 {syncState.report.merged} 项，上传{" "}
                  {syncState.report.uploaded} 项，下载{" "}
                  {syncState.report.downloaded} 项。
                </p>
              ) : null}
              {syncState.phase === "error" && syncState.message ? (
                <p className="settings-sync-result settings-sync-result--error" role="alert">
                  {syncState.message}
                </p>
              ) : null}

              <div className="form-field">
                <label htmlFor="settings-last-synced">上次同步</label>
                <input
                  id="settings-last-synced"
                  type="text"
                  readOnly
                  value={lastSyncedLabel}
                />
              </div>
            </div>
          </section>
        </div>

        <div className="dialog__actions">
          <button
            className="secondary-button"
            type="button"
            disabled={saving}
            onClick={onClose}
          >
            取消
          </button>
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? "保存中…" : "保存设置"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ScrapeResultCard({
  candidate,
  onSelect,
}: {
  candidate: ScrapeCandidate;
  onSelect: () => void;
}) {
  const [posterFailed, setPosterFailed] = useState(false);
  const fallbackType: MediaType = candidate.kind === "movie" ? "movie" : "drama";

  return (
    <article className="scrape-result" aria-label={candidate.title}>
      <span
        className={`entry__tile scrape-result__poster${
          candidate.posterUrl && !posterFailed ? " entry__tile--cover" : ` entry__tile--${fallbackType}`
        }`}
        aria-hidden="true"
      >
        {candidate.posterUrl && !posterFailed ? (
          <img
            className="entry__cover"
            src={candidate.posterUrl}
            alt=""
            loading="lazy"
            onError={() => setPosterFailed(true)}
          />
        ) : (
          <MediaTypeIcon type={fallbackType} />
        )}
      </span>

      <div className="scrape-result__body">
        <div className="scrape-result__title-row">
          <h3>{candidate.title}</h3>
          {candidate.rating !== null ? (
            <span className="scrape-result__rating">
              评分 {candidate.rating.toFixed(1)}
            </span>
          ) : null}
        </div>
        <p className="scrape-result__meta">
          {candidate.originalTitle && candidate.originalTitle !== candidate.title
            ? candidate.originalTitle
            : null}
          {candidate.originalTitle &&
          candidate.originalTitle !== candidate.title &&
          candidate.year
            ? " · "
            : null}
          {candidate.year ? `${candidate.year} 年` : null}
          {!candidate.originalTitle &&
          !candidate.year &&
          !candidate.overview
            ? "暂无更多信息"
            : null}
        </p>
        {candidate.overview ? (
          <p className="scrape-result__overview">{candidate.overview}</p>
        ) : null}
        <button
          className="secondary-button scrape-result__use"
          type="button"
          onClick={onSelect}
        >
          使用此结果
        </button>
      </div>
    </article>
  );
}

function ScrapeDialog({
  initialTitle,
  mediaType,
  settings,
  active,
  fallbackFocusRef,
  onClose,
  onOpenSettings,
  onSelect,
}: {
  initialTitle: string;
  mediaType: MediaType;
  settings: AppSettings;
  active: boolean;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onOpenSettings: () => void;
  onSelect: (candidate: ScrapeCandidate) => void;
}) {
  const [query, setQuery] = useState(initialTitle);
  const [results, setResults] = useState<ScrapeCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const searchingRef = useRef(false);
  const queryRef = useRef<HTMLInputElement>(null);
  const titleId = "scrape-tmdb-title";
  const missingApiKey = !settings.tmdbApiKey.trim();
  const novelUnsupported = mediaType === "novel";
  const visibleError = missingApiKey
    ? "请先在设置中填写 TMDB API Key"
    : novelUnsupported
      ? "小说暂不支持 TMDB 刮削"
      : error;
  const canSearch = !searching && !missingApiKey && !novelUnsupported;

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (searchingRef.current) {
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setSearched(false);
      setError("请输入要搜索的标题");
      queryRef.current?.focus();
      return;
    }

    searchingRef.current = true;
    setSearching(true);
    setError(null);
    setSearched(false);
    try {
      const candidates = await searchTmdb(trimmed, mediaType);
      setResults(candidates);
      setSearched(true);
    } catch (searchError) {
      setResults([]);
      setError(getWriteErrorMessage(searchError, "搜索 TMDB 失败，请重试。"));
    } finally {
      searchingRef.current = false;
      setSearching(false);
    }
  }

  return (
    <Dialog
      title="从 TMDB 刮削"
      titleId={titleId}
      active={active}
      initialFocusRef={queryRef}
      fallbackFocusRef={fallbackFocusRef}
      onClose={onClose}
      className="dialog--scrape"
    >
      <form className="scrape-form" noValidate onSubmit={handleSearch}>
        <div className="dialog__body">
          <div className="scrape-search-row">
            <div className="form-field">
              <label htmlFor="scrape-tmdb-query">搜索标题</label>
              <input
                id="scrape-tmdb-query"
                type="search"
                value={query}
                placeholder="输入电影或剧集名称"
                ref={queryRef}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setError(null);
                }}
              />
            </div>
            <button
              className="primary-button scrape-search-row__submit"
              type="submit"
              disabled={!canSearch}
            >
              {searching ? "搜索中…" : "搜索"}
            </button>
          </div>
          <p className="field-hint">
            {mediaType === "movie"
              ? "按电影搜索，结果来自 TMDB。"
              : "按剧集搜索，结果来自 TMDB。平台需要手动填写。"}
          </p>

          {visibleError ? (
            <div className="scrape-error" role="alert">
              <p>{visibleError}</p>
              <button
                className="link-button"
                type="button"
                onClick={onOpenSettings}
              >
                打开设置
              </button>
            </div>
          ) : null}

          {searching ? (
            <p className="scrape-empty" role="status">
              正在搜索 TMDB…
            </p>
          ) : results.length > 0 ? (
            <ul className="scrape-results" aria-label="TMDB 搜索结果">
              {results.map((candidate) => (
                <li key={`${candidate.kind}-${candidate.sourceId}`}>
                  <ScrapeResultCard
                    candidate={candidate}
                    onSelect={() => onSelect(candidate)}
                  />
                </li>
              ))}
            </ul>
          ) : searched && !visibleError ? (
            <p className="scrape-empty">没有找到匹配的结果，试试其他关键词。</p>
          ) : null}
        </div>

        <div className="dialog__actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Sidebar({
  entries,
  view,
  trashCount,
  statusFilter,
  mediaTypeFilter,
  syncLabel,
  syncPhase,
  onStatusFilter,
  onMediaTypeFilter,
  onOpenTrash,
  onImport,
  onOpenSettings,
}: {
  entries: MediaEntry[];
  view: AppView;
  trashCount: number;
  statusFilter: MediaEntry["status"] | "all";
  mediaTypeFilter: MediaType | "all";
  syncLabel: string;
  syncPhase: SyncPhase;
  onStatusFilter: (status: MediaEntry["status"] | "all") => void;
  onMediaTypeFilter: (type: MediaType | "all") => void;
  onOpenTrash: () => void;
  onImport: () => void;
  onOpenSettings: () => void;
}) {
  const counts = useMemo(() => {
    const byType = Object.fromEntries(
      MEDIA_TYPES.map((type) => [type, 0]),
    ) as Record<MediaType, number>;
    let completed = 0;
    let tracking = 0;
    let toWatch = 0;
    for (const entry of entries) {
      byType[entry.mediaType] += 1;
      if (entry.status === "completed") {
        completed += 1;
      } else if (entry.status === "tracking") {
        tracking += 1;
      } else if (entry.status === "to_watch") {
        toWatch += 1;
      }
    }
    return { byType, completed, tracking, toWatch };
  }, [entries]);

  return (
    <aside className="sidebar" aria-label="侧边栏">
      <div className="sidebar__brand">
        <BrandMark size={26} />
        <div className="sidebar__brand-text">
          <strong>追更</strong>
          <span>CatchUp</span>
        </div>
      </div>

      <nav className="sidebar__nav" aria-label="内容库导航">
        <p className="sidebar__section">内容库</p>
        <button
          className="sidebar__item"
          type="button"
          aria-pressed={view === "library" && statusFilter === "all"}
          onClick={() => onStatusFilter("all")}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" />
          </svg>
          <span className="sidebar__label">全部条目</span>
          <span className="sidebar__count">{entries.length}</span>
        </button>
        <button
          className="sidebar__item"
          type="button"
          aria-pressed={view === "library" && statusFilter === "to_watch"}
          onClick={() => onStatusFilter("to_watch")}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M5 5.5h10a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 13V7A1.5 1.5 0 0 1 5 5.5Z" />
            <path d="m8 8.2 4.5 1.8-4.5 1.8v-3.6Z" />
          </svg>
          <span className="sidebar__label">待看</span>
          <span className="sidebar__count">{counts.toWatch}</span>
        </button>
        <button
          className="sidebar__item"
          type="button"
          aria-pressed={view === "library" && statusFilter === "tracking"}
          onClick={() => onStatusFilter("tracking")}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="7" />
            <path d="m8.5 7 4.5 3-4.5 3V7Z" />
          </svg>
          <span className="sidebar__label">正在追更</span>
          <span className="sidebar__count">{counts.tracking}</span>
        </button>
        <button
          className="sidebar__item"
          type="button"
          aria-pressed={view === "library" && statusFilter === "completed"}
          onClick={() => onStatusFilter("completed")}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="7" />
            <path d="m7 10 2.2 2.2L13.5 8" />
          </svg>
          <span className="sidebar__label">已看完</span>
          <span className="sidebar__count">{counts.completed}</span>
        </button>

        <p className="sidebar__section">按类型</p>
        {MEDIA_TYPES.map((type) => (
          <button
            className="sidebar__item"
            type="button"
            key={type}
            aria-pressed={view === "library" && mediaTypeFilter === type}
            onClick={() =>
              onMediaTypeFilter(mediaTypeFilter === type ? "all" : type)
            }
          >
            <span className={`sidebar__type-dot sidebar__type-dot--${type}`} aria-hidden="true" />
            <span className="sidebar__label">{MEDIA_TYPE_LABELS[type]}</span>
            <span className="sidebar__count">{counts.byType[type]}</span>
          </button>
        ))}

        <p className="sidebar__section">回收站</p>
        <button
          className="sidebar__item"
          type="button"
          aria-pressed={view === "trash"}
          onClick={onOpenTrash}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M3.5 5.5h13M8 3h4M5.5 5.5 6.2 17h7.6l.7-11.5M8.3 8.5v5M11.7 8.5v5" />
          </svg>
          <span className="sidebar__label">回收站</span>
          <span className="sidebar__count">{trashCount}</span>
        </button>
      </nav>

      <div className="sidebar__footer">
        <button
          className="sidebar__import"
          type="button"
          aria-label="导入 Excel"
          onClick={onImport}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M10 3v8m0 0 3-3m-3 3L7 8M4 14v1.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V14" />
          </svg>
          <span>导入 Excel</span>
        </button>
        <button
          className="sidebar__import sidebar__settings"
          type="button"
          aria-label="设置"
          onClick={onOpenSettings}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="2.6" />
            <path d="M10 3.2v1.6M10 15.2v1.6M3.2 10h1.6M15.2 10h1.6M5.2 5.2l1.1 1.1M13.7 13.7l1.1 1.1M14.8 5.2l-1.1 1.1M6.3 13.7l-1.1 1.1" />
          </svg>
          <span>设置</span>
        </button>
        <div className="sidebar__db-status">
          <span className="sidebar__db-dot" aria-hidden="true" />
          <span>本地数据库 · 离线可用</span>
          <button
            className={`sidebar__sync sidebar__sync--${syncPhase}`}
            type="button"
            aria-label={`同步状态：${syncLabel}，打开设置`}
            title={syncLabel}
            onClick={onOpenSettings}
          >
            <span className="sidebar__sync-dot" aria-hidden="true" />
            <span>{syncLabel}</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

function SummaryStrip({ entries }: { entries: MediaEntry[] }) {
  const completedCount = entries.filter(
    (entry) => entry.status === "completed",
  ).length;
  const trackingCount = entries.filter(
    (entry) => entry.status === "tracking",
  ).length;

  return (
    <section className="summary-strip" aria-label="内容库摘要">
      <div className="summary-strip__item">
        <span className="summary-strip__label">条目总数</span>
        <strong className="summary-strip__value">{entries.length}</strong>
        <span className="summary-strip__suffix">项</span>
      </div>
      <div className="summary-strip__item summary-strip__item--tracking">
        <span className="summary-strip__label">正在追更</span>
        <strong className="summary-strip__value">{trackingCount}</strong>
        <span className="summary-strip__suffix">项在追</span>
      </div>
      <div className="summary-strip__item summary-strip__item--completed">
        <span className="summary-strip__label">已经看完</span>
        <strong className="summary-strip__value">{completedCount}</strong>
        <span className="summary-strip__suffix">项完成</span>
      </div>
    </section>
  );
}

function getProgressPercentage(entry: MediaEntry): number | null {
  const { currentProgress, totalProgress } = entry;

  if (totalProgress === null || totalProgress <= 0) {
    return null;
  }

  return Math.min(
    100,
    Math.max(0, Math.round((currentProgress / totalProgress) * 100)),
  );
}

function formatProgress(entry: MediaEntry): string {
  const unit = MEDIA_TYPE_UNITS[entry.mediaType];
  const total =
    entry.totalProgress !== null && entry.totalProgress > 0
      ? ` / ${entry.totalProgress}`
      : "";

  return `${entry.currentProgress}${total} ${unit}`;
}

function formatRating(rating: number): string {
  return `★ ${rating.toFixed(1)}`;
}

type EntryWriteAction =
  | { type: "progress"; delta: 1 | -1 }
  | { type: "status"; status: MediaEntry["status"] };

function EntryRow({
  entry,
  pending,
  pendingLabel = "正在更新",
  error,
  onWrite,
  onEdit,
  onDelete,
  trashActions,
}: {
  entry: MediaEntry;
  pending: boolean;
  pendingLabel?: string;
  error: string | null;
  onWrite?: (action: EntryWriteAction) => void;
  onEdit?: () => void;
  onDelete?: () => void;
  trashActions?: { onRestore: () => void; onPurge: () => void };
}) {
  const percentage = getProgressPercentage(entry);
  const titleId = `entry-title-${entry.id}`;
  const decrementDisabled = pending || entry.currentProgress === 0;
  const incrementDisabled =
    pending ||
    (entry.totalProgress !== null &&
      entry.currentProgress >= entry.totalProgress);

  return (
    <li className="entry-list__item">
      <article
        className={`entry entry--${entry.mediaType}`}
        aria-labelledby={titleId}
        aria-busy={pending}
        onDoubleClick={(event) => {
          if (!onEdit || (event.target as HTMLElement).closest("button")) {
            return;
          }
          onEdit();
        }}
      >
        <EntryTile type={entry.mediaType} coverUrl={entry.coverUrl} />

        <div className="entry__body">
          <div className="entry__headline">
            <h3 className="entry__title" id={titleId}>
              {entry.title}
            </h3>
            <span className={`status-pill status-pill--${entry.status}`}>
              <span className="status-pill__dot" aria-hidden="true" />
              {ENTRY_STATUS_LABELS[entry.status]}
            </span>
          </div>
          <div className="entry__meta">
            <span className="entry__type-label">
              {MEDIA_TYPE_LABELS[entry.mediaType]}
            </span>
            {entry.season !== null && entry.season !== undefined ? (
              <>
                <span className="entry__dot" aria-hidden="true">·</span>
                <span className="entry__season">
                  {/^\d+$/.test(entry.season)
                    ? `第 ${entry.season} 季`
                    : entry.season}
                </span>
              </>
            ) : null}
            {entry.rating !== null && entry.rating !== undefined ? (
              <>
                <span className="entry__dot" aria-hidden="true">·</span>
                <span className="entry__rating">{formatRating(entry.rating)}</span>
              </>
            ) : null}
            {entry.platform ? (
              <>
                <span className="entry__dot" aria-hidden="true">·</span>
                <span className="entry__platform">{entry.platform}</span>
              </>
            ) : null}
            <span className="entry__dot" aria-hidden="true">·</span>
            <time className="entry__time" dateTime={entry.updatedAt}>
              更新于 {updatedAtFormatter.format(new Date(entry.updatedAt))}
            </time>
          </div>
          {pending ? (
            <p className="entry__write-status" role="status">
              {pendingLabel}《{entry.title}》…
            </p>
          ) : null}
          {error ? (
            <p className="entry__write-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="entry__progress">
          <span className="entry__progress-value">{formatProgress(entry)}</span>
          {percentage === null ? (
            <span className="entry__unknown">总进度未知</span>
          ) : (
            <div className="entry__bar-row">
              <div
                className="entry__bar"
                role="progressbar"
                aria-label={`${entry.title}的观看或阅读进度`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percentage}
              >
                <span style={{ width: `${percentage}%` }} />
              </div>
              <span className="entry__percentage">{percentage}%</span>
            </div>
          )}
        </div>

        <div className="entry__actions">
          {trashActions ? (
            <div className="entry__trash-actions">
              <button
                className="secondary-button entry__restore-button"
                type="button"
                aria-label={`恢复《${entry.title}》`}
                disabled={pending}
                onClick={trashActions.onRestore}
              >
                恢复
              </button>
              <button
                className="ghost-button ghost-button--danger"
                type="button"
                aria-label={`彻底删除《${entry.title}》`}
                disabled={pending}
                onClick={trashActions.onPurge}
              >
                彻底删除
              </button>
            </div>
          ) : (
            <>
              <div
                className="stepper"
                role="group"
                aria-label={`${entry.title}的快捷操作`}
              >
                <button
                  className="stepper__button"
                  type="button"
                  aria-label={`《${entry.title}》进度减一`}
                  disabled={decrementDisabled}
                  onClick={() => onWrite?.({ type: "progress", delta: -1 })}
                >
                  −
                </button>
                <button
                  className="stepper__button"
                  type="button"
                  aria-label={`《${entry.title}》进度加一`}
                  disabled={incrementDisabled}
                  onClick={() => onWrite?.({ type: "progress", delta: 1 })}
                >
                  +
                </button>
              </div>
              <button
                className="ghost-button"
                type="button"
                aria-label={
                  entry.status === "to_watch"
                    ? `开始追更《${entry.title}》`
                    : entry.status === "completed"
                      ? `重新追更《${entry.title}》`
                      : `标记《${entry.title}》完成`
                }
                disabled={pending}
                onClick={() =>
                  onWrite?.({
                    type: "status",
                    status:
                      entry.status === "to_watch" ||
                      entry.status === "completed"
                        ? "tracking"
                        : "completed",
                  })
                }
              >
                {entry.status === "to_watch"
                  ? "开始追更"
                  : entry.status === "completed"
                    ? "重新追更"
                    : "标记完成"}
              </button>
              <div className="entry__icon-actions">
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`编辑《${entry.title}》`}
                  title="编辑"
                  disabled={pending}
                  onClick={onEdit}
                >
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="m12.8 3.8 3.4 3.4M4 16l1-4L14 3a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2l-9 9-4 1Z" />
                  </svg>
                </button>
                <button
                  className="icon-button icon-button--danger"
                  type="button"
                  aria-label={`删除《${entry.title}》`}
                  title="删除"
                  disabled={pending}
                  onClick={onDelete}
                >
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M3 5h14M8 2.5h4M6 5l.7 12h6.6L14 5M8.5 8v6M11.5 8v6" />
                  </svg>
                </button>
              </div>
            </>
          )}
        </div>
      </article>
    </li>
  );
}

function sortEntries(entries: MediaEntry[]): MediaEntry[] {
  return [...entries].sort(
    (first, second) =>
      second.updatedAt.localeCompare(first.updatedAt) ||
      first.id.localeCompare(second.id),
  );
}

function App() {
  const [library, setLibrary] = useState<LibraryState>({ status: "loading" });
  const [view, setView] = useState<AppView>("library");
  const [trash, setTrash] = useState<LibraryState>({ status: "loading" });
  const [editor, setEditor] = useState<EditorState>(null);
  const [pendingDeletion, setPendingDeletion] = useState<MediaEntry | null>(
    null,
  );
  const [pendingPurge, setPendingPurge] = useState<MediaEntry | null>(null);
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => ({
    ...DEFAULT_SETTINGS,
  }));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>({
    phase: "local",
    lastSyncedAt: null,
  });
  const [pendingEntryWrites, setPendingEntryWrites] = useState<Set<string>>(
    () => new Set(),
  );
  const [entryWriteErrors, setEntryWriteErrors] = useState<
    Record<string, string>
  >({});
  const [pendingTrashWrites, setPendingTrashWrites] = useState<Set<string>>(
    () => new Set(),
  );
  const [trashWriteErrors, setTrashWriteErrors] = useState<
    Record<string, string>
  >({});
  const [titleQuery, setTitleQuery] = useState("");
  const [mediaTypeFilter, setMediaTypeFilter] = useState<MediaType | "all">(
    "all",
  );
  const [statusFilter, setStatusFilter] = useState<
    MediaEntry["status"] | "all"
  >("all");
  const latestRequest = useRef(0);
  const trashRequest = useRef(0);
  const entryWriteLocks = useRef(new Set<string>());
  const trashWriteLocks = useRef(new Set<string>());
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dialogOpenRef = useRef(false);
  const settingsRef = useRef(settings);
  const syncTimerRef = useRef<number | null>(null);
  const syncInFlightRef = useRef(false);
  const syncQueuedRef = useRef(false);
  const initialSyncRequestedRef = useRef(false);
  const performSyncRef = useRef<() => Promise<void>>(async () => {});
  const scheduleSyncRef = useRef<() => void>(() => {});
  settingsRef.current = settings;

  dialogOpenRef.current =
    editor !== null ||
    pendingDeletion !== null ||
    pendingPurge !== null ||
    emptyTrashOpen ||
    importOpen ||
    settingsOpen;

  function handleEntryUpdated(updatedEntry: MediaEntry) {
    setLibrary((current) => ({
      status: "success",
      entries: sortEntries([
        updatedEntry,
        ...(current.status === "success"
          ? current.entries.filter((entry) => entry.id !== updatedEntry.id)
          : []),
      ]),
    }));
    setEntryWriteErrors((current) => {
      const next = { ...current };
      delete next[updatedEntry.id];
      return next;
    });
    scheduleSyncRef.current();
  }

  function handleSaved(savedEntry: MediaEntry) {
    handleEntryUpdated(savedEntry);
    setEditor(null);
  }

  function handleSettingsSaved(saved: AppSettings) {
    setSettings(saved);
    setSettingsOpen(false);
    setSettingsNotice("设置已保存");
    if (!saved.webdavEnabled) {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      syncQueuedRef.current = false;
      setSyncState({ phase: "local", lastSyncedAt: saved.lastSyncedAt });
    } else {
      setSyncState((current) => ({
        ...current,
        lastSyncedAt: current.lastSyncedAt ?? saved.lastSyncedAt,
      }));
    }
  }

  async function handleLibraryViewChange(nextView: LibraryView) {
    const previous = settingsRef.current;
    if (previous.libraryView === nextView) {
      return;
    }
    setSettings((current) => ({ ...current, libraryView: nextView }));
    try {
      const saved = await saveSettings({ ...previous, libraryView: nextView });
      setSettings(saved);
    } catch {
      setSettings((current) => ({
        ...current,
        libraryView: previous.libraryView,
      }));
    }
  }

  async function handleEntryWrite(
    entry: MediaEntry,
    action: EntryWriteAction,
  ) {
    if (entryWriteLocks.current.has(entry.id)) {
      return;
    }

    entryWriteLocks.current.add(entry.id);
    setPendingEntryWrites((current) => new Set(current).add(entry.id));
    setEntryWriteErrors((current) => {
      const next = { ...current };
      delete next[entry.id];
      return next;
    });

    try {
      const updatedEntry =
        action.type === "progress"
          ? await adjustProgress(entry.id, action.delta)
          : await setEntryStatus(entry.id, action.status);
      handleEntryUpdated(updatedEntry);
    } catch (writeError) {
      setEntryWriteErrors((current) => ({
        ...current,
        [entry.id]: `更新《${entry.title}》失败。${getWriteErrorMessage(
          writeError,
          "请重试。",
        )}`,
      }));
    } finally {
      entryWriteLocks.current.delete(entry.id);
      setPendingEntryWrites((current) => {
        const next = new Set(current);
        next.delete(entry.id);
        return next;
      });
    }
  }

  function handleDeleted(id: string) {
    setLibrary((current) =>
      current.status === "success"
        ? {
            status: "success",
            entries: current.entries.filter((entry) => entry.id !== id),
          }
        : current,
    );
    setPendingDeletion(null);
    scheduleSyncRef.current();
    void loadTrash();
  }

  const loadEntries = useCallback(async () => {
    const requestId = ++latestRequest.current;
    setLibrary({ status: "loading" });

    try {
      const entries = await listEntries();
      if (requestId === latestRequest.current) {
        setLibrary({ status: "success", entries });
      }
    } catch (error) {
      if (requestId === latestRequest.current) {
        setLibrary({
          status: "error",
          message: getLibraryErrorMessage(error),
        });
      }
    }
  }, []);

  const loadTrash = useCallback(async () => {
    const requestId = ++trashRequest.current;
    setTrash({ status: "loading" });

    try {
      const entries = await listTrash();
      if (requestId === trashRequest.current) {
        setTrash({ status: "success", entries });
      }
    } catch (error) {
      if (requestId === trashRequest.current) {
        setTrash({
          status: "error",
          message: getLibraryErrorMessage(error),
        });
      }
    }
  }, []);

  const scheduleSync = useCallback(() => {
    if (!settingsRef.current.webdavEnabled) {
      return;
    }
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
    }
    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      void performSyncRef.current();
    }, SYNC_DEBOUNCE_MS);
  }, []);

  const performSync = useCallback(async () => {
    if (!settingsRef.current.webdavEnabled) {
      return;
    }
    if (syncInFlightRef.current) {
      syncQueuedRef.current = true;
      return;
    }
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }

    syncInFlightRef.current = true;
    setSyncState((current) => ({
      ...current,
      phase: "syncing",
      message: undefined,
      report: undefined,
    }));

    try {
      const report = await syncNow();
      setSyncState({
        phase: "synced",
        lastSyncedAt: report.lastSyncedAt,
        report,
      });
      setSettings((current) => ({
        ...current,
        lastSyncedAt: report.lastSyncedAt,
      }));
      await Promise.all([loadEntries(), loadTrash()]);
    } catch (error) {
      setSyncState({
        phase: "error",
        lastSyncedAt: settingsRef.current.lastSyncedAt,
        message: getSyncErrorMessage(error),
      });
    } finally {
      syncInFlightRef.current = false;
      if (syncQueuedRef.current) {
        syncQueuedRef.current = false;
        scheduleSyncRef.current();
      }
    }
  }, [loadEntries, loadTrash]);

  useEffect(() => {
    performSyncRef.current = performSync;
    scheduleSyncRef.current = scheduleSync;
  }, [performSync, scheduleSync]);

  useEffect(
    () => () => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (!settingsLoaded) {
      return;
    }
    if (initialSyncRequestedRef.current) {
      return;
    }
    initialSyncRequestedRef.current = true;
    if (settings.webdavEnabled) {
      void performSyncRef.current();
    }
  }, [settingsLoaded, settings.webdavEnabled]);

  async function handleRestore(entry: MediaEntry) {
    if (trashWriteLocks.current.has(entry.id)) {
      return;
    }

    trashWriteLocks.current.add(entry.id);
    setPendingTrashWrites((current) => new Set(current).add(entry.id));
    setTrashWriteErrors((current) => {
      const next = { ...current };
      delete next[entry.id];
      return next;
    });

    try {
      const restoredEntry = await restoreEntry(entry.id);
      setTrash((current) =>
        current.status === "success"
          ? {
              status: "success",
              entries: current.entries.filter((item) => item.id !== entry.id),
            }
          : current,
      );
      handleEntryUpdated(restoredEntry);
    } catch (writeError) {
      setTrashWriteErrors((current) => ({
        ...current,
        [entry.id]: `恢复《${entry.title}》失败。${getWriteErrorMessage(
          writeError,
          "请重试。",
        )}`,
      }));
    } finally {
      trashWriteLocks.current.delete(entry.id);
      setPendingTrashWrites((current) => {
        const next = new Set(current);
        next.delete(entry.id);
        return next;
      });
    }
  }

  async function handlePurge() {
    if (!pendingPurge) {
      return;
    }

    const target = pendingPurge;
    await purgeEntry(target.id);
    setTrash((current) =>
      current.status === "success"
        ? {
            status: "success",
            entries: current.entries.filter((entry) => entry.id !== target.id),
          }
        : current,
    );
    setTrashWriteErrors((current) => {
      const next = { ...current };
      delete next[target.id];
      return next;
    });
    setPendingPurge(null);
    scheduleSyncRef.current();
  }

  async function handleEmptyTrash() {
    await emptyTrash();
    setTrash({ status: "success", entries: [] });
    setTrashWriteErrors({});
    setEmptyTrashOpen(false);
    scheduleSyncRef.current();
  }

  useEffect(() => {
    void loadEntries();
    void loadTrash();

    return () => {
      latestRequest.current += 1;
      trashRequest.current += 1;
    };
  }, [loadEntries, loadTrash]);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((loaded) => {
        if (!cancelled) {
          setSettings(loaded);
          setSyncState({
            phase: "local",
            lastSyncedAt: loaded.lastSyncedAt,
          });
          setSettingsLoaded(true);
        }
      })
      .catch(() => {
        // 设置读取失败时保持默认值，打开设置后可重新保存。
        if (!cancelled) {
          setSettingsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsNotice) {
      return;
    }
    const timer = window.setTimeout(() => setSettingsNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [settingsNotice]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        if (!dialogOpenRef.current) {
          setEditor({ mode: "create" });
        }
      } else if (key === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function applyTheme() {
      const resolved: "light" | "dark" =
        settings.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : settings.theme;
      document.documentElement.dataset.theme = resolved;
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) {
        meta.setAttribute(
          "content",
          resolved === "dark" ? "#15171c" : "#f4f6ef",
        );
      }
      if ("__TAURI_INTERNALS__" in window) {
        import("@tauri-apps/api/window")
          .then(({ getCurrentWindow }) =>
            getCurrentWindow().setTheme(
              settings.theme === "system" ? null : resolved,
            ),
          )
          .catch(() => {
            // 原生标题栏主题同步失败不阻塞界面渲染。
          });
      }
    }
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [settings.theme]);

  const isTrashView = view === "trash";
  const normalizedTitleQuery = titleQuery.trim().toLowerCase();
  const allEntries = library.status === "success" ? library.entries : [];
  const trashEntries = trash.status === "success" ? trash.entries : [];
  const sourceEntries = isTrashView ? trashEntries : allEntries;
  const hasActiveFilters =
    normalizedTitleQuery.length > 0 ||
    mediaTypeFilter !== "all" ||
    (!isTrashView && statusFilter !== "all");
  const visibleEntries = sourceEntries.filter(
    (entry) =>
      entry.title.toLowerCase().includes(normalizedTitleQuery) &&
      (mediaTypeFilter === "all" || entry.mediaType === mediaTypeFilter) &&
      (isTrashView ||
        statusFilter === "all" ||
        entry.status === statusFilter),
  );
  const syncLabel = getSyncLabel(settings, syncState);

  function clearFilters() {
    setTitleQuery("");
    setMediaTypeFilter("all");
    setStatusFilter("all");
  }

  return (
    <div className="app-shell">
      <Sidebar
        entries={allEntries}
        view={view}
        trashCount={trashEntries.length}
        statusFilter={statusFilter}
        mediaTypeFilter={mediaTypeFilter}
        syncLabel={syncLabel}
        syncPhase={syncState.phase}
        onStatusFilter={(status) => {
          setView("library");
          setStatusFilter((current) => (current === status ? "all" : status));
        }}
        onMediaTypeFilter={(type) => {
          setView("library");
          setMediaTypeFilter(type);
        }}
        onOpenTrash={() => setView("trash")}
        onImport={() => setImportOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="app-main">
        <header className="topbar">
          <div
            className="mobile-brand"
            aria-label={isTrashView ? "回收站" : "追更 CatchUp"}
          >
            <BrandMark size={24} />
            <strong>{isTrashView ? "回收站" : "追更"}</strong>
          </div>

          <div className="topbar__title">
            <h1>{isTrashView ? "回收站" : "内容库"}</h1>
            <p>
              {isTrashView
                ? trash.status === "success"
                  ? `${trashEntries.length} 个条目`
                  : "回收站"
                : library.status === "success"
                  ? `${library.entries.length} 个条目`
                  : "本地收藏"}
            </p>
          </div>

          <div className="search-field">
            <label className="sr-only" htmlFor="library-title-query">
              搜索标题
            </label>
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m12.5 12.5 4 4" />
            </svg>
            <input
              id="library-title-query"
              ref={searchInputRef}
              type="search"
              value={titleQuery}
              placeholder="搜索标题"
              autoComplete="off"
              onChange={(event) => setTitleQuery(event.target.value)}
            />
          </div>

          <div className="filter-row">
            <label className="sr-only" htmlFor="library-media-type-filter">
              类型筛选
            </label>
            <select
              id="library-media-type-filter"
              className="compact-select"
              value={mediaTypeFilter}
              onChange={(event) =>
                setMediaTypeFilter(event.target.value as MediaType | "all")
              }
            >
              <option value="all">全部类型</option>
              {MEDIA_TYPES.map((mediaType) => (
                <option key={mediaType} value={mediaType}>
                  {MEDIA_TYPE_LABELS[mediaType]}
                </option>
              ))}
            </select>

            {!isTrashView ? (
              <>
                <label className="sr-only" htmlFor="library-status-filter">
                  状态筛选
                </label>
                <select
                  id="library-status-filter"
                  className="compact-select"
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(
                      event.target.value as MediaEntry["status"] | "all",
                    )
                  }
                >
                  <option value="all">全部状态</option>
                  {ENTRY_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {ENTRY_STATUS_LABELS[status]}
                    </option>
                  ))}
                </select>

                <div
                  className="layout-toggle"
                  role="group"
                  aria-label="内容库布局"
                >
                  {(Object.keys(LAYOUT_LABELS) as LibraryView[]).map(
                    (viewKey) => (
                      <button
                        key={viewKey}
                        className="layout-toggle__option"
                        type="button"
                        aria-pressed={settings.libraryView === viewKey}
                        onClick={() => handleLibraryViewChange(viewKey)}
                      >
                        {LAYOUT_LABELS[viewKey]}
                      </button>
                    ),
                  )}
                </div>
              </>
            ) : null}

            {hasActiveFilters && visibleEntries.length > 0 ? (
              <button
                className="link-button"
                type="button"
                onClick={clearFilters}
              >
                清除搜索和筛选
              </button>
            ) : null}
          </div>

          <div className="topbar__actions">
            <button
              className={`sync-chip topbar__sync-chip sync-chip--${syncState.phase}`}
              type="button"
              aria-label={`WebDAV 同步状态：${syncLabel}，打开设置`}
              title={syncLabel}
              onClick={() => setSettingsOpen(true)}
            >
              <span className="sync-chip__dot" aria-hidden="true" />
              <span className="sync-chip__label">{syncLabel}</span>
            </button>
            <button
              className="icon-button topbar__import-button"
              type="button"
              aria-label="导入 Excel"
              onClick={() => setImportOpen(true)}
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M10 3v8m0 0 3-3m-3 3L7 8M4 14v1.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V14" />
              </svg>
            </button>
            <button
              className="icon-button topbar__trash-button"
              type="button"
              aria-label="回收站"
              aria-pressed={isTrashView}
              onClick={() =>
                setView((current) =>
                  current === "trash" ? "library" : "trash",
                )
              }
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M3.5 5.5h13M8 3h4M5.5 5.5 6.2 17h7.6l.7-11.5M8.3 8.5v5M11.7 8.5v5" />
              </svg>
            </button>

            <button
              className="icon-button topbar__settings-button"
              type="button"
              aria-label="设置"
              onClick={() => setSettingsOpen(true)}
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <circle cx="10" cy="10" r="2.6" />
                <path d="M10 3.2v1.6M10 15.2v1.6M3.2 10h1.6M15.2 10h1.6M5.2 5.2l1.1 1.1M13.7 13.7l1.1 1.1M14.8 5.2l-1.1 1.1M6.3 13.7l-1.1 1.1" />
              </svg>
            </button>

            {!isTrashView ? (
              <button
                className="primary-button add-button"
                type="button"
                ref={addButtonRef}
                aria-label="添加条目"
                disabled={library.status === "loading"}
                onClick={() => setEditor({ mode: "create" })}
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M10 4v12M4 10h12" />
                </svg>
                <span>添加条目</span>
              </button>
            ) : null}
          </div>
        </header>

        <div className="app-content">
          {isTrashView ? (
            <>
              <div className="trash-toolbar">
                <p className="trash-toolbar__count">
                  {trash.status === "success"
                    ? `${trashEntries.length} 个条目`
                    : "回收站"}
                </p>
                <button
                  className="danger-outline-button"
                  type="button"
                  disabled={
                    trash.status !== "success" || trashEntries.length === 0
                  }
                  onClick={() => setEmptyTrashOpen(true)}
                >
                  清空回收站
                </button>
              </div>
              <p className="trash-note">
                回收站中的条目会在 30 天后自动清除
              </p>

              {trash.status === "loading" ? (
                <LoadingState />
              ) : trash.status === "error" ? (
                <ErrorState
                  message={trash.message}
                  onRetry={() => {
                    void loadTrash();
                  }}
                />
              ) : trashEntries.length === 0 ? (
                <TrashEmptyState />
              ) : visibleEntries.length > 0 ? (
                <ul className="entry-list" aria-label="回收站列表">
                  {visibleEntries.map((entry) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      pending={pendingTrashWrites.has(entry.id)}
                      pendingLabel="正在恢复"
                      error={trashWriteErrors[entry.id] ?? null}
                      trashActions={{
                        onRestore: () => {
                          void handleRestore(entry);
                        },
                        onPurge: () => setPendingPurge(entry),
                      }}
                    />
                  ))}
                </ul>
              ) : (
                <NoResultsState onClear={clearFilters} />
              )}
            </>
          ) : (
            <>
              {library.status === "success" && library.entries.length > 0 ? (
                <SummaryStrip entries={library.entries} />
              ) : null}

              {library.status === "loading" ? (
                <LoadingState />
              ) : library.status === "error" ? (
                <ErrorState
                  message={library.message}
                  onRetry={() => {
                    void loadEntries();
                  }}
                />
              ) : library.entries.length === 0 ? (
                <EmptyState onAdd={() => setEditor({ mode: "create" })} />
              ) : visibleEntries.length > 0 ? (
                <ul
                  className={`entry-list${
                    settings.libraryView === "grid" ? " entry-list--grid" : ""
                  }`}
                  aria-label="追更内容列表"
                >
                  {visibleEntries.map((entry) => (
                    <EntryRow
                      entry={entry}
                      key={entry.id}
                      pending={pendingEntryWrites.has(entry.id)}
                      error={entryWriteErrors[entry.id] ?? null}
                      onWrite={(action) => {
                        void handleEntryWrite(entry, action);
                      }}
                      onEdit={() => setEditor({ mode: "edit", entry })}
                      onDelete={() => setPendingDeletion(entry)}
                    />
                  ))}
                </ul>
              ) : (
                <NoResultsState onClear={clearFilters} />
              )}
            </>
          )}
        </div>

        <footer className="statusbar">
          <span>
            {isTrashView
              ? trash.status === "success"
                ? `回收站 ${trashEntries.length} 项 · 30 天后自动清除`
                : "回收站"
              : library.status === "success"
                ? `共 ${library.entries.length} 项 · 已保存到本机`
                : "追更 · CatchUp"}
          </span>
          <span className="statusbar__hints">
            <kbd>Ctrl</kbd>+<kbd>N</kbd> 新建
            <span className="statusbar__sep" aria-hidden="true" />
            <kbd>Ctrl</kbd>+<kbd>F</kbd> 搜索
            <span className="statusbar__sep" aria-hidden="true" />
            双击条目可编辑
          </span>
        </footer>
      </div>

      <nav className="tabbar" aria-label="主导航">
        <button
          className="tabbar__item"
          type="button"
          aria-pressed={view === "library" && statusFilter === "all"}
          onClick={() => {
            setView("library");
            setStatusFilter("all");
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 6.5h16M4 12h16M4 17.5h16" />
          </svg>
          <span>内容库</span>
        </button>
        <button
          className="tabbar__item"
          type="button"
          aria-pressed={view === "library" && statusFilter === "to_watch"}
          onClick={() => {
            setView("library");
            setStatusFilter("to_watch");
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5.5 6.5h13a1.8 1.8 0 0 1 1.8 1.8v7.4a1.8 1.8 0 0 1-1.8 1.8h-13A1.8 1.8 0 0 1 3.7 15.7V8.3A1.8 1.8 0 0 1 5.5 6.5Z" />
            <path d="m9.8 9.7 5 2.3-5 2.3v-4.6Z" />
          </svg>
          <span>待看</span>
        </button>
        <button
          className="tabbar__item"
          type="button"
          aria-pressed={view === "library" && statusFilter === "tracking"}
          onClick={() => {
            setView("library");
            setStatusFilter("tracking");
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" />
            <path d="m10 8.5 5 3.5-5 3.5v-7Z" />
          </svg>
          <span>在追</span>
        </button>
        <button
          className="tabbar__item"
          type="button"
          aria-pressed={view === "library" && statusFilter === "completed"}
          onClick={() => {
            setView("library");
            setStatusFilter("completed");
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" />
            <path d="m8.5 12 2.6 2.6 4.6-5" />
          </svg>
          <span>已完成</span>
        </button>
      </nav>

      {editor ? (
        <EntryFormDialog
          key={editor.mode === "edit" ? editor.entry.id : "create"}
          editor={editor}
          settings={settings}
          settingsOpen={settingsOpen}
          fallbackFocusRef={addButtonRef}
          onOpenSettings={() => setSettingsOpen(true)}
          onClose={() => setEditor(null)}
          onSaved={handleSaved}
        />
      ) : null}
      {pendingDeletion ? (
        <DeleteEntryDialog
          entry={pendingDeletion}
          fallbackFocusRef={addButtonRef}
          onClose={() => setPendingDeletion(null)}
          onDeleted={handleDeleted}
        />
      ) : null}
      {pendingPurge ? (
        <ConfirmActionDialog
          title="彻底删除条目"
          titleId="purge-entry-title"
          description={
            <>
              确定要彻底删除
              <strong className="delete-entry__title">
                《{pendingPurge.title}》
              </strong>
              吗？删除后将无法恢复。
            </>
          }
          confirmLabel="彻底删除"
          busyLabel="删除中…"
          fallbackError="彻底删除失败，请重试。"
          fallbackFocusRef={addButtonRef}
          onClose={() => setPendingPurge(null)}
          onConfirm={handlePurge}
        />
      ) : null}
      {importOpen ? (
        <ImportExcelDialog
          fallbackFocusRef={addButtonRef}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            void loadEntries();
            scheduleSyncRef.current();
          }}
        />
      ) : null}
      {emptyTrashOpen ? (
        <ConfirmActionDialog
          title="清空回收站"
          titleId="empty-trash-title"
          description={`清空回收站会彻底删除其中的 ${trashEntries.length} 个条目，且无法恢复。确定继续吗？`}
          confirmLabel="清空回收站"
          busyLabel="清空中…"
          fallbackError="清空回收站失败，请重试。"
          fallbackFocusRef={addButtonRef}
          onClose={() => setEmptyTrashOpen(false)}
          onConfirm={handleEmptyTrash}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsDialog
          settings={settings}
          syncState={syncState}
          fallbackFocusRef={addButtonRef}
          onClose={() => setSettingsOpen(false)}
          onSaved={handleSettingsSaved}
          onSyncNow={() => {
            void performSyncRef.current();
          }}
        />
      ) : null}
      {settingsNotice ? (
        <div className="app-toast" role="status">
          {settingsNotice}
        </div>
      ) : null}
    </div>
  );
}

export default App;
