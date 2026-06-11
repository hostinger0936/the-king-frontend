// src/components/layout/TopNav.tsx
export type TabKey = "home" | "data" | "messages" | "groups" | "devices" | "help";

interface TopNavProps {
  activeTab:    TabKey;
  onTabChange:  (tab: TabKey) => void;
  showBack?:    boolean;
  onBack?:      () => void;
  alertText?:   string;
  darkMode?:    boolean;
  onToggleDark?: () => void;
}

const ALL_TABS: { key: TabKey; label: string }[] = [
  { key: "home",     label: "Home"     },
  { key: "data",     label: "Data"     },
  { key: "messages", label: "Messages" },
  { key: "groups",   label: "Groups"   },
  { key: "devices",  label: "Devices"  },
  { key: "help",     label: "Help"     },
];

// Device detail — Home replaced by « Home back button
const DEVICE_TABS: { key: TabKey; label: string }[] = [
  { key: "data",     label: "Data"     },
  { key: "messages", label: "Messages" },
  { key: "groups",   label: "Groups"   },
  { key: "devices",  label: "Devices"  },
  { key: "help",     label: "Help"     },
];

export default function TopNav({
  activeTab,
  onTabChange,
  showBack    = false,
  onBack,
  alertText,
  darkMode    = false,
  onToggleDark,
}: TopNavProps) {
  const tabs = showBack ? DEVICE_TABS : ALL_TABS;

  return (
    <div className="sticky top-0 z-50 w-full">
      {/* Alert ticker — duration scales with text length so it always completes */}
      {alertText && (
        <div className="overflow-hidden bg-[#c0392b] py-[3px]">
          <div
            className="animate-marquee whitespace-nowrap text-[11px] font-semibold text-white"
            style={{ animationDuration: `${Math.max(20, Math.ceil(alertText.length * 0.12))}s` }}
          >
            &nbsp;&nbsp;&nbsp;{alertText}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{alertText}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{alertText}
          </div>
        </div>
      )}

      {/* Main navbar — compact like competitor */}
      <nav className="flex items-center gap-0.5 overflow-x-auto bg-black px-1.5 py-1 scrollbar-hide">

        {/* « Home — shown in device detail, active when showing home content */}
        {showBack && (
          <button
            type="button"
            onClick={() => {
              if (activeTab === "home") { onBack?.(); }
              else { onTabChange("home"); }
            }}
            className={[
              "shrink-0 rounded px-2 py-1 text-[11px] font-semibold transition",
              activeTab === "home"
                ? "bg-[#00c853] text-black"
                : "text-white hover:bg-white/10",
            ].join(" ")}
          >
            « Home
          </button>
        )}

        {/* Tabs */}
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onTabChange(tab.key)}
              className={[
                "shrink-0 rounded px-2 py-1 text-[11px] font-semibold transition",
                isActive
                  ? "bg-[#00c853] text-black"
                  : "text-white hover:bg-white/10",
              ].join(" ")}
            >
              {tab.label}
            </button>
          );
        })}

        <div className="flex-1" />

        {/* Day/Night toggle */}
        <button
          type="button"
          onClick={onToggleDark}
          className="shrink-0 rounded p-1 text-[16px] text-white hover:bg-white/10"
          title="Toggle dark mode"
        >
          {darkMode ? "☀️" : "🌙"}
        </button>
      </nav>
    </div>
  );
}
