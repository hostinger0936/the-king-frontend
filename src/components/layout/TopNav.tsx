// src/components/layout/TopNav.tsx
import { useNavigate } from "react-router-dom";

export type TabKey = "home" | "data" | "messages" | "groups" | "devices" | "help";

interface TopNavProps {
  activeTab:    TabKey;
  onTabChange:  (tab: TabKey) => void;
  showBack?:    boolean;   // device detail mai "« Home" dikhta hai
  alertText?:   string;    // scrolling ticker text (optional)
  darkMode?:    boolean;
  onToggleDark?: () => void;
}

const TABS: { key: TabKey; label: string }[] = [
  { key: "home",     label: "Home"     },
  { key: "data",     label: "Data"     },
  { key: "messages", label: "Messages" },
  { key: "groups",   label: "Groups"   },
  { key: "devices",  label: "Devices"  },
  { key: "help",     label: "Help"     },
];

export default function TopNav({
  activeTab,
  onTabChange,
  showBack   = false,
  alertText,
  darkMode   = false,
  onToggleDark,
}: TopNavProps) {
  const nav = useNavigate();

  return (
    <div className="sticky top-0 z-50 w-full">
      {/* Alert ticker */}
      {alertText && (
        <div className="overflow-hidden bg-[#c0392b] py-1">
          <div className="animate-marquee whitespace-nowrap text-[12px] font-semibold text-white">
            &nbsp;&nbsp;&nbsp;{alertText}&nbsp;&nbsp;&nbsp;{alertText}&nbsp;&nbsp;&nbsp;{alertText}
          </div>
        </div>
      )}

      {/* Main navbar */}
      <nav className="flex items-center gap-1 overflow-x-auto bg-black px-2 py-1 scrollbar-hide">
        {/* Back link OR brand */}
        {showBack ? (
          <button
            type="button"
            onClick={() => nav("/")}
            className="mr-2 shrink-0 rounded px-2 py-1.5 text-[11px] font-semibold text-[#00c853] hover:bg-white/10"
          >
            « Home
          </button>
        ) : null}

        {/* Tabs */}
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onTabChange(tab.key)}
              className={[
                "shrink-0 rounded px-3 py-1.5 text-[11px] font-semibold transition",
                isActive
                  ? "bg-[#00c853] text-black"
                  : "text-white hover:bg-white/10",
              ].join(" ")}
            >
              {tab.label}
            </button>
          );
        })}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Dark / light toggle */}
        <button
          type="button"
          onClick={onToggleDark}
          className="shrink-0 rounded p-1.5 text-[18px] text-white hover:bg-white/10"
          title="Toggle dark mode"
        >
          {darkMode ? "☀️" : "🌙"}
        </button>
      </nav>
    </div>
  );
}
