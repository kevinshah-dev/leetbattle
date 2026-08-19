export function DesktopGate() {
  return (
    <aside aria-label="Desktop required" className="desktop-gate">
      <div aria-hidden="true" className="desktop-gate__cabinet">
        <span className="desktop-gate__screen">
          <span className="desktop-gate__cursor" />
        </span>
        <span className="desktop-gate__controls" />
      </div>
      <p className="eyebrow">Workspace paused</p>
      <h1>Bring a bigger screen to the fight.</h1>
      <p>
        LeetBattle needs a desktop viewport of at least 1180 × 720 so the
        challenge, editor, and live battle state stay readable.
      </p>
      <p className="desktop-gate__hint">
        Your invite URL is safe. Open this same link on a laptop or desktop.
      </p>
    </aside>
  );
}
