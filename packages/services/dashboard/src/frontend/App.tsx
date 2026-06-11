import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { DateRangeProvider, DateRangeSelect } from "./hooks/DateRangeContext";
import { SystemHealth } from "./components/SystemHealth";
import { MechanismView } from "./components/MechanismView";
import { ActivityFeed } from "./components/ActivityFeed";
import { TaskKanban } from "./components/TaskKanban";

type Tab = "system-health" | "mechanism" | "feed" | "kanban";

export default function App() {
  return (
    <DateRangeProvider>
      <AppInner />
    </DateRangeProvider>
  );
}

function AppInner() {
  const [activeTab, setActiveTab] = useState<Tab>("system-health");

  // NUX scope-down §C-§F: each tab fetches its own data via /api/* (proxied
  // by Vite in dev). The legacy useOAData / LayerHealthStrip block that
  // used to gate rendering on a global fetch is gone — they pulled from
  // endpoints the NUX server doesn't implement, which would 404 and show
  // a "Connection Error" overlay even when the four views are healthy.

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-900 tracking-tight">
              OA Dashboard
            </h1>
            <p className="text-xs text-gray-400 mt-0.5">
              Is our machine getting better?
            </p>
          </div>

          <div className="flex items-center gap-6">
            <DateRangeSelect />

            {/* Tab Navigation */}
            <nav className="flex gap-6">
              <TabButton active={activeTab === "system-health"} onClick={() => setActiveTab("system-health")}>
                Topline Metrics
              </TabButton>
              <TabButton active={activeTab === "mechanism"} onClick={() => setActiveTab("mechanism")}>
                Mechanism
              </TabButton>
              <TabButton active={activeTab === "kanban"} onClick={() => setActiveTab("kanban")}>
                Kanban
              </TabButton>
              <TabButton active={activeTab === "feed"} onClick={() => setActiveTab("feed")}>
                Feed
              </TabButton>
            </nav>
          </div>
        </div>

        {/* Content — each tab owns its own data fetching */}
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3 }}
          >
            {activeTab === "system-health" ? <SystemHealth />
              : activeTab === "mechanism" ? <MechanismView />
              : activeTab === "kanban" ? <TaskKanban />
              : <ActivityFeed />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`pb-1 text-sm transition-all ${active ? "tab-active" : "tab-inactive"}`}
    >
      {children}
    </button>
  );
}
