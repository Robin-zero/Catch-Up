function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="brand-mark" aria-hidden="true">
          C
        </span>
        <span className="brand-name">CatchUp</span>
      </header>

      <main className="welcome">
        <p className="welcome__eyebrow">你的私人进度手册</p>
        <h1>追更</h1>
        <p className="welcome__tagline">每一次更新，都接得上。</p>
        <p className="welcome__description">
          记录剧集、番剧、综艺、小说与电影的观看和阅读进度。
        </p>
        <div className="welcome__note">
          <span className="status-dot" aria-hidden="true" />
          本地记录，自在追更
        </div>
      </main>
    </div>
  );
}

export default App;
