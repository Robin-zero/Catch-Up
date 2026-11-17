import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getLibraryErrorMessage, listEntries } from "./api";
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

function EmptyState() {
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

function EntryCard({ entry }: { entry: MediaEntry }) {
  const percentage = getProgressPercentage(entry);
  const titleId = `entry-title-${entry.id}`;

  return (
    <li className={`entry-card entry-card--${entry.mediaType}`}>
      <article aria-labelledby={titleId}>
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

        <div className="entry-card__footer">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="7" />
            <path d="M10 6v4l2.5 1.5" />
          </svg>
          <time dateTime={entry.updatedAt}>
            更新于 {updatedAtFormatter.format(new Date(entry.updatedAt))}
          </time>
        </div>
      </article>
    </li>
  );
}

function App() {
  const [library, setLibrary] = useState<LibraryState>({ status: "loading" });
  const latestRequest = useRef(0);

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
            <span className="library__heading-note">不疾不徐，持续喜欢</span>
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
            <EmptyState />
          ) : (
            <>
              <LibrarySummary entries={library.entries} />
              <ul className="entry-grid" aria-label="追更内容列表">
                {library.entries.map((entry) => (
                  <EntryCard entry={entry} key={entry.id} />
                ))}
              </ul>
            </>
          )}
        </section>
      </main>

      <footer className="app-footer">
        <span>追更 · CatchUp</span>
        <span>把故事留在身边，把进度交给时间。</span>
      </footer>
    </div>
  );
}

export default App;
