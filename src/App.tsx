import { useCallback, useEffect, useState } from "react";
import { Database, FileSpreadsheet, Layers, TrendingUp } from "lucide-react";
import { ExportsView } from "./components/ExportsView";
import { SnapshotsView } from "./components/SnapshotsView";
import { SourcesView } from "./components/SourcesView";
import { TrendsView } from "./components/TrendsView";
import type {
  ExportGranularity,
  MarketSide,
  NormalizedPriceRecord,
  OverviewResponse,
  SnapshotsResponse,
  TrendRow,
} from "./types";

type ActiveTab = "snapshots" | "trends" | "exports" | "sources";

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("snapshots");
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [snapshots, setSnapshots] = useState<NormalizedPriceRecord[]>([]);
  const [snapshotsTotal, setSnapshotsTotal] = useState(0);
  const [snapshotsLoading, setSnapshotsLoading] = useState(true);

  const [activeSide, setActiveSide] = useState<MarketSide>("buy");
  const [selectedPhone, setSelectedPhone] = useState("all");
  const [selectedSource, setSelectedSource] = useState("all");
  const [selectedCondition, setSelectedCondition] = useState("all");
  const [selectedPartCategory, setSelectedPartCategory] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [scraping, setScraping] = useState(false);
  const [scrapeFeedback, setScrapeFeedback] = useState<string | null>(null);

  const [trendGranularity, setTrendGranularity] = useState<ExportGranularity>("daily");
  const [trendPhone, setTrendPhone] = useState("all");
  const [trendSource, setTrendSource] = useState("all");
  const [trends, setTrends] = useState<TrendRow[]>([]);
  const [trendsLoading, setTrendsLoading] = useState(false);

  const loadOverview = useCallback(async () => {
    const resp = await fetch("/api/overview");
    if (resp.ok) {
      setOverview((await resp.json()) as OverviewResponse);
    }
  }, []);

  const loadSnapshots = useCallback(async () => {
    setSnapshotsLoading(true);
    try {
      const params = new URLSearchParams({
        side: activeSide,
        source: selectedSource,
        phone: selectedPhone,
        condition: selectedCondition,
        part_category: selectedPartCategory,
        q: searchQuery,
        limit: "150",
      });
      const resp = await fetch(`/api/snapshots?${params.toString()}`);
      if (resp.ok) {
        const data = (await resp.json()) as SnapshotsResponse;
        setSnapshots(data.records);
        setSnapshotsTotal(data.total);
      }
    } finally {
      setSnapshotsLoading(false);
    }
  }, [activeSide, selectedSource, selectedPhone, selectedCondition, selectedPartCategory, searchQuery]);

  const loadTrends = useCallback(async () => {
    setTrendsLoading(true);
    try {
      const params = new URLSearchParams({
        granularity: trendGranularity,
        source: trendSource,
      });
      if (trendPhone !== "all") {
        params.set("model", trendPhone);
      }
      const resp = await fetch(`/api/trends?${params.toString()}`);
      if (resp.ok) {
        const data = (await resp.json()) as { rows: TrendRow[] };
        setTrends(data.rows);
      }
    } finally {
      setTrendsLoading(false);
    }
  }, [trendGranularity, trendPhone, trendSource]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  useEffect(() => {
    if (activeTab === "trends") {
      void loadTrends();
    }
  }, [activeTab, loadTrends]);

  const handleSideChange = (nextSide: MarketSide) => {
    setActiveSide(nextSide);
    setSelectedSource("all");
    setSelectedPhone("all");
    setSelectedCondition("all");
    setSelectedPartCategory("all");
    setScrapeFeedback(null);
  };

  const handleRunScrape = async () => {
    setScraping(true);
    setScrapeFeedback(null);
    try {
      const resp = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          side: activeSide,
          source: selectedSource,
          phone: selectedPhone,
          part_category: selectedPartCategory,
        }),
      });
      if (!resp.ok) throw new Error(`Scrape failed (${resp.status})`);
      const data = (await resp.json()) as { collected_count: number; run: { id: number } };
      setScrapeFeedback(
        `Run #${data.run.id} completed: ${data.collected_count} normalized ${activeSide} records upserted.`,
      );
      await Promise.all([loadOverview(), loadSnapshots()]);
    } catch (err) {
      setScrapeFeedback(err instanceof Error ? err.message : "Failed to run collection");
    } finally {
      setScraping(false);
    }
  };

  const handleQuickExportCsv = () => {
    if (snapshots.length === 0) return;
    const headers = [
      "side",
      "source",
      "source_product_id",
      "brand",
      "model",
      "part_category",
      "part_name",
      "storage_gb",
      "ram_gb",
      "color",
      "condition",
      "price",
      "currency",
      "mrp",
      "discount_pct",
      "in_stock",
      "source_url",
      "captured_at",
      "run_id",
    ];
    const esc = (val: unknown): string => {
      if (val === null || val === undefined) return "";
      const s = String(val);
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };
    const csv = [
      headers.join(","),
      ...snapshots.map((r) => headers.map((h) => esc(r[h as keyof NormalizedPriceRecord])).join(",")),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeSide}_${selectedSource === "all" ? "all_sources" : selectedSource}_snapshots.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const navItems: Array<{ id: ActiveTab; label: string; icon: typeof Database }> = [
    { id: "snapshots", label: "Price Snapshots", icon: Database },
    { id: "trends", label: "Trend Analytics", icon: TrendingUp },
    { id: "exports", label: "Bucketed Exports", icon: FileSpreadsheet },
    { id: "sources", label: "Sources & Runs", icon: Layers },
  ];

  const tabTitles: Record<ActiveTab, string> = {
    snapshots: "Price Snapshots & Scraper",
    trends: "DoD / WoW / MoM Trends",
    exports: "Date-Bucketed CSV Archives",
    sources: "Configured Sources & Runs",
  };

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      {/* Sidebar Navigation */}
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white md:flex md:flex-col">
        <div className="flex h-14 items-center border-b border-slate-200 px-5">
          <span className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap">
            Swapup Scrapper
          </span>
        </div>
        <nav className="flex-1 space-y-1 p-3" aria-label="Workspace navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
                  active
                    ? "bg-slate-100 text-slate-900"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0 text-slate-500" />
                {item.label}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Main Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Bar Contract: Brand/Breadcrumb — Nav — Primary Action */}
        <header className="flex h-14 items-center justify-between gap-8 border-b border-slate-200 bg-white px-6">
          <div className="text-sm font-semibold text-slate-900 whitespace-nowrap shrink-0">
            Swapup Scrapper{" "}
            <span className="font-normal text-slate-500">/ {tabTitles[activeTab]}</span>
          </div>

          <nav className="flex items-center gap-5 md:hidden" aria-label="Compact navigation">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`text-xs font-medium whitespace-nowrap shrink-0 ${
                  activeTab === item.id ? "text-teal-700 underline underline-offset-4" : "text-slate-600"
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <button
            type="button"
            onClick={() => setActiveTab("exports")}
            className="rounded-md bg-slate-900 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            Generate Export
          </button>
        </header>

        <main className="mx-auto w-full max-w-[1240px] flex-1 space-y-6 p-6">
          {/* KPI Summary Grid */}
          <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="text-xs font-medium text-slate-500">Stored Snapshots</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
                {overview ? overview.kpis.total_snapshots.toLocaleString() : "—"}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="text-xs font-medium text-slate-500">Tracked Phone Models</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
                {overview ? overview.kpis.unique_models.toLocaleString() : "—"}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="text-xs font-medium text-slate-500">Active Sources</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
                {overview ? overview.kpis.sources_count : "—"}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="text-xs font-medium text-slate-500">Mean Quoted Price</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
                {overview ? `₹${overview.kpis.avg_price.toLocaleString("en-IN")}` : "—"}
              </div>
            </div>
          </section>

          {activeTab === "snapshots" && (
            <SnapshotsView
              activeSide={activeSide}
              buyCount={overview?.kpis.buy_snapshots ?? 0}
              sellCount={overview?.kpis.sell_snapshots ?? 0}
              newCount={overview?.kpis.new_snapshots ?? 0}
              partsCount={overview?.kpis.parts_snapshots ?? 0}
              records={snapshots}
              total={snapshotsTotal}
              loading={snapshotsLoading}
              phones={
                activeSide === "parts"
                  ? (overview?.parts_phones ?? [])
                  : activeSide === "new"
                    ? (overview?.new_phones ?? [])
                    : activeSide === "buy"
                      ? (overview?.buy_phones ?? [])
                      : (overview?.sell_phones ?? [])
              }
              sources={
                activeSide === "parts"
                  ? (overview?.parts_sources ?? [])
                  : activeSide === "new"
                    ? (overview?.new_sources ?? [])
                    : activeSide === "buy"
                      ? (overview?.buy_sources ?? [])
                      : (overview?.sell_sources ?? [])
              }
              partCategories={overview?.part_categories ?? []}
              selectedPhone={selectedPhone}
              selectedSource={selectedSource}
              selectedCondition={selectedCondition}
              selectedPartCategory={selectedPartCategory}
              searchQuery={searchQuery}
              scraping={scraping}
              scrapeFeedback={scrapeFeedback}
              onSideChange={handleSideChange}
              onPhoneChange={setSelectedPhone}
              onSourceChange={setSelectedSource}
              onConditionChange={setSelectedCondition}
              onPartCategoryChange={setSelectedPartCategory}
              onSearchChange={setSearchQuery}
              onRunScrape={handleRunScrape}
              onQuickExportCsv={handleQuickExportCsv}
            />
          )}

          {activeTab === "trends" && (
            <TrendsView
              rows={trends}
              loading={trendsLoading}
              granularity={trendGranularity}
              phones={overview?.phones ?? []}
              sources={overview?.sources ?? []}
              selectedPhone={trendPhone}
              selectedSource={trendSource}
              onGranularityChange={setTrendGranularity}
              onPhoneChange={setTrendPhone}
              onSourceChange={setTrendSource}
            />
          )}

          {activeTab === "exports" && <ExportsView sources={overview?.sources ?? []} />}

          {activeTab === "sources" && (
            <SourcesView
              sourceConfigs={overview?.source_configs ?? []}
              recentRuns={overview?.recent_runs ?? []}
            />
          )}
        </main>
      </div>
    </div>
  );
}
