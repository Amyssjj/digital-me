import { createContext, useContext, useState, ReactNode } from "react";

export type DateRangePreset = "7d" | "14d" | "30d" | "all";

export interface DateRange {
  preset: DateRangePreset;
  days: number;     // integer days to look back; "all" maps to a large number
  label: string;    // human-readable (e.g. "Last 7 days")
  setPreset: (p: DateRangePreset) => void;
}

const PRESETS: Record<DateRangePreset, { days: number; label: string }> = {
  "7d":  { days: 7,   label: "Last 7 days" },
  "14d": { days: 14,  label: "Last 2 weeks" },
  "30d": { days: 30,  label: "Last 1 month" },
  "all": { days: 3650, label: "All time" },
};

const DateRangeCtx = createContext<DateRange | null>(null);

export function DateRangeProvider({ children, initial = "14d" }: { children: ReactNode; initial?: DateRangePreset }) {
  const [preset, setPresetState] = useState<DateRangePreset>(initial);
  const { days, label } = PRESETS[preset];
  return (
    <DateRangeCtx.Provider value={{ preset, days, label, setPreset: setPresetState }}>
      {children}
    </DateRangeCtx.Provider>
  );
}

export function useDateRange(): DateRange {
  const ctx = useContext(DateRangeCtx);
  if (!ctx) {
    // Fail-soft fallback — components outside the provider still work with defaults
    return { preset: "14d", days: 14, label: "Last 2 weeks", setPreset: () => {} };
  }
  return ctx;
}

export function DateRangeSelect() {
  const { preset, setPreset } = useDateRange();
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-gray-400 uppercase tracking-wider">Range</span>
      <select
        value={preset}
        onChange={(e) => setPreset(e.target.value as DateRangePreset)}
        className="text-xs bg-white border border-gray-200 rounded-md px-2 py-1 text-gray-700 hover:border-gray-300 focus:outline-none focus:border-blue-400 cursor-pointer"
      >
        {(Object.keys(PRESETS) as DateRangePreset[]).map((k) => (
          <option key={k} value={k}>{PRESETS[k].label}</option>
        ))}
      </select>
    </div>
  );
}
