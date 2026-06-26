import { triggerArrange } from "../canvas/index.js";
import { ExportMenu } from "../export/index.js";
import { ProjectsBar } from "../persistence/index.js";
import { useSchemaStore } from "../store/index.js";
import { DatabaseIcon, GearIcon, RowsIcon } from "../ui/icons.js";
import "./TopBar.css";

export function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const tableCount = useSchemaStore((state) => state.schema.tables.length);

  return (
    <header className="topbar">
      <div className="topbar__left">
        <div className="topbar__brand">
          <span className="topbar__logo" aria-hidden>
            <DatabaseIcon size={14} />
          </span>
          <span className="topbar__wordmark">Schema Studio</span>
        </div>
      </div>

      <div className="topbar__right">
        <ProjectsBar />
        <span className="topbar__divider" />
        <button
          type="button"
          className="topbar__btn topbar__btn--ghost"
          onClick={() => triggerArrange()}
          disabled={tableCount === 0}
          title="Re-lay out the tables on the canvas"
        >
          <RowsIcon size={16} />
          Auto-arrange
        </button>
        <ExportMenu />
        <button
          type="button"
          className="topbar__icon-btn"
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Settings"
        >
          <GearIcon size={18} />
        </button>
      </div>
    </header>
  );
}
