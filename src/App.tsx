import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  adjustProgress,
  createEntry,
  deleteEntry,
  getLibraryErrorMessage,
  listEntries,
  setEntryStatus,
  updateEntry,
} from "./api";
import {
  ENTRY_STATUS_LABELS,
  MEDIA_TYPE_LABELS,
  MEDIA_TYPE_UNITS,
  type MediaEntry,
  type MediaType,
} from "./types";

type LibraryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; entries: MediaEntry[] };

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
};

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
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
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {MEDIA_TYPE_ICONS[type]}
    </svg>
  );
}

function LoadingState() {
  return (
    <div className="library-state" role="status" aria-live="polite">
      <span className="loading-spinner" aria-hidden="true" />
      <h3>正在整理你的内容库</h3>
      <p>稍等片刻，把上次的故事进度找回来。</p>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="library-state library-state--empty">
      <svg
        className="empty-illustration"
        viewBox="0 0 200 136"
        fill="none"
        aria-hidden="true"
      >
        <path d="M28 113h144" className="empty-illustration__shelf" />
        <rect x="49" y="42" width="31" height="69" rx="4" />
        <rect x="84" y="25" width="35" height="86" rx="4" />
        <path d="m125 45 30-7 16 68-30 7-16-68Z" />
        <path d="M91 36h20M91 43h14M56 53h16M57 98h15" />
        <path d="m100 65 5 5 9-11" className="empty-illustration__check" />
        <circle cx="159" cy="23" r="3" />
        <path d="M36 28v10M31 33h10" />
      </svg>
      <p className="library-state__eyebrow">A FRESH START</p>
      <h3>内容库还是空的</h3>
      <p>好故事值得被记住。这里会安静地收下你的每一次追更。</p>
      <button className="primary-button empty-state__add" type="button" onClick={onAdd}>
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M10 4v12M4 10h12" />
        </svg>
        添加第一个条目
      </button>
    </div>
  );
}

function NoResultsState({ onClear }: { onClear: () => void }) {
  return (
    <div className="library-state library-state--no-results">
      <span className="state-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 5 5M8 10.5h5" />
        </svg>
      </span>
      <h3>没有找到匹配的条目</h3>
      <p>试试其他关键词或筛选条件，完整内容库不会受影响。</p>
      <button
        className="secondary-button no-results__clear"
        type="button"
        onClick={onClear}
      >
        清除搜索和筛选
      </button>
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
    <div className="library-state library-state--error" role="alert">
      <span className="state-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M12 8v5M12 16.5v.5" />
          <path d="M10.3 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </svg>
      </span>
      <h3>内容库读取失败</h3>
      <p>{message}</p>
      <button className="retry-button" type="button" onClick={onRetry}>
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M16 6V2.5M16 6h-3.5M15.6 5.9A7 7 0 1 0 17 11" />
        </svg>
        重新加载
      </button>
    </div>
  );
}

interface DialogProps {
  title: string;
  titleId: string;
  busy?: boolean;
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
  }, [fallbackFocusRef, initialFocusRef]);

  useEffect(() => {
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
  }, [busy]);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) {
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
}

type EntryField = "title" | "currentProgress" | "totalProgress";
type EntryFormErrors = Partial<Record<EntryField | "form", string>>;

const MEDIA_TYPES = Object.keys(MEDIA_TYPE_LABELS) as MediaType[];
const ENTRY_STATUSES = ["tracking", "completed"] as const;

function getWriteErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function EntryFormDialog({
  editor,
  fallbackFocusRef,
  onClose,
  onSaved,
}: {
  editor: Exclude<EditorState, null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
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
  }));
  const [errors, setErrors] = useState<EntryFormErrors>({});
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const currentProgressRef = useRef<HTMLInputElement>(null);
  const totalProgressRef = useRef<HTMLInputElement>(null);
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current) {
      return;
    }

    const nextErrors: EntryFormErrors = {};
    const title = values.title.trim();
    const currentProgressText = values.currentProgress.trim();
    const totalProgressText = values.totalProgress.trim();
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

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      if (nextErrors.title) {
        titleRef.current?.focus();
      } else if (nextErrors.currentProgress) {
        currentProgressRef.current?.focus();
      } else {
        totalProgressRef.current?.focus();
      }
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setErrors({});
    const input = {
      title,
      mediaType: values.mediaType,
      currentProgress,
      totalProgress,
      status: values.status,
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
    <Dialog
      title={editingEntry ? "编辑条目" : "添加条目"}
      titleId={titleId}
      busy={saving}
      initialFocusRef={titleRef}
      fallbackFocusRef={fallbackFocusRef}
      onClose={onClose}
      className="dialog--form"
    >
      <form className="entry-form" noValidate onSubmit={handleSubmit}>
        <div className="dialog__body entry-form__body">
          <p className="dialog__description">
            {editingEntry
              ? `更新《${editingEntry.title}》的类型、进度与状态。`
              : "记下新的故事，从当前进度继续。"}
          </p>
          {errors.form ? (
            <p className="form-error" role="alert">
              {errors.form}
            </p>
          ) : null}
          <fieldset className="entry-form__fields" disabled={saving}>
            <div className="form-field">
              <label htmlFor="entry-title">标题</label>
              <input
                id="entry-title"
                name="title"
                type="text"
                value={values.title}
                required
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
          吗？此操作无法撤销。
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

function LibrarySummary({ entries }: { entries: MediaEntry[] }) {
  const completedCount = entries.filter(
    (entry) => entry.status === "completed",
  ).length;
  const trackingCount = entries.length - completedCount;

  return (
    <section className="library-summary" aria-label="内容库摘要">
      <div className="summary-card">
        <div className="summary-card__label">
          <span>条目总数</span>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m12 3 9 5-9 5-9-5 9-5Z" />
            <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
          </svg>
        </div>
        <p className="summary-card__value">
          <strong>{entries.length}</strong>
          <span>项</span>
        </p>
      </div>
      <div className="summary-card summary-card--tracking">
        <div className="summary-card__label">
          <span>正在追更</span>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" />
            <path d="m10 8 6 4-6 4V8Z" />
          </svg>
        </div>
        <p className="summary-card__value">
          <strong>{trackingCount}</strong>
          <span>项在追</span>
        </p>
      </div>
      <div className="summary-card summary-card--completed">
        <div className="summary-card__label">
          <span>已经看完</span>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" />
            <path d="m8 12 2.7 2.7L16.5 9" />
          </svg>
        </div>
        <p className="summary-card__value">
          <strong>{completedCount}</strong>
          <span>项完成</span>
        </p>
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

type EntryWriteAction =
  | { type: "progress"; delta: 1 | -1 }
  | { type: "status"; status: MediaEntry["status"] };

function EntryCard({
  entry,
  pending,
  error,
  onWrite,
  onEdit,
  onDelete,
}: {
  entry: MediaEntry;
  pending: boolean;
  error: string | null;
  onWrite: (action: EntryWriteAction) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const percentage = getProgressPercentage(entry);
  const titleId = `entry-title-${entry.id}`;
  const decrementDisabled = pending || entry.currentProgress === 0;
  const incrementDisabled =
    pending ||
    (entry.totalProgress !== null &&
      entry.currentProgress >= entry.totalProgress);

  return (
    <li className={`entry-card entry-card--${entry.mediaType}`}>
      <article aria-labelledby={titleId} aria-busy={pending}>
        <div className="entry-card__topline">
          <span className="media-type">
            <MediaTypeIcon type={entry.mediaType} />
            {MEDIA_TYPE_LABELS[entry.mediaType]}
          </span>
          <span className={`entry-status entry-status--${entry.status}`}>
            <span aria-hidden="true" />
            {ENTRY_STATUS_LABELS[entry.status]}
          </span>
        </div>

        <h3 className="entry-card__title" id={titleId}>
          {entry.title}
        </h3>

        <div className="entry-progress">
          <div className="entry-progress__heading">
            <span>当前进度</span>
            <strong>{formatProgress(entry)}</strong>
          </div>

          {percentage === null ? (
            <p className="entry-progress__unknown">
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M6.2 7.2C3.8 8.6 2.5 10 2.5 10s2.8 4.5 7.5 4.5c1 0 1.9-.2 2.7-.5M13.8 12.8c2.4-1.4 3.7-2.8 3.7-2.8S14.7 5.5 10 5.5c-1 0-1.9.2-2.7.5M4 3l12 14" />
              </svg>
              总进度未知，先记下这一刻
            </p>
          ) : (
            <div className="entry-progress__bar-row">
              <div
                className="entry-progress__track"
                role="progressbar"
                aria-label={`${entry.title}的观看或阅读进度`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percentage}
              >
                <span style={{ width: `${percentage}%` }} />
              </div>
              <span className="entry-progress__percentage">{percentage}%</span>
            </div>
          )}
        </div>

        <div className="quick-progress" aria-label={`${entry.title}的快捷操作`}>
          <div className="quick-progress__steps">
            <button
              className="quick-progress__step"
              type="button"
              aria-label={`《${entry.title}》进度减一`}
              disabled={decrementDisabled}
              onClick={() => onWrite({ type: "progress", delta: -1 })}
            >
              <span aria-hidden="true">−</span>
              <span>1</span>
            </button>
            <button
              className="quick-progress__step"
              type="button"
              aria-label={`《${entry.title}》进度加一`}
              disabled={incrementDisabled}
              onClick={() => onWrite({ type: "progress", delta: 1 })}
            >
              <span aria-hidden="true">+</span>
              <span>1</span>
            </button>
          </div>
          <button
            className="quick-progress__status"
            type="button"
            aria-label={
              entry.status === "completed"
                ? `重新追更《${entry.title}》`
                : `标记《${entry.title}》完成`
            }
            disabled={pending}
            onClick={() =>
              onWrite({
                type: "status",
                status: entry.status === "completed" ? "tracking" : "completed",
              })
            }
          >
            {entry.status === "completed" ? "重新追更" : "标记完成"}
          </button>
        </div>
        {pending ? (
          <p className="entry-card__write-status" role="status">
            正在更新《{entry.title}》…
          </p>
        ) : null}
        {error ? (
          <p className="entry-card__write-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="entry-card__footer">
          <div className="entry-card__updated">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="7" />
              <path d="M10 6v4l2.5 1.5" />
            </svg>
            <time dateTime={entry.updatedAt}>
              更新于 {updatedAtFormatter.format(new Date(entry.updatedAt))}
            </time>
          </div>
          <div className="entry-card__actions">
            <button
              className="icon-button entry-card__action"
              type="button"
              aria-label={`编辑《${entry.title}》`}
              disabled={pending}
              onClick={onEdit}
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="m12.8 3.8 3.4 3.4M4 16l1-4L14 3a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2l-9 9-4 1Z" />
              </svg>
            </button>
            <button
              className="icon-button entry-card__action entry-card__action--delete"
              type="button"
              aria-label={`删除《${entry.title}》`}
              disabled={pending}
              onClick={onDelete}
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M3 5h14M8 2.5h4M6 5l.7 12h6.6L14 5M8.5 8v6M11.5 8v6" />
              </svg>
            </button>
          </div>
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
  const [editor, setEditor] = useState<EditorState>(null);
  const [pendingDeletion, setPendingDeletion] = useState<MediaEntry | null>(
    null,
  );
  const [pendingEntryWrites, setPendingEntryWrites] = useState<Set<string>>(
    () => new Set(),
  );
  const [entryWriteErrors, setEntryWriteErrors] = useState<
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
  const entryWriteLocks = useRef(new Set<string>());
  const addButtonRef = useRef<HTMLButtonElement>(null);

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
  }

  function handleSaved(savedEntry: MediaEntry) {
    handleEntryUpdated(savedEntry);
    setEditor(null);
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

  useEffect(() => {
    void loadEntries();

    return () => {
      latestRequest.current += 1;
    };
  }, [loadEntries]);

  const normalizedTitleQuery = titleQuery.trim().toLowerCase();
  const hasActiveFilters =
    normalizedTitleQuery.length > 0 ||
    mediaTypeFilter !== "all" ||
    statusFilter !== "all";
  const visibleEntries =
    library.status === "success"
      ? library.entries.filter(
          (entry) =>
            entry.title.toLowerCase().includes(normalizedTitleQuery) &&
            (mediaTypeFilter === "all" || entry.mediaType === mediaTypeFilter) &&
            (statusFilter === "all" || entry.status === statusFilter),
        )
      : [];

  function clearFilters() {
    setTitleQuery("");
    setMediaTypeFilter("all");
    setStatusFilter("all");
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand" aria-label="追更 CatchUp">
          <BrandMark />
          <span className="brand-name">追更</span>
          <span className="brand-divider" aria-hidden="true" />
          <span className="brand-name-en">CatchUp</span>
        </div>
        <span className="local-note">
          <span aria-hidden="true" />
          本地内容库
        </span>
      </header>

      <main className="main-content">
        <section className="intro" aria-labelledby="page-title">
          <p className="intro__eyebrow">你的私人进度手册</p>
          <h1 id="page-title">
            每一次更新，<span>都接得上。</span>
          </h1>
          <p className="intro__description">
            剧集、番剧、综艺、小说与电影，都在这一页从容继续。
          </p>
        </section>

        <section className="library" aria-labelledby="library-title">
          <div className="library__heading">
            <div>
              <p className="library__eyebrow">MY LIBRARY</p>
              <h2 id="library-title">我的内容库</h2>
            </div>
            <div className="library__heading-actions">
              <span className="library__heading-note">不疾不徐，持续喜欢</span>
              <button
                className="primary-button library__add"
                type="button"
                ref={addButtonRef}
                disabled={library.status === "loading"}
                onClick={() => setEditor({ mode: "create" })}
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M10 4v12M4 10h12" />
                </svg>
                添加条目
              </button>
            </div>
          </div>

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
          ) : (
            <>
              <LibrarySummary entries={library.entries} />
              <section
                className="library-filters"
                role="search"
                aria-label="内容库搜索与筛选"
              >
                <div className="library-filter library-filter--search">
                  <label htmlFor="library-title-query">搜索标题</label>
                  <div className="library-filter__search-input">
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <circle cx="8.5" cy="8.5" r="5.5" />
                      <path d="m12.5 12.5 4 4" />
                    </svg>
                    <input
                      id="library-title-query"
                      type="search"
                      value={titleQuery}
                      placeholder="输入作品标题"
                      autoComplete="off"
                      onChange={(event) => setTitleQuery(event.target.value)}
                    />
                  </div>
                </div>
                <div className="library-filter">
                  <label htmlFor="library-media-type-filter">类型筛选</label>
                  <select
                    id="library-media-type-filter"
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
                </div>
                <div className="library-filter">
                  <label htmlFor="library-status-filter">状态筛选</label>
                  <select
                    id="library-status-filter"
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
                </div>
                {hasActiveFilters && visibleEntries.length > 0 ? (
                  <button
                    className="secondary-button library-filters__clear"
                    type="button"
                    onClick={clearFilters}
                  >
                    清除搜索和筛选
                  </button>
                ) : null}
              </section>
              {visibleEntries.length > 0 ? (
                <ul className="entry-grid" aria-label="追更内容列表">
                  {visibleEntries.map((entry) => (
                    <EntryCard
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
        </section>
      </main>

      <footer className="app-footer">
        <span>追更 · CatchUp</span>
        <span>把故事留在身边，把进度交给时间。</span>
      </footer>

      {editor ? (
        <EntryFormDialog
          key={editor.mode === "edit" ? editor.entry.id : "create"}
          editor={editor}
          fallbackFocusRef={addButtonRef}
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
    </div>
  );
}

export default App;
