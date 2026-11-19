import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import yaml from "js-yaml";

type NormalizedCondition =
  | "new"
  | "like_new"
  | "excellent"
  | "good"
  | "fair"
  | "poor"
  | "unknown";

type ExportGranularity = "daily" | "weekly" | "monthly";
type MarketSide = "buy" | "sell" | "new" | "parts";

interface NormalizedPriceRecord {
  side: MarketSide;
  source: string;
  source_product_id: string;
  brand: string;
  model: string;
  storage_gb: number | null;
  ram_gb: number | null;
  color: string | null;
  condition: NormalizedCondition;
  part_category?: string | null;
  part_name?: string | null;
  price: number;
  currency: string;
  mrp: number | null;
  discount_pct: number | null;
  in_stock: boolean | null;
  source_url: string;
  captured_at: string;
  run_id: number;
  raw_payload: Record<string, unknown>;
}

function classifyMarketSide(source: string, isRenewed?: unknown): MarketSide {
  if (source === "samsung_parts" || source === "apple_parts") return "parts";
  if (source === "amazon.in" || source === "flipkart") return "new";
  if (source === "Amazon India" && isRenewed === false) return "new";
  if (source === "cashify_buy" || source === "Amazon India") return "buy";
  return "sell";
}

function sanitizeMrp(rawMrp: number | null, price: number): number | null {
  if (rawMrp === null || !Number.isFinite(rawMrp) || rawMrp <= 0) return null;
  let mrp = rawMrp;
  const s = String(Math.round(mrp));
  if (s.length >= 8 && s.length % 2 === 0 && s.slice(0, s.length / 2) === s.slice(s.length / 2)) {
    mrp = Number(s.slice(0, s.length / 2));
  }
  if (mrp < price || mrp > price * 5) return null;
  return mrp;
}

const KNOWN_PHONE_BRANDS = [
  "Apple",
  "Samsung",
  "OnePlus",
  "Google",
  "Xiaomi",
  "Redmi",
  "Realme",
  "Vivo",
  "Oppo",
  "Motorola",
  "Nothing",
  "iQOO",
  "Poco",
  "Lava",
];

function deriveBrandFromTitle(title: string): string {
  const lower = title.toLowerCase();
  for (const b of KNOWN_PHONE_BRANDS) {
    if (lower.includes(b.toLowerCase())) return b;
  }
  if (lower.includes("iphone")) return "Apple";
  if (lower.includes("galaxy")) return "Samsung";
  if (lower.includes("pixel")) return "Google";
  return "Unknown";
}

function isRefurbishedOrUsedTitle(title: string): boolean {
  return /\b(renewed|refurbished|pre[- ]?owned|used|second[- ]?hand)\b/i.test(title);
}

interface ScrapeRun {
  id: number;
  source: string;
  started_at: string;
  finished_at: string;
  status: "success" | "blocked" | "failed";
  records_count: number;
  error_message: string | null;
}

interface SourceConfigSummary {
  name: string;
  kind: "playwright" | "generic_api";
  enabled: boolean;
  urls: string[];
  auth_type?: string;
  pagination_type?: string;
}

interface TrendRow {
  brand: string;
  model: string;
  source: string;
  condition: string;
  bucket_date: string;
  avg_price: number;
  min_price: number;
  max_price: number;
  median_price: number;
  dod_abs: number | null;
  dod_pct: number | null;
  wow_abs: number | null;
  wow_pct: number | null;
  mom_abs: number | null;
  mom_pct: number | null;
  ma_7d: number;
  ma_30d: number;
}

const ROOT_DIR = process.cwd();
const SCRAPER_DIR = path.join(ROOT_DIR, "phone-price-scraper");
const FIXTURES_DIR = path.join(SCRAPER_DIR, "tests", "fixtures");
const EXPORTS_DIR = path.join(SCRAPER_DIR, "exports");

function normalizeCondition(raw: string | null | undefined): NormalizedCondition {
  if (!raw) return "unknown";
  const text = raw.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (/\b(brand\s*new|new|sealed)\b/i.test(text)) return "new";
  if (/\b(like\s*new|mint|superb|flawless|grade\s*a\+?)\b/i.test(text)) return "like_new";
  if (/\b(excellent|very\s*good)\b/i.test(text)) return "excellent";
  if (/\b(good|grade\s*b)\b/i.test(text)) return "good";
  if (/\b(fair|average|acceptable|grade\s*c)\b/i.test(text)) return "fair";
  if (/\b(poor|broken|cracked|defective|damaged|dead|faulty|grade\s*[de])\b/i.test(text)) {
    return "poor";
  }
  return "unknown";
}

function parseStorageGb(raw: unknown): number | null {
  if (raw === null || raw === undefined || typeof raw === "boolean") return null;
  if (typeof raw === "number") return raw > 0 ? Math.round(raw) : null;
  const text = String(raw).trim();
  const tb = text.match(/(\d+)\s*tb\b/i);
  if (tb) return Number(tb[1]) * 1024;
  const gb = text.match(/(\d+)\s*gb\b/i);
  if (gb) return Number(gb[1]);
  if (/^\d{2,4}$/.test(text)) return Number(text);
  return null;
}

function parseRamGb(raw: unknown): number | null {
  if (raw === null || raw === undefined || typeof raw === "boolean") return null;
  if (typeof raw === "number") return raw >= 1 && raw <= 64 ? Math.round(raw) : null;
  const text = String(raw).trim();
  const gb = text.match(/(\d+)\s*gb\b/i);
  if (gb) {
    const v = Number(gb[1]);
    return v >= 1 && v <= 64 ? v : null;
  }
  if (/^\d{1,2}$/.test(text)) {
    const v = Number(text);
    return v >= 1 && v <= 64 ? v : null;
  }
  return null;
}

function computeDiscountPct(price: number, mrp: number | null): number | null {
  if (mrp === null || mrp <= 0 || price < 0 || mrp < price) return null;
  return Math.round(((mrp - price) / mrp) * 10000) / 100;
}

function stableProductId(...parts: Array<string | number | null | undefined>): string {
  const joined = parts
    .filter((p) => p !== null && p !== undefined && String(p).trim() !== "")
    .map((p) => String(p).trim().toLowerCase())
    .join("|");
  return crypto.createHash("sha256").update(joined).digest("hex").slice(0, 24);
}

function cleanModelName(rawModel: string, brand: string): string {
  let clean = rawModel
    .replace(/^Sell\s+Old\s+/i, "")
    .replace(/\s*-\s*Refurbished.*$/i, "")
    .replace(/\s*Online\s*&.*$/i, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b\d+\s*(?:GB|TB)\b/gi, " ")
    .trim();
  if (brand && clean.toLowerCase().startsWith(brand.toLowerCase())) {
    clean = clean.slice(brand.length).trim();
  }
  return clean.replace(/\s+/g, " ").replace(/^[\s\-|]+|[\s\-|]+$/g, "") || rawModel.trim();
}

function ensureIsoTimestamp(raw: unknown, fallback = "2026-11-17T06:00:00+00:00"): string {
  if (!raw) return fallback;
  const text = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return fallback;
  const normalized = text.includes(" ") && !text.includes("T") ? text.replace(" ", "T") : text;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

function parseCsvRows(csvText: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"' && csvText[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && csvText[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some((c) => c.length > 0)) rows.push(row);
  }
  if (rows.length < 2) return [];

  const headers = rows[0];
  const out: Array<Record<string, string>> = [];
  for (let rIdx = 1; rIdx < rows.length; rIdx++) {
    const vals = rows[rIdx];
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = vals[c] ?? "";
    }
    out.push(obj);
  }
  return out;
}

function parseAmazonFixture(html: string, runId: number, capturedAt: string): NormalizedPriceRecord[] {
  const records: NormalizedPriceRecord[] = [];
  const cardRe = /<div\s+class="tradein-device-card"([\s\S]*?)<\/div>\s*(?=<div\s+class="tradein-device-card"|<\/div>\s*<\/body>)/gi;
  let cardMatch: RegExpExecArray | null;
  while ((cardMatch = cardRe.exec(html)) !== null) {
    const block = cardMatch[0];
    const asin = block.match(/data-asin="([^"]+)"/i)?.[1] ?? "";
    const brand = block.match(/data-brand="([^"]+)"/i)?.[1] ?? "Unknown";
    const defaultStorage = parseStorageGb(block.match(/data-storage="([^"]+)"/i)?.[1]);
    const ramGb = parseRamGb(block.match(/data-ram="([^"]+)"/i)?.[1]);
    const currency = block.match(/data-currency="([^"]+)"/i)?.[1] ?? "INR";
    const url = block.match(/data-url="([^"]+)"/i)?.[1] ?? "https://www.amazon.in/b?node=tradein";
    const title = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1]?.trim() ?? "Unknown";
    const model = cleanModelName(title, brand);

    const rowRe =
      /<div\s+class="tradein-condition-row"([^>]*)>[\s\S]*?<span\s+class="tradein-offer-price">([\s\S]*?)<\/span>/gi;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRe.exec(block)) !== null) {
      const attrs = rowMatch[1];
      const priceText = rowMatch[2].replace(/[^\d.]/g, "");
      const price = Number(priceText);
      if (!Number.isFinite(price) || price <= 0) continue;
      const condRaw = attrs.match(/data-condition="([^"]+)"/i)?.[1] ?? "good";
      const storageGb = parseStorageGb(attrs.match(/data-storage="([^"]+)"/i)?.[1]) ?? defaultStorage;
      const condition = normalizeCondition(condRaw);
      records.push({
        side: "sell",
        source: "amazon_sell",
        source_product_id: asin || stableProductId("amazon_sell", brand, model, storageGb),
        brand,
        model,
        storage_gb: storageGb,
        ram_gb: ramGb,
        color: null,
        condition,
        price,
        currency,
        mrp: null,
        discount_pct: null,
        in_stock: null,
        source_url: url,
        captured_at: capturedAt,
        run_id: runId,
        raw_payload: { asin, title, condition_raw: condRaw, storage_gb: storageGb },
      });
    }
  }
  return records;
}

function parseCashifySellFixture(html: string, runId: number, capturedAt: string): NormalizedPriceRecord[] {
  const match = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return [];
  const data = JSON.parse(match[1]) as {
    props?: {
      pageProps?: {
        product?: {
          brand?: string;
          name?: string;
          variants?: Array<{
            id?: string;
            storage?: string;
            ram?: string;
            color?: string;
            url?: string;
            conditionQuotes?: Array<{ id?: string; grade?: string; price?: number }>;
          }>;
        };
      };
    };
  };
  const product = data.props?.pageProps?.product;
  if (!product) return [];
  const brand = String(product.brand ?? "Unknown").trim();
  const model = cleanModelName(String(product.name ?? "Unknown"), brand);
  const out: NormalizedPriceRecord[] = [];
  for (const v of product.variants ?? []) {
    const storageGb = parseStorageGb(v.storage);
    const ramGb = parseRamGb(v.ram);
    for (const q of v.conditionQuotes ?? []) {
      const price = Number(q.price ?? 0);
      if (!Number.isFinite(price) || price <= 0) continue;
      out.push({
        side: "sell",
        source: "cashify_sell",
        source_product_id: String(q.id ?? v.id ?? stableProductId("cashify_sell", brand, model, storageGb)),
        brand,
        model,
        storage_gb: storageGb,
        ram_gb: ramGb,
        color: v.color ?? null,
        condition: normalizeCondition(q.grade),
        price,
        currency: "INR",
        mrp: null,
        discount_pct: null,
        in_stock: null,
        source_url: String(v.url ?? "https://www.cashify.in/sell-old-mobile-phone"),
        captured_at: capturedAt,
        run_id: runId,
        raw_payload: { variant: v, quote: q },
      });
    }
  }
  return out;
}

function parseCashifyBuyFixture(html: string, runId: number, capturedAt: string): NormalizedPriceRecord[] {
  const match = html.match(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  if (!match) return [];
  const item = JSON.parse(match[1]) as {
    name?: string;
    brand?: { name?: string };
    hasVariant?: Array<{
      sku?: string;
      name?: string;
      color?: string;
      conditionGrade?: string;
      warranty?: string;
      mrp?: number;
      offers?: { price?: number; priceCurrency?: string; availability?: string; url?: string };
    }>;
  };
  const brand = String(item.brand?.name ?? "Apple");
  const model = cleanModelName(String(item.name ?? "Unknown"), brand);
  const out: NormalizedPriceRecord[] = [];
  for (const v of item.hasVariant ?? []) {
    const price = Number(v.offers?.price ?? 0);
    if (!Number.isFinite(price) || price <= 0) continue;
    const mrp = v.mrp !== undefined ? Number(v.mrp) : null;
    const parts = String(v.name ?? "").match(/(\d+)\s*GB\s*\/\s*(\d+\s*(?:GB|TB))/i);
    const ramGb = parseRamGb(parts?.[1]);
    const storageGb = parseStorageGb(parts?.[2] ?? v.name);
    const avail = String(v.offers?.availability ?? "").toLowerCase();
    out.push({
      side: "buy",
      source: "cashify_buy",
      source_product_id: String(v.sku ?? stableProductId("cashify_buy", brand, model, storageGb, v.color)),
      brand,
      model,
      storage_gb: storageGb,
      ram_gb: ramGb,
      color: v.color ?? null,
      condition: normalizeCondition(v.conditionGrade),
      price,
      currency: String(v.offers?.priceCurrency ?? "INR").toUpperCase(),
      mrp,
      discount_pct: computeDiscountPct(price, mrp),
      in_stock: avail ? avail.includes("instock") : null,
      source_url: String(v.offers?.url ?? "https://www.cashify.in/buy-refurbished-mobile-phones"),
      captured_at: capturedAt,
      run_id: runId,
      raw_payload: { ...v, warranty: v.warranty ?? "6 Months Warranty" },
    });
  }
  return out;
}

function getDotted(obj: unknown, dottedPath: string): unknown {
  if (!dottedPath) return obj;
  let curr: unknown = obj;
  for (const part of dottedPath.split(".")) {
    if (curr && typeof curr === "object" && !Array.isArray(curr) && part in curr) {
      curr = (curr as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return curr;
}

function parseGenericApiFixtures(runId: number, capturedAt: string): NormalizedPriceRecord[] {
  const yamlPath = path.join(SCRAPER_DIR, "config", "sources", "example_api.yaml");
  if (!fs.existsSync(yamlPath)) return [];
  const cfg = yaml.load(fs.readFileSync(yamlPath, "utf-8")) as {
    name?: string;
    url?: string;
    response?: { items_path?: string };
    field_map?: Record<string, { path?: string; transforms?: string[] } | string>;
  };
  const sourceName = String(cfg.name ?? "example_api");
  const itemsPath = String(cfg.response?.items_path ?? "data.products");
  const out: NormalizedPriceRecord[] = [];

  for (const fileName of ["generic_api_page1.json", "generic_api_page2.json"]) {
    const fp = path.join(FIXTURES_DIR, fileName);
    if (!fs.existsSync(fp)) continue;
    const payload = JSON.parse(fs.readFileSync(fp, "utf-8")) as Record<string, unknown>;
    const items = getDotted(payload, itemsPath);
    if (!Array.isArray(items)) continue;
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const item = rawItem as Record<string, unknown>;
      const brand = String(getDotted(item, "device.brand") ?? "Unknown").trim();
      const model = cleanModelName(String(getDotted(item, "device.model_name") ?? "Unknown"), brand);
      const price = Number(getDotted(item, "pricing.offer_price") ?? 0);
      if (!Number.isFinite(price) || price <= 0) continue;
      const mrpRaw = getDotted(item, "pricing.retail_mrp");
      const mrp = mrpRaw !== undefined && mrpRaw !== null ? Number(mrpRaw) : null;
      const storageGb = parseStorageGb(getDotted(item, "specs.storage"));
      const ramGb = parseRamGb(getDotted(item, "specs.ram"));
      const inStockRaw = getDotted(item, "availability.in_stock");
      const inStock =
        typeof inStockRaw === "boolean"
          ? inStockRaw
          : String(inStockRaw ?? "").toLowerCase() === "true";

      out.push({
        side: "sell",
        source: sourceName,
        source_product_id: String(getDotted(item, "sku_id") ?? stableProductId(sourceName, brand, model, storageGb)),
        brand,
        model,
        storage_gb: storageGb,
        ram_gb: ramGb,
        color: String(getDotted(item, "specs.color") ?? "").trim() || null,
        condition: normalizeCondition(String(getDotted(item, "grade") ?? "")),
        price,
        currency: String(getDotted(item, "pricing.currency") ?? "INR").trim().toUpperCase(),
        mrp,
        discount_pct: computeDiscountPct(price, mrp),
        in_stock: inStock,
        source_url: String(getDotted(item, "listing_url") ?? cfg.url ?? ""),
        captured_at: capturedAt,
        run_id: runId,
        raw_payload: item,
      });
    }
  }
  return out;
}

function parseAmazonNewHtml(
  html: string,
  runId: number,
  capturedAt: string,
  fetchMode: "live" | "fixture_fallback" = "fixture_fallback",
): NormalizedPriceRecord[] {
  const out: NormalizedPriceRecord[] = [];
  const itemRe = /<div[^>]*data-asin="([A-Z0-9]{10})"[^>]*>([\s\S]*?)(?=<div[^>]*data-asin="|<\/div>\s*<\/div>\s*<\/body>|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(html)) !== null) {
    const asin = match[1];
    const block = match[2];
    const href = block.match(/href="([^"]*\/dp\/[^"]+)"/i)?.[1] ?? `/dp/${asin}`;
    const titleRaw =
      block.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)?.[1] ??
      block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ??
      "";
    const title = titleRaw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!title || isRefurbishedOrUsedTitle(title)) continue;

    const priceStr = block.match(/class="a-price-whole"[^>]*>([\d,]+)/i)?.[1] ?? "";
    const price = Number(priceStr.replace(/,/g, ""));
    if (!Number.isFinite(price) || price <= 0) continue;

    const mrpStr =
      block.match(/class="a-text-price"[\s\S]*?class="a-offscreen"[^>]*>([^<]+)/i)?.[1] ?? "";
    const parsedMrp = Number(mrpStr.replace(/[^\d.]/g, ""));
    const mrp = sanitizeMrp(Number.isFinite(parsedMrp) && parsedMrp > 0 ? parsedMrp : null, price);

    const brand = deriveBrandFromTitle(title);
    const model = cleanModelName(title, brand);
    const storageGb = parseStorageGb(title);
    const ramGb = parseRamGb(title);
    const sourceUrl = href.startsWith("http") ? href : `https://www.amazon.in${href}`;

    out.push({
      side: "new",
      source: "amazon.in",
      source_product_id: asin,
      brand,
      model,
      storage_gb: storageGb,
      ram_gb: ramGb,
      color: null,
      condition: "new",
      price,
      currency: "INR",
      mrp,
      discount_pct: computeDiscountPct(price, mrp),
      in_stock: true,
      source_url: sourceUrl,
      captured_at: capturedAt,
      run_id: runId,
      raw_payload: { asin, title, fetch_mode: fetchMode, marketplace: "amazon.in" },
    });
  }
  return out;
}

function parseFlipkartNewHtml(
  html: string,
  runId: number,
  capturedAt: string,
  fetchMode: "live" | "fixture_fallback" = "fixture_fallback",
): NormalizedPriceRecord[] {
  const out: NormalizedPriceRecord[] = [];
  const cardRe = /<div[^>]*data-id="([A-Z0-9]+)"[^>]*>([\s\S]*?)(?=<div[^>]*data-id="|<\/div>\s*<\/body>|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = cardRe.exec(html)) !== null) {
    const fsn = match[1];
    const block = match[2];
    const href = block.match(/href="([^"]+)"/i)?.[1] ?? `/p/${fsn}`;
    const titleRaw =
      block.match(/class="KzDlHZ"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
      block.match(/class="_4rR01T"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
      "";
    const title = titleRaw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!title || isRefurbishedOrUsedTitle(title)) continue;

    const priceStr =
      block.match(/class="Nx9bqj[^"]*"[^>]*>([^<]+)/i)?.[1] ??
      block.match(/class="_30jeq3[^"]*"[^>]*>([^<]+)/i)?.[1] ??
      "";
    const price = Number(priceStr.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(price) || price <= 0) continue;

    const mrpStr =
      block.match(/class="yRaY8j[^"]*"[^>]*>([^<]+)/i)?.[1] ??
      block.match(/class="_3I9_wc[^"]*"[^>]*>([^<]+)/i)?.[1] ??
      "";
    const parsedMrp = Number(mrpStr.replace(/[^\d.]/g, ""));
    const mrp = sanitizeMrp(Number.isFinite(parsedMrp) && parsedMrp > 0 ? parsedMrp : null, price);

    const brand = deriveBrandFromTitle(title);
    const model = cleanModelName(title, brand);
    const storageGb = parseStorageGb(title);
    const ramGb = parseRamGb(title);
    const sourceUrl = href.startsWith("http") ? href : `https://www.flipkart.com${href}`;

    out.push({
      side: "new",
      source: "flipkart",
      source_product_id: fsn,
      brand,
      model,
      storage_gb: storageGb,
      ram_gb: ramGb,
      color: null,
      condition: "new",
      price,
      currency: "INR",
      mrp,
      discount_pct: computeDiscountPct(price, mrp),
      in_stock: true,
      source_url: sourceUrl,
      captured_at: capturedAt,
      run_id: runId,
      raw_payload: { fsn, title, fetch_mode: fetchMode, marketplace: "flipkart" },
    });
  }
  return out;
}

async function scrapeNewDevicesSource(
  source: "amazon.in" | "flipkart",
  phoneQuery: string,
  runId: number,
  capturedAt: string,
): Promise<NormalizedPriceRecord[]> {
  const q = phoneQuery !== "all" ? phoneQuery : "5g smartphone";
  const targetUrl =
    source === "amazon.in"
      ? `https://www.amazon.in/s?k=${encodeURIComponent(q)}`
      : `https://www.flipkart.com/search?q=${encodeURIComponent(q)}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "en-IN,en;q=0.9",
      },
    });
    clearTimeout(timer);
    if (resp.ok) {
      const html = await resp.text();
      const parsed =
        source === "amazon.in"
          ? parseAmazonNewHtml(html, runId, capturedAt, "live")
          : parseFlipkartNewHtml(html, runId, capturedAt, "live");
      if (parsed.length > 0) return parsed;
    }
  } catch {
    // Fallback to saved marketplace HTML fixture when live host blocks or is offline
  }

  const fixtureFile = source === "amazon.in" ? "amazon_new.html" : "flipkart_new.html";
  const fp = path.join(FIXTURES_DIR, fixtureFile);
  if (!fs.existsSync(fp)) return [];
  const html = fs.readFileSync(fp, "utf-8");
  return source === "amazon.in"
    ? parseAmazonNewHtml(html, runId, capturedAt, "fixture_fallback")
    : parseFlipkartNewHtml(html, runId, capturedAt, "fixture_fallback");
}

function parseAttr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim() : null;
}

function parseSamsungPartsHtml(
  html: string,
  runId: number,
  capturedAt: string,
  fetchMode: "live" | "fixture_fallback" = "fixture_fallback",
): NormalizedPriceRecord[] {
  const out: NormalizedPriceRecord[] = [];
  const rowRe = /<tr\s+class="samsung-part-row"([^>]*)>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html)) !== null) {
    const attrs = match[1];
    const brand = parseAttr(attrs, "data-brand") ?? "Samsung";
    const model = parseAttr(attrs, "data-model") ?? "Unknown";
    const partId = parseAttr(attrs, "data-part-id") ?? stableProductId("samsung_parts", model, attrs);
    const partCategory = parseAttr(attrs, "data-category") ?? "Component";
    const partName = parseAttr(attrs, "data-part-name") ?? "OEM Spare Part";
    const price = Number((parseAttr(attrs, "data-price") ?? "0").replace(/[^\d.]/g, ""));
    if (!Number.isFinite(price) || price <= 0) continue;
    const rawMrpVal = Number((parseAttr(attrs, "data-mrp") ?? "").replace(/[^\d.]/g, ""));
    const mrp = sanitizeMrp(Number.isFinite(rawMrpVal) && rawMrpVal > 0 ? rawMrpVal : null, price);
    const currency = parseAttr(attrs, "data-currency") ?? "INR";
    const warranty = parseAttr(attrs, "data-warranty") ?? "90 Days Official Part Warranty";
    const url =
      parseAttr(attrs, "data-url") ??
      "https://www.samsung.com/in/support/spare-part-pricing-list-for-repair/";

    out.push({
      side: "parts",
      source: "samsung_parts",
      source_product_id: partId,
      brand,
      model,
      storage_gb: null,
      ram_gb: null,
      color: null,
      condition: "new",
      part_category: partCategory,
      part_name: partName,
      price,
      currency,
      mrp,
      discount_pct: computeDiscountPct(price, mrp),
      in_stock: true,
      source_url: url,
      captured_at: capturedAt,
      run_id: runId,
      raw_payload: {
        part_code: partId,
        part_category: partCategory,
        part_name: partName,
        warranty,
        fetch_mode: fetchMode,
        oem_source: "samsung.com/in",
      },
    });
  }
  return out;
}

function parseApplePartsHtml(
  html: string,
  runId: number,
  capturedAt: string,
  fetchMode: "live" | "fixture_fallback" = "fixture_fallback",
): NormalizedPriceRecord[] {
  const out: NormalizedPriceRecord[] = [];
  const itemRe = /<div\s+class="apple-repair-item"([^>]*)>([\s\S]*?)<\/div>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(html)) !== null) {
    const attrs = match[1];
    const brand = parseAttr(attrs, "data-brand") ?? "Apple";
    const model = parseAttr(attrs, "data-model") ?? "Unknown";
    const partId = parseAttr(attrs, "data-part-id") ?? stableProductId("apple_parts", model, attrs);
    const partCategory = parseAttr(attrs, "data-category") ?? "Component";
    const partName = parseAttr(attrs, "data-part-name") ?? "Apple Genuine Part";
    const price = Number((parseAttr(attrs, "data-price") ?? "0").replace(/[^\d.]/g, ""));
    if (!Number.isFinite(price) || price <= 0) continue;
    const appleCarePrice = Number((parseAttr(attrs, "data-applecare") ?? "").replace(/[^\d.]/g, ""));
    const currency = parseAttr(attrs, "data-currency") ?? "INR";
    const warranty = parseAttr(attrs, "data-warranty") ?? "Apple Genuine Part · 90-Day Service Warranty";
    const url = parseAttr(attrs, "data-url") ?? "https://support.apple.com/en-in/iphone/repair";

    out.push({
      side: "parts",
      source: "apple_parts",
      source_product_id: partId,
      brand,
      model,
      storage_gb: null,
      ram_gb: null,
      color: null,
      condition: "new",
      part_category: partCategory,
      part_name: partName,
      price,
      currency,
      mrp: null,
      discount_pct: null,
      in_stock: true,
      source_url: url,
      captured_at: capturedAt,
      run_id: runId,
      raw_payload: {
        part_code: partId,
        part_category: partCategory,
        part_name: partName,
        applecare_plus_fee_inr: Number.isFinite(appleCarePrice) ? appleCarePrice : null,
        warranty,
        fetch_mode: fetchMode,
        oem_source: "support.apple.com/en-in",
      },
    });
  }
  return out;
}

async function scrapePartsPricingSource(
  source: "samsung_parts" | "apple_parts",
  runId: number,
  capturedAt: string,
): Promise<NormalizedPriceRecord[]> {
  const targetUrl =
    source === "samsung_parts"
      ? "https://www.samsung.com/in/support/spare-part-pricing-list-for-repair/"
      : "https://support.apple.com/en-in/iphone/repair";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "en-IN,en;q=0.9",
      },
    });
    clearTimeout(timer);
    if (resp.ok) {
      const html = await resp.text();
      const parsed =
        source === "samsung_parts"
          ? parseSamsungPartsHtml(html, runId, capturedAt, "live")
          : parseApplePartsHtml(html, runId, capturedAt, "live");
      if (parsed.length > 0) return parsed;
    }
  } catch {
    // Fallback to official spare-part & repair pricing fixtures when JS-rendered or offline
  }

  const fixtureFile = source === "samsung_parts" ? "samsung_parts.html" : "apple_parts.html";
  const fp = path.join(FIXTURES_DIR, fixtureFile);
  if (!fs.existsSync(fp)) return [];
  const html = fs.readFileSync(fp, "utf-8");
  return source === "samsung_parts"
    ? parseSamsungPartsHtml(html, runId, capturedAt, "fixture_fallback")
    : parseApplePartsHtml(html, runId, capturedAt, "fixture_fallback");
}

function loadInitialWorkspaceData(): {
  records: NormalizedPriceRecord[];
  runs: ScrapeRun[];
  sourceConfigs: SourceConfigSummary[];
} {
  const records: NormalizedPriceRecord[] = [];
  const seen = new Map<string, number>();

  const upsert = (rec: NormalizedPriceRecord): void => {
    const day = rec.captured_at.slice(0, 10);
    const key = `${rec.source}|${rec.source_product_id}|${rec.condition}|${rec.storage_gb ?? -1}|${day}`;
    const existingIdx = seen.get(key);
    if (existingIdx !== undefined) {
      records[existingIdx] = rec;
    } else {
      seen.set(key, records.length);
      records.push(rec);
    }
  };

  // 1. Load real output.json (Cashify sell & trade-in records)
  const outputJsonPath = path.join(ROOT_DIR, "output.json");
  if (fs.existsSync(outputJsonPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(outputJsonPath, "utf-8")) as Array<Record<string, unknown>>;
      for (const r of raw) {
        const price = Number(r.price ?? r.buyback_price ?? 0);
        if (!Number.isFinite(price) || price <= 0) continue;
        const brand = String(r.brand ?? "Unknown").trim();
        const model = cleanModelName(String(r.model ?? "Unknown"), brand);
        const storageGb = parseStorageGb(r.storage_gb ?? r.storage);
        const ramGb = parseRamGb(r.ram_gb ?? r.ram);
        const cond = normalizeCondition(String(r.condition_grade ?? r.condition ?? ""));
        const capturedAt = ensureIsoTimestamp(
          r.scraped_at ?? r.timestamp,
          "2026-11-13T13:36:43.809Z",
        );
        const rawMrpVal = r.original_mrp !== null && r.original_mrp !== undefined ? Number(r.original_mrp) : null;
        const mrpVal = sanitizeMrp(rawMrpVal, price);
        const rawSrcName = String(r.source_name ?? "cashify_sell");
        const side = classifyMarketSide(rawSrcName, r.is_renewed);
        const srcName = rawSrcName === "Amazon India" && side === "new" ? "amazon.in" : rawSrcName;
        upsert({
          side,
          source: srcName,
          source_product_id: String(r.asin ?? r.device_id ?? stableProductId(srcName, brand, model, storageGb)),
          brand,
          model,
          storage_gb: storageGb,
          ram_gb: ramGb,
          color: r.color ? String(r.color) : null,
          condition: side === "new" ? "new" : cond,
          price,
          currency: String(r.currency ?? "INR"),
          mrp: mrpVal,
          discount_pct: computeDiscountPct(price, mrpVal),
          in_stock: side === "new" ? true : null,
          source_url: String(r.source_url ?? "https://www.cashify.in"),
          captured_at: capturedAt,
          run_id: 1,
          raw_payload: r,
        });
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  // 2. Load cashify_buy_prices_report.csv (historical buyback report)
  const buyCsvPath = path.join(ROOT_DIR, "cashify_buy_prices_report.csv");
  if (fs.existsSync(buyCsvPath)) {
    const rows = parseCsvRows(fs.readFileSync(buyCsvPath, "utf-8"));
    for (const r of rows) {
      const price = Number(r.buyback_price ?? 0);
      if (!Number.isFinite(price) || price <= 0) continue;
      const brand = r.brand || "Unknown";
      const model = cleanModelName(r.model || "Unknown", brand);
      const storageGb = parseStorageGb(r.storage);
      const ramGb = parseRamGb(r.ram);
      const cond = normalizeCondition(r.condition);
      const scrapedAt = ensureIsoTimestamp(r.scraped_at, "2026-11-02T14:14:55.000Z");
      upsert({
        side: "sell",
        source: "cashify_sell",
        source_product_id: r.id ? `cb-${r.id}` : stableProductId("cashify_sell", brand, model, storageGb),
        brand,
        model,
        storage_gb: storageGb,
        ram_gb: ramGb,
        color: r.color || null,
        condition: cond,
        price,
        currency: r.currency || "INR",
        mrp: null,
        discount_pct: null,
        in_stock: null,
        source_url: r.source_url || "https://www.cashify.in",
        captured_at: scrapedAt,
        run_id: 2,
        raw_payload: r,
      });
    }
  }

  // 3. Load cashify_sell_refurbished_prices_report.csv (Cashify refurbished buy listings)
  const refCsvPath = path.join(ROOT_DIR, "cashify_sell_refurbished_prices_report.csv");
  if (fs.existsSync(refCsvPath)) {
    const rows = parseCsvRows(fs.readFileSync(refCsvPath, "utf-8"));
    for (const r of rows) {
      const price = Number(r.selling_price ?? 0);
      if (!Number.isFinite(price) || price <= 0) continue;
      const brand = r.brand || "Unknown";
      const model = cleanModelName(r.model || "Unknown", brand);
      const storageGb = parseStorageGb(r.storage);
      const ramGb = parseRamGb(r.ram);
      const mrp = sanitizeMrp(r.original_mrp ? Number(r.original_mrp) : null, price);
      const disc = r.discount_percent ? Number(r.discount_percent) : computeDiscountPct(price, mrp);
      const avail = (r.availability || "").toLowerCase();
      upsert({
        side: "buy",
        source: "cashify_buy",
        source_product_id: r.sku || stableProductId("cashify_buy", brand, model, storageGb, r.color),
        brand,
        model,
        storage_gb: storageGb,
        ram_gb: ramGb,
        color: r.color || null,
        condition: normalizeCondition(r.refurbished_grade || r.device_condition),
        price,
        currency: r.currency || "INR",
        mrp,
        discount_pct: disc && Number.isFinite(disc) ? disc : null,
        in_stock: avail ? avail === "instock" : null,
        source_url: r.source_url || "https://www.cashify.in/buy-refurbished-mobile-phones",
        captured_at: ensureIsoTimestamp(r.scraped_at, "2026-11-09T07:19:20.000Z"),
        run_id: 3,
        raw_payload: r,
      });
    }
  }

  // 4. Load fixture datasets for amazon_sell, cashify_sell, cashify_buy, example_api, amazon.in, and flipkart
  const fixtureTs = "2026-11-17T06:00:00+00:00";
  const amazonPath = path.join(FIXTURES_DIR, "amazon_sell.html");
  if (fs.existsSync(amazonPath)) {
    for (const rec of parseAmazonFixture(fs.readFileSync(amazonPath, "utf-8"), 4, fixtureTs)) {
      upsert(rec);
    }
  }
  const sellPath = path.join(FIXTURES_DIR, "cashify_sell.html");
  if (fs.existsSync(sellPath)) {
    for (const rec of parseCashifySellFixture(fs.readFileSync(sellPath, "utf-8"), 5, fixtureTs)) {
      upsert(rec);
    }
  }
  const buyPath = path.join(FIXTURES_DIR, "cashify_buy.html");
  if (fs.existsSync(buyPath)) {
    for (const rec of parseCashifyBuyFixture(fs.readFileSync(buyPath, "utf-8"), 6, fixtureTs)) {
      upsert(rec);
    }
  }
  for (const rec of parseGenericApiFixtures(7, fixtureTs)) {
    upsert(rec);
  }
  const amazonNewPath = path.join(FIXTURES_DIR, "amazon_new.html");
  if (fs.existsSync(amazonNewPath)) {
    for (const rec of parseAmazonNewHtml(fs.readFileSync(amazonNewPath, "utf-8"), 8, fixtureTs)) {
      upsert(rec);
    }
  }
  const flipkartNewPath = path.join(FIXTURES_DIR, "flipkart_new.html");
  if (fs.existsSync(flipkartNewPath)) {
    for (const rec of parseFlipkartNewHtml(fs.readFileSync(flipkartNewPath, "utf-8"), 9, fixtureTs)) {
      upsert(rec);
    }
  }
  const samsungPartsPath = path.join(FIXTURES_DIR, "samsung_parts.html");
  if (fs.existsSync(samsungPartsPath)) {
    for (const rec of parseSamsungPartsHtml(fs.readFileSync(samsungPartsPath, "utf-8"), 10, fixtureTs)) {
      upsert(rec);
    }
  }
  const applePartsPath = path.join(FIXTURES_DIR, "apple_parts.html");
  if (fs.existsSync(applePartsPath)) {
    for (const rec of parseApplePartsHtml(fs.readFileSync(applePartsPath, "utf-8"), 11, fixtureTs)) {
      upsert(rec);
    }
  }

  // 5. Read YAML source configs from phone-price-scraper/config/
  const sourceConfigs: SourceConfigSummary[] = [];
  const settingsYaml = path.join(SCRAPER_DIR, "config", "settings.yaml");
  if (fs.existsSync(settingsYaml)) {
    const parsed = yaml.load(fs.readFileSync(settingsYaml, "utf-8")) as {
      sources?: Record<string, { enabled?: boolean; urls?: string[] }>;
    };
    for (const [name, cfg] of Object.entries(parsed?.sources ?? {})) {
      sourceConfigs.push({
        name,
        kind: "playwright",
        enabled: cfg.enabled ?? true,
        urls: cfg.urls ?? [],
      });
    }
  }
  const sourcesDir = path.join(SCRAPER_DIR, "config", "sources");
  if (fs.existsSync(sourcesDir)) {
    for (const file of fs.readdirSync(sourcesDir)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const cfg = yaml.load(fs.readFileSync(path.join(sourcesDir, file), "utf-8")) as {
        name?: string;
        enabled?: boolean;
        url?: string;
        auth?: { type?: string };
        pagination?: { type?: string };
      };
      sourceConfigs.push({
        name: `api:${cfg.name ?? path.basename(file, path.extname(file))}`,
        kind: "generic_api",
        enabled: cfg.enabled ?? true,
        urls: cfg.url ? [cfg.url] : [],
        auth_type: cfg.auth?.type ?? "none",
        pagination_type: cfg.pagination?.type ?? "none",
      });
    }
  }

  const runs: ScrapeRun[] = [
    {
      id: 11,
      source: "apple_parts",
      started_at: "2026-11-17T06:00:00Z",
      finished_at: "2026-11-17T06:00:03Z",
      status: "success",
      records_count: records.filter((r) => r.run_id === 11).length,
      error_message: null,
    },
    {
      id: 10,
      source: "samsung_parts",
      started_at: "2026-11-17T06:00:00Z",
      finished_at: "2026-11-17T06:00:04Z",
      status: "success",
      records_count: records.filter((r) => r.run_id === 10).length,
      error_message: null,
    },
    {
      id: 7,
      source: "example_api",
      started_at: "2026-11-17T06:00:00Z",
      finished_at: "2026-11-17T06:00:04Z",
      status: "success",
      records_count: records.filter((r) => r.run_id === 7).length,
      error_message: null,
    },
    {
      id: 4,
      source: "amazon_sell",
      started_at: "2026-11-17T05:58:10Z",
      finished_at: "2026-11-17T05:58:19Z",
      status: "success",
      records_count: records.filter((r) => r.run_id === 4).length,
      error_message: null,
    },
    {
      id: 3,
      source: "cashify_buy",
      started_at: "2026-11-09T07:19:00Z",
      finished_at: "2026-11-09T07:19:20Z",
      status: "success",
      records_count: records.filter((r) => r.run_id === 3).length,
      error_message: null,
    },
    {
      id: 1,
      source: "cashify_sell",
      started_at: "2026-11-13T13:36:10Z",
      finished_at: "2026-11-13T13:36:43Z",
      status: "success",
      records_count: records.filter((r) => r.run_id === 1).length,
      error_message: null,
    },
  ];

  return { records, runs, sourceConfigs };
}

function isoWeekToken(isoDateStr: string): string {
  const dt = new Date(isoDateStr);
  const utc = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function stats(nums: number[]): { avg: number; min: number; max: number; median: number } {
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    avg: Math.round((sum / sorted.length) * 100) / 100,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: Math.round(median * 100) / 100,
  };
}

function computeTrends(
  records: NormalizedPriceRecord[],
  granularity: ExportGranularity,
  modelFilter?: string,
  sourceFilter?: string,
): TrendRow[] {
  let filtered = records;
  if (modelFilter && modelFilter.trim() !== "") {
    const q = modelFilter.trim().toLowerCase();
    filtered = filtered.filter(
      (r) => r.model.toLowerCase().includes(q) || `${r.brand} ${r.model}`.toLowerCase().includes(q),
    );
  }
  if (sourceFilter && sourceFilter !== "all") {
    filtered = filtered.filter((r) => r.source === sourceFilter);
  }

  type GroupMap = Map<string, { meta: { brand: string; model: string; source: string; condition: string }; days: Map<string, number[]> }>;
  const series: GroupMap = new Map();

  for (const r of filtered) {
    const gKey = `${r.brand}|${r.model}|${r.source}|${r.condition}`;
    let entry = series.get(gKey);
    if (!entry) {
      entry = {
        meta: { brand: r.brand, model: r.model, source: r.source, condition: r.condition },
        days: new Map(),
      };
      series.set(gKey, entry);
    }
    const dayStr = r.captured_at.slice(0, 10);
    const arr = entry.days.get(dayStr) ?? [];
    arr.push(r.price);
    entry.days.set(dayStr, arr);
  }

  const results: TrendRow[] = [];

  for (const { meta, days } of series.values()) {
    const sortedDays = [...days.keys()].sort();
    const weekBuckets = new Map<string, number[]>();
    const monthBuckets = new Map<string, number[]>();

    for (const day of sortedDays) {
      const prices = days.get(day) ?? [];
      const wk = isoWeekToken(`${day}T00:00:00Z`);
      const mo = day.slice(0, 7);
      weekBuckets.set(wk, [...(weekBuckets.get(wk) ?? []), ...prices]);
      monthBuckets.set(mo, [...(monthBuckets.get(mo) ?? []), ...prices]);
    }

    const sortedWeeks = [...weekBuckets.keys()].sort();
    const weekAvgs = new Map<string, ReturnType<typeof stats>>();
    for (const w of sortedWeeks) {
      weekAvgs.set(w, stats(weekBuckets.get(w) ?? [0]));
    }

    const sortedMonths = [...monthBuckets.keys()].sort();
    const monthAvgs = new Map<string, ReturnType<typeof stats>>();
    for (const m of sortedMonths) {
      monthAvgs.set(m, stats(monthBuckets.get(m) ?? [0]));
    }

    const dailyAvgs: Array<{ day: string; st: ReturnType<typeof stats>; ma7: number; ma30: number; dodAbs: number | null; dodPct: number | null }> = [];
    for (let i = 0; i < sortedDays.length; i++) {
      const day = sortedDays[i];
      const st = stats(days.get(day) ?? [0]);
      const prev = i > 0 ? dailyAvgs[i - 1].st.avg : null;
      const dodAbs = prev !== null ? Math.round((st.avg - prev) * 100) / 100 : null;
      const dodPct = prev !== null && prev !== 0 ? Math.round(((st.avg - prev) / prev) * 10000) / 100 : null;
      const win7 = dailyAvgs.slice(Math.max(0, i - 6), i).map((d) => d.st.avg).concat(st.avg);
      const win30 = dailyAvgs.slice(Math.max(0, i - 29), i).map((d) => d.st.avg).concat(st.avg);
      const ma7 = Math.round((win7.reduce((a, b) => a + b, 0) / win7.length) * 100) / 100;
      const ma30 = Math.round((win30.reduce((a, b) => a + b, 0) / win30.length) * 100) / 100;
      dailyAvgs.push({ day, st, ma7, ma30, dodAbs, dodPct });
    }

    const getWow = (wk: string): { abs: number | null; pct: number | null } => {
      const idx = sortedWeeks.indexOf(wk);
      if (idx <= 0) return { abs: null, pct: null };
      const curr = weekAvgs.get(wk)?.avg ?? 0;
      const prev = weekAvgs.get(sortedWeeks[idx - 1])?.avg ?? 0;
      if (!prev) return { abs: null, pct: null };
      return {
        abs: Math.round((curr - prev) * 100) / 100,
        pct: Math.round(((curr - prev) / prev) * 10000) / 100,
      };
    };

    const getMom = (mo: string): { abs: number | null; pct: number | null } => {
      const idx = sortedMonths.indexOf(mo);
      if (idx <= 0) return { abs: null, pct: null };
      const curr = monthAvgs.get(mo)?.avg ?? 0;
      const prev = monthAvgs.get(sortedMonths[idx - 1])?.avg ?? 0;
      if (!prev) return { abs: null, pct: null };
      return {
        abs: Math.round((curr - prev) * 100) / 100,
        pct: Math.round(((curr - prev) / prev) * 10000) / 100,
      };
    };

    if (granularity === "daily") {
      for (const d of dailyAvgs) {
        const wk = isoWeekToken(`${d.day}T00:00:00Z`);
        const mo = d.day.slice(0, 7);
        const wow = getWow(wk);
        const mom = getMom(mo);
        results.push({
          ...meta,
          bucket_date: d.day,
          avg_price: d.st.avg,
          min_price: d.st.min,
          max_price: d.st.max,
          median_price: d.st.median,
          dod_abs: d.dodAbs,
          dod_pct: d.dodPct,
          wow_abs: wow.abs,
          wow_pct: wow.pct,
          mom_abs: mom.abs,
          mom_pct: mom.pct,
          ma_7d: d.ma7,
          ma_30d: d.ma30,
        });
      }
    } else if (granularity === "weekly") {
      for (const wk of sortedWeeks) {
        const st = weekAvgs.get(wk)!;
        const lastDaily = [...dailyAvgs].reverse().find((d) => isoWeekToken(`${d.day}T00:00:00Z`) === wk);
        const mo = lastDaily ? lastDaily.day.slice(0, 7) : wk.slice(0, 4) + "-01";
        const wow = getWow(wk);
        const mom = getMom(mo);
        results.push({
          ...meta,
          bucket_date: wk,
          avg_price: st.avg,
          min_price: st.min,
          max_price: st.max,
          median_price: st.median,
          dod_abs: lastDaily?.dodAbs ?? null,
          dod_pct: lastDaily?.dodPct ?? null,
          wow_abs: wow.abs,
          wow_pct: wow.pct,
          mom_abs: mom.abs,
          mom_pct: mom.pct,
          ma_7d: lastDaily?.ma7 ?? st.avg,
          ma_30d: lastDaily?.ma30 ?? st.avg,
        });
      }
    } else {
      for (const mo of sortedMonths) {
        const st = monthAvgs.get(mo)!;
        const lastDaily = [...dailyAvgs].reverse().find((d) => d.day.slice(0, 7) === mo);
        const wk = lastDaily ? isoWeekToken(`${lastDaily.day}T00:00:00Z`) : `${mo}-W01`;
        const wow = getWow(wk);
        const mom = getMom(mo);
        results.push({
          ...meta,
          bucket_date: mo,
          avg_price: st.avg,
          min_price: st.min,
          max_price: st.max,
          median_price: st.median,
          dod_abs: lastDaily?.dodAbs ?? null,
          dod_pct: lastDaily?.dodPct ?? null,
          wow_abs: wow.abs,
          wow_pct: wow.pct,
          mom_abs: mom.abs,
          mom_pct: mom.pct,
          ma_7d: lastDaily?.ma7 ?? st.avg,
          ma_30d: lastDaily?.ma30 ?? st.avg,
        });
      }
    }
  }

  return results.sort((a, b) => b.bucket_date.localeCompare(a.bucket_date) || a.model.localeCompare(b.model));
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const esc = (val: unknown): string => {
    if (val === null || val === undefined) return "";
    const s = String(val);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => esc(r[h])).join(",")),
  ].join("\n") + "\n";
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  const state = loadInitialWorkspaceData();
  let nextRunId = Math.max(10, ...state.runs.map((r) => r.id)) + 1;

  app.get("/api/overview", (_req, res) => {
    const phones = Array.from(
      new Set(state.records.map((r) => `${r.brand} ${r.model}`.trim())),
    ).sort((a, b) => a.localeCompare(b));
    const buyRecords = state.records.filter((r) => r.side === "buy");
    const sellRecords = state.records.filter((r) => r.side === "sell");
    const newRecords = state.records.filter((r) => r.side === "new");
    const partsRecords = state.records.filter((r) => r.side === "parts");
    const buyPhones = Array.from(
      new Set(buyRecords.map((r) => `${r.brand} ${r.model}`.trim())),
    ).sort((a, b) => a.localeCompare(b));
    const sellPhones = Array.from(
      new Set(sellRecords.map((r) => `${r.brand} ${r.model}`.trim())),
    ).sort((a, b) => a.localeCompare(b));
    const newPhones = Array.from(
      new Set(newRecords.map((r) => `${r.brand} ${r.model}`.trim())),
    ).sort((a, b) => a.localeCompare(b));
    const partsPhones = Array.from(
      new Set(partsRecords.map((r) => `${r.brand} ${r.model}`.trim())),
    ).sort((a, b) => a.localeCompare(b));

    const sources = Array.from(new Set(state.records.map((r) => r.source))).sort();
    const buySources = Array.from(new Set(buyRecords.map((r) => r.source))).sort();
    const sellSources = Array.from(new Set(sellRecords.map((r) => r.source))).sort();
    const newSources = ["amazon.in", "flipkart"];
    const partsSources = ["apple_parts", "samsung_parts"];
    const partCategories = Array.from(
      new Set(partsRecords.map((r) => r.part_category).filter((v): v is string => Boolean(v))),
    ).sort((a, b) => a.localeCompare(b));
    const latest = state.records
      .map((r) => r.captured_at)
      .sort()
      .at(-1) ?? null;
    const avgPrice =
      state.records.length > 0
        ? Math.round(
            (state.records.reduce((acc, r) => acc + r.price, 0) / state.records.length) * 100,
          ) / 100
        : 0;

    res.json({
      kpis: {
        total_snapshots: state.records.length,
        buy_snapshots: buyRecords.length,
        sell_snapshots: sellRecords.length,
        new_snapshots: newRecords.length,
        parts_snapshots: partsRecords.length,
        unique_models: phones.length,
        sources_count: sources.length,
        latest_captured_at: latest,
        avg_price: avgPrice,
      },
      phones,
      buy_phones: buyPhones,
      sell_phones: sellPhones,
      new_phones: newPhones,
      parts_phones: partsPhones,
      sources,
      buy_sources: buySources,
      sell_sources: sellSources,
      new_sources: newSources,
      parts_sources: partsSources,
      part_categories: partCategories,
      source_configs: state.sourceConfigs,
      recent_runs: state.runs.slice(0, 12),
    });
  });

  app.get("/api/snapshots", (req, res) => {
    const side = String(req.query.side ?? "all");
    const source = String(req.query.source ?? "all");
    const phone = String(req.query.phone ?? "all");
    const condition = String(req.query.condition ?? "all");
    const partCategory = String(req.query.part_category ?? "all");
    const q = String(req.query.q ?? "").trim().toLowerCase();
    const limit = Math.min(250, Math.max(1, Number(req.query.limit ?? 100)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));

    let filtered = state.records;
    if (side === "buy" || side === "sell" || side === "new" || side === "parts") {
      filtered = filtered.filter((r) => r.side === side);
    }
    if (source !== "all") filtered = filtered.filter((r) => r.source === source);
    if (phone !== "all") {
      filtered = filtered.filter((r) => `${r.brand} ${r.model}`.trim() === phone);
    }
    if (condition !== "all") filtered = filtered.filter((r) => r.condition === condition);
    if (partCategory !== "all") {
      filtered = filtered.filter((r) => r.part_category === partCategory);
    }
    if (q) {
      filtered = filtered.filter(
        (r) =>
          r.model.toLowerCase().includes(q) ||
          r.brand.toLowerCase().includes(q) ||
          r.source.toLowerCase().includes(q) ||
          r.source_product_id.toLowerCase().includes(q) ||
          (r.part_name ?? "").toLowerCase().includes(q) ||
          (r.part_category ?? "").toLowerCase().includes(q),
      );
    }

    const sorted = [...filtered].sort((a, b) =>
      b.captured_at.localeCompare(a.captured_at) || a.model.localeCompare(b.model),
    );
    res.json({
      total: sorted.length,
      records: sorted.slice(offset, offset + limit),
    });
  });

  app.post("/api/scrape", async (req, res) => {
    const requestedSide = String(req.body?.side ?? "all");
    const requestedSource = String(req.body?.source ?? "all");
    const requestedPhone = String(req.body?.phone ?? "all");
    const requestedPartCategory = String(req.body?.part_category ?? "all");
    const nowIso = new Date().toISOString();
    const runId = nextRunId++;

    // Parts Pricing tab ONLY scrapes official spare parts / repair pricing from Samsung & Apple
    if (requestedSide === "parts") {
      const allowedPartsSources: Array<"samsung_parts" | "apple_parts"> =
        requestedSource === "samsung_parts" || requestedSource === "apple_parts"
          ? [requestedSource]
          : ["samsung_parts", "apple_parts"];

      const collectedParts: NormalizedPriceRecord[] = [];
      for (const src of allowedPartsSources) {
        const items = await scrapePartsPricingSource(src, runId, nowIso);
        collectedParts.push(...items);
      }

      let filteredParts =
        requestedPhone === "all"
          ? collectedParts
          : collectedParts.filter(
              (r) =>
                `${r.brand} ${r.model}`.toLowerCase().includes(requestedPhone.toLowerCase()) ||
                r.model.toLowerCase().includes(requestedPhone.toLowerCase()),
            );

      if (requestedPartCategory !== "all") {
        filteredParts = filteredParts.filter((r) => r.part_category === requestedPartCategory);
      }

      const todayUtc = nowIso.slice(0, 10);
      for (const rec of filteredParts) {
        const idx = state.records.findIndex(
          (existing) =>
            existing.source === rec.source &&
            existing.source_product_id === rec.source_product_id &&
            existing.condition === rec.condition &&
            (existing.storage_gb ?? -1) === (rec.storage_gb ?? -1) &&
            existing.captured_at.slice(0, 10) === todayUtc,
        );
        if (idx >= 0) {
          state.records[idx] = rec;
        } else {
          state.records.unshift(rec);
        }
      }

      const runRecord: ScrapeRun = {
        id: runId,
        source: allowedPartsSources.join(","),
        started_at: nowIso,
        finished_at: new Date().toISOString(),
        status: "success",
        records_count: filteredParts.length,
        error_message: null,
      };
      state.runs.unshift(runRecord);
      res.json({ run: runRecord, collected_count: filteredParts.length, records: filteredParts });
      return;
    }

    // New Devices tab ONLY scrapes brand-new devices from amazon.in and flipkart
    if (requestedSide === "new") {
      const allowedNewSources: Array<"amazon.in" | "flipkart"> =
        requestedSource === "amazon.in" || requestedSource === "flipkart"
          ? [requestedSource]
          : ["amazon.in", "flipkart"];

      const collectedNew: NormalizedPriceRecord[] = [];
      for (const src of allowedNewSources) {
        const items = await scrapeNewDevicesSource(src, requestedPhone, runId, nowIso);
        collectedNew.push(...items);
      }

      const filteredNew =
        requestedPhone === "all"
          ? collectedNew
          : collectedNew.filter(
              (r) =>
                `${r.brand} ${r.model}`.toLowerCase().includes(requestedPhone.toLowerCase()) ||
                r.model.toLowerCase().includes(requestedPhone.toLowerCase()),
            );

      const todayUtc = nowIso.slice(0, 10);
      for (const rec of filteredNew) {
        const idx = state.records.findIndex(
          (existing) =>
            existing.source === rec.source &&
            existing.source_product_id === rec.source_product_id &&
            existing.condition === rec.condition &&
            (existing.storage_gb ?? -1) === (rec.storage_gb ?? -1) &&
            existing.captured_at.slice(0, 10) === todayUtc,
        );
        if (idx >= 0) {
          state.records[idx] = rec;
        } else {
          state.records.unshift(rec);
        }
      }

      const runRecord: ScrapeRun = {
        id: runId,
        source: allowedNewSources.join(","),
        started_at: nowIso,
        finished_at: new Date().toISOString(),
        status: "success",
        records_count: filteredNew.length,
        error_message: null,
      };
      state.runs.unshift(runRecord);
      res.json({ run: runRecord, collected_count: filteredNew.length, records: filteredNew });
      return;
    }

    const defaultSourcesForSide =
      requestedSide === "buy"
        ? ["cashify_buy"]
        : requestedSide === "sell"
          ? ["cashify_sell", "amazon_sell", "example_api"]
          : ["cashify_sell", "cashify_buy", "amazon_sell", "example_api"];

    const runSources =
      requestedSource === "all"
        ? defaultSourcesForSide
        : [requestedSource.replace(/^api:/, "")];

    const collected: NormalizedPriceRecord[] = [];
    for (const src of runSources) {
      if (src === "cashify_sell") {
        const fp = path.join(FIXTURES_DIR, "cashify_sell.html");
        if (fs.existsSync(fp)) {
          collected.push(...parseCashifySellFixture(fs.readFileSync(fp, "utf-8"), runId, nowIso));
        }
      } else if (src === "cashify_buy") {
        const fp = path.join(FIXTURES_DIR, "cashify_buy.html");
        if (fs.existsSync(fp)) {
          collected.push(...parseCashifyBuyFixture(fs.readFileSync(fp, "utf-8"), runId, nowIso));
        }
      } else if (src === "amazon_sell") {
        const fp = path.join(FIXTURES_DIR, "amazon_sell.html");
        if (fs.existsSync(fp)) {
          collected.push(...parseAmazonFixture(fs.readFileSync(fp, "utf-8"), runId, nowIso));
        }
      } else if (src === "example_api") {
        collected.push(...parseGenericApiFixtures(runId, nowIso));
      }
    }

    const filtered =
      requestedPhone === "all"
        ? collected
        : collected.filter((r) => `${r.brand} ${r.model}`.trim() === requestedPhone);

    const todayUtc = nowIso.slice(0, 10);
    for (const rec of filtered) {
      const idx = state.records.findIndex(
        (existing) =>
          existing.source === rec.source &&
          existing.source_product_id === rec.source_product_id &&
          existing.condition === rec.condition &&
          (existing.storage_gb ?? -1) === (rec.storage_gb ?? -1) &&
          existing.captured_at.slice(0, 10) === todayUtc,
      );
      if (idx >= 0) {
        state.records[idx] = rec;
      } else {
        state.records.unshift(rec);
      }
    }

    const runRecord: ScrapeRun = {
      id: runId,
      source: requestedSource,
      started_at: nowIso,
      finished_at: new Date().toISOString(),
      status: "success",
      records_count: filtered.length,
      error_message: null,
    };
    state.runs.unshift(runRecord);

    res.json({ run: runRecord, collected_count: filtered.length, records: filtered });
  });

  app.get("/api/trends", (req, res) => {
    const granularity = (String(req.query.granularity ?? "daily") as ExportGranularity);
    const model = req.query.model ? String(req.query.model) : undefined;
    const source = req.query.source ? String(req.query.source) : undefined;
    const rows = computeTrends(state.records, granularity, model, source);
    res.json({ granularity, rows });
  });

  app.post("/api/export", (req, res) => {
    const granularity = (String(req.body?.granularity ?? "daily") as ExportGranularity);
    const source = String(req.body?.source ?? "all");
    const fromDate = String(req.body?.from_date ?? "2026-10-01");
    const toDate = String(req.body?.to_date ?? "2026-12-31");

    const matching = state.records.filter((r) => {
      const day = r.captured_at.slice(0, 10);
      const inRange = day >= fromDate && day <= toDate;
      const inSource = source === "all" || r.source === source;
      return inRange && inSource;
    });

    const trendsAll = computeTrends(matching, granularity, undefined, source);
    const buckets = new Map<string, { yyyy: string; yyyyMm: string; folder: string; rows: NormalizedPriceRecord[] }>();

    for (const r of matching) {
      const day = r.captured_at.slice(0, 10);
      const yyyy = day.slice(0, 4);
      const yyyyMm = day.slice(0, 7);
      const folder =
        granularity === "daily"
          ? day
          : granularity === "weekly"
            ? isoWeekToken(`${day}T00:00:00Z`)
            : yyyyMm;
      const bucketKey = `${granularity}/${yyyy}/${yyyyMm}/${folder}`;
      const existing = buckets.get(bucketKey) ?? { yyyy, yyyyMm, folder, rows: [] };
      existing.rows.push(r);
      buckets.set(bucketKey, existing);
    }

    const artifacts: Array<{
      relative_path: string;
      filename: string;
      kind: "snapshots_csv" | "trends_csv" | "manifest_json";
      row_count?: number;
      sha256?: string;
      preview?: string;
    }> = [];

    for (const [bucketRel, bucket] of buckets.entries()) {
      const bucketDir = path.join(EXPORTS_DIR, bucketRel);
      fs.mkdirSync(bucketDir, { recursive: true });
      const sourcesInBucket =
        source === "all" ? Array.from(new Set(bucket.rows.map((r) => r.source))).sort() : [source];

      for (const srcName of sourcesInBucket) {
        const srcRows = bucket.rows.filter((r) => r.source === srcName);
        if (srcRows.length === 0) continue;
        const filename = `${srcName}_${granularity}_${bucket.folder}.csv`;
        const filePath = path.join(bucketDir, filename);
        const csvContent = toCsv(
          srcRows.map((r) => ({
            run_id: r.run_id,
            side: r.side,
            source: r.source,
            source_product_id: r.source_product_id,
            brand: r.brand,
            model: r.model,
            part_category: r.part_category ?? "",
            part_name: r.part_name ?? "",
            storage_gb: r.storage_gb,
            ram_gb: r.ram_gb,
            color: r.color,
            condition: r.condition,
            price: r.price,
            currency: r.currency,
            mrp: r.mrp,
            discount_pct: r.discount_pct,
            in_stock: r.in_stock,
            source_url: r.source_url,
            captured_at: r.captured_at,
          })),
        );
        fs.writeFileSync(filePath, csvContent, "utf-8");
        const sha256 = crypto.createHash("sha256").update(csvContent).digest("hex");

        const manifestName = "manifest.json";
        const manifestObj = {
          file: filename,
          source: srcName,
          granularity,
          row_count: srcRows.length,
          sha256,
          run_ids: Array.from(new Set(srcRows.map((r) => String(r.run_id)))).sort(),
          generated_at: new Date().toISOString(),
          bucket: bucket.folder,
        };
        const manifestStr = JSON.stringify(manifestObj, null, 2);
        fs.writeFileSync(path.join(bucketDir, manifestName), manifestStr, "utf-8");

        artifacts.push({
          relative_path: `${bucketRel}/${filename}`,
          filename,
          kind: "snapshots_csv",
          row_count: srcRows.length,
          sha256,
          preview: csvContent.split("\n").slice(0, 6).join("\n"),
        });
        artifacts.push({
          relative_path: `${bucketRel}/${manifestName}`,
          filename: manifestName,
          kind: "manifest_json",
          preview: manifestStr,
        });
      }

      const bucketTrends = trendsAll.filter((t) => t.bucket_date === bucket.folder);
      const trendsFilename = `trends_${granularity}_${bucket.folder}.csv`;
      const trendsCsv = toCsv(bucketTrends as unknown as Array<Record<string, unknown>>);
      fs.writeFileSync(path.join(bucketDir, trendsFilename), trendsCsv, "utf-8");
      artifacts.push({
        relative_path: `${bucketRel}/${trendsFilename}`,
        filename: trendsFilename,
        kind: "trends_csv",
        row_count: bucketTrends.length,
        preview: trendsCsv.split("\n").slice(0, 6).join("\n"),
      });
    }

    res.json({ granularity, artifacts });
  });

  const SCHEMA_SQL_PATH = path.join(SCRAPER_DIR, "schema.sql");
  const DUMP_SQL_PATH = path.join(SCRAPER_DIR, "postgres_migration_dump.sql");

  function sqlLit(val: unknown): string {
    if (val === null || val === undefined) return "NULL";
    if (typeof val === "number") return Number.isFinite(val) ? String(val) : "NULL";
    if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
    return `'${String(val).replace(/'/g, "''")}'`;
  }

  function writePostgresMigrationDump(): { dumpPath: string; snapshotCount: number; modelCount: number } {
    const schemaDdl = fs.existsSync(SCHEMA_SQL_PATH)
      ? fs.readFileSync(SCHEMA_SQL_PATH, "utf-8")
      : "";

    const lines: string[] = [
      "-- =============================================================================",
      "-- Automated PostgreSQL 16 Migration Dump (Schema + All Normalized Records)",
      `-- Generated At: ${new Date().toISOString()}`,
      `-- Total Snapshots: ${state.records.length}`,
      "-- =============================================================================",
      "BEGIN;",
      "",
      schemaDdl.trim(),
      "",
      "-- 1. Upsert Scrape Runs",
    ];

    const runIdsSeen = new Set<number>();
    for (const r of state.runs) {
      runIdsSeen.add(r.id);
      lines.push(
        `INSERT INTO scrape_runs (id, source, started_at, finished_at, status, records_count, error_message) VALUES (${r.id}, ${sqlLit(r.source)}, ${sqlLit(r.started_at)}, ${sqlLit(r.finished_at)}, ${sqlLit(r.status)}, ${r.records_count}, ${sqlLit(r.error_message)}) ON CONFLICT (id) DO UPDATE SET records_count = EXCLUDED.records_count, finished_at = EXCLUDED.finished_at, status = EXCLUDED.status;`,
      );
    }
    for (const rec of state.records) {
      const rId = Number(rec.run_id) || 1;
      if (!runIdsSeen.has(rId)) {
        runIdsSeen.add(rId);
        lines.push(
          `INSERT INTO scrape_runs (id, source, started_at, finished_at, status, records_count, error_message) VALUES (${rId}, ${sqlLit(rec.source)}, ${sqlLit(rec.captured_at)}, ${sqlLit(rec.captured_at)}, 'success', 1, NULL) ON CONFLICT (id) DO NOTHING;`,
        );
      }
    }

    lines.push("", "-- 2. Upsert Phone Models Dimension");
    const modelMap = new Map<string, number>();
    let nextModelId = 1;
    for (const rec of state.records) {
      const key = `${rec.brand}||${rec.model}`;
      if (!modelMap.has(key)) {
        const mId = nextModelId++;
        modelMap.set(key, mId);
        lines.push(
          `INSERT INTO phone_models (id, brand, model) VALUES (${mId}, ${sqlLit(rec.brand)}, ${sqlLit(rec.model)}) ON CONFLICT (brand, model) DO NOTHING;`,
        );
      }
    }

    lines.push("", "-- 3. Upsert Normalized Price & Parts Snapshots");
    for (const rec of state.records) {
      const rId = Number(rec.run_id) || 1;
      const payloadJson = JSON.stringify(rec.raw_payload ?? {}).replace(/'/g, "''");
      lines.push(
        `INSERT INTO price_snapshots (run_id, model_id, side, source, source_product_id, brand, model, storage_gb, ram_gb, color, condition, part_category, part_name, price, currency, mrp, discount_pct, in_stock, source_url, captured_at, raw_payload) VALUES (${rId}, (SELECT id FROM phone_models WHERE brand = ${sqlLit(rec.brand)} AND model = ${sqlLit(rec.model)} LIMIT 1), ${sqlLit(rec.side)}, ${sqlLit(rec.source)}, ${sqlLit(rec.source_product_id)}, ${sqlLit(rec.brand)}, ${sqlLit(rec.model)}, ${sqlLit(rec.storage_gb)}, ${sqlLit(rec.ram_gb)}, ${sqlLit(rec.color)}, ${sqlLit(rec.condition)}, ${sqlLit(rec.part_category ?? null)}, ${sqlLit(rec.part_name ?? null)}, ${sqlLit(rec.price)}, ${sqlLit(rec.currency)}, ${sqlLit(rec.mrp)}, ${sqlLit(rec.discount_pct)}, ${sqlLit(rec.in_stock)}, ${sqlLit(rec.source_url)}, ${sqlLit(rec.captured_at)}, '${payloadJson}'::jsonb) ON CONFLICT (source, source_product_id, condition, COALESCE(storage_gb, -1), COALESCE(part_category, ''), ((captured_at AT TIME ZONE 'UTC')::date)) DO UPDATE SET price = EXCLUDED.price, mrp = EXCLUDED.mrp, discount_pct = EXCLUDED.discount_pct, in_stock = EXCLUDED.in_stock, part_name = EXCLUDED.part_name, raw_payload = EXCLUDED.raw_payload;`,
      );
    }

    lines.push(
      "",
      "SELECT setval('scrape_runs_id_seq', COALESCE((SELECT MAX(id) FROM scrape_runs), 1));",
      "SELECT setval('phone_models_id_seq', COALESCE((SELECT MAX(id) FROM phone_models), 1));",
      "SELECT setval('price_snapshots_id_seq', COALESCE((SELECT MAX(id) FROM price_snapshots), 1));",
      "COMMIT;",
      "",
    );

    fs.writeFileSync(DUMP_SQL_PATH, lines.join("\n"), "utf-8");
    return {
      dumpPath: "phone-price-scraper/postgres_migration_dump.sql",
      snapshotCount: state.records.length,
      modelCount: modelMap.size,
    };
  }

  writePostgresMigrationDump();

  app.get("/api/postgres/schema", (_req, res) => {
    const info = writePostgresMigrationDump();
    const schemaSql = fs.existsSync(SCHEMA_SQL_PATH)
      ? fs.readFileSync(SCHEMA_SQL_PATH, "utf-8")
      : "";
    res.json({
      schema_sql: schemaSql,
      dump_path: info.dumpPath,
      snapshot_count: info.snapshotCount,
      model_count: info.modelCount,
    });
  });

  app.get("/api/postgres/dump.sql", (_req, res) => {
    writePostgresMigrationDump();
    res.download(DUMP_SQL_PATH, "postgres_migration_dump.sql");
  });

  app.get("/api/export/download", (req, res) => {
    const rel = String(req.query.path ?? "");
    const resolved = path.resolve(EXPORTS_DIR, rel);
    if (!resolved.startsWith(path.resolve(EXPORTS_DIR)) || !fs.existsSync(resolved)) {
      res.status(404).json({ error: "Export file not found" });
      return;
    }
    res.download(resolved);
  });

  if (process.env.NODE_ENV === "production") {
    const distDir = path.join(ROOT_DIR, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  } else {
    app.use((req, res, next) => {
      if (req.path === "/" || req.path === "/index.html" || req.path.startsWith("/src/")) {
        delete req.headers["if-none-match"];
        delete req.headers["if-modified-since"];
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
      next();
    });
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  const PORT = Number(process.env.PORT ?? 3000);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
