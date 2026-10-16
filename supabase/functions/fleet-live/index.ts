// ============================================================
// fleet-live — Samsara proxy for LWH Fleet View
//
// The Samsara token lives ONLY here, as the SAMSARA_API_TOKEN secret.
// The PWA sends a team PIN (x-fleet-pin header); this function checks it,
// pulls trucks, drivers, trailers and geofences from Samsara, classifies
// everything against your sites, infers truck+trailer pairs, and returns
// one trimmed JSON payload.
//
// Secrets (Dashboard > Edge Functions > Secrets, or `supabase secrets set`):
//   SAMSARA_API_TOKEN   new Samsara key
//   FLEET_PIN           team PIN (use 6+ digits)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// Deploy with JWT verification OFF (the PIN is the gate):
//   supabase functions deploy fleet-live --no-verify-jwt --project-ref tjivcqxnkftujceumdtx
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SAMSARA = "https://api.samsara.com";
const TOKEN = (Deno.env.get("SAMSARA_API_TOKEN") ?? "").trim();
const PIN = (Deno.env.get("FLEET_PIN") ?? "").trim();

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fleet-pin",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Supabase spins this function down after ~15s idle, so in-memory caches
// rarely survive between refreshes. Both caches are also kept in Postgres
// (fleet_live_cache, fleet_sites.geofence_cache) so they work across instances.
const LIVE_TTL_MS = 20_000;               // one Samsara pull serves everyone for 20s
const CONFIG_TTL_MS = 10 * 60_000;        // in-memory sites/hidden list
const GEOFENCE_TTL_MS = 24 * 3600_000;    // geofence shapes re-pulled from Samsara daily

// Pairing rules (miles / mph / minutes)
const PAIR_MOVING_MPH = 5;           // both must be above this to count as "moving"
const PAIR_BASE_MI = 0.3;            // base match radius while moving
const PAIR_PARKED_MI = 0.1;          // ~175 yards when both parked off-site
const PAIR_HEADING_DEG = 60;         // headings must roughly agree while moving
const TRAILER_FRESH_MIN = 15;        // ignore trailer pings older than this for pairing

// ---------------- types ----------------
type Pt = { latitude: number; longitude: number };
type Shape =
  | { type: "polygon"; vertices: Pt[] }
  | { type: "circle"; center: Pt; radiusMeters: number };
type Site = { name: string; isHome: boolean; sort: number; shapes: Shape[]; center: Pt | null };
type HiddenRule = { assetType: string; matchType: string; value: string };

// ---------------- geometry (ported from Geometry.gs) ----------------
function pointInPolygon(lat: number, lng: number, v: Pt[]): boolean {
  if (!v || v.length < 3) return false;
  let inside = false;
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
    const xi = v[i].latitude, yi = v[i].longitude;
    const xj = v[j].latitude, yj = v[j].longitude;
    const hit = ((yi > lng) !== (yj > lng)) && (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

function meters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, r = (d: number) => d * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const miles = (a: number, b: number, c: number, d: number) => meters(a, b, c, d) / 1609.344;

function inShape(lat: number, lng: number, s: Shape): boolean {
  if (s.type === "polygon") return pointInPolygon(lat, lng, s.vertices);
  return meters(lat, lng, s.center.latitude, s.center.longitude) <= s.radiusMeters;
}

function siteFor(lat: number, lng: number, sites: Site[]): string | null {
  for (const s of sites) for (const sh of s.shapes) if (inShape(lat, lng, sh)) return s.name;
  return null;
}

function headingDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

// ---------------- Samsara ----------------
async function samsaraGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const url = SAMSARA + path + (qs ? "?" + qs : "");
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch(url, { headers: { Authorization: "Bearer " + TOKEN, Accept: "application/json" } });
    if (resp.status === 429) {
      const ra = Number(resp.headers.get("retry-after")) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(ra, 8) * 1000));
      continue;
    }
    if (!resp.ok) throw new Error(`Samsara ${path} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return await resp.json();
  }
  throw new Error(`Samsara ${path}: rate limited`);
}

async function samsaraAll(path: string, params: Record<string, string> = {}, maxPages = 20): Promise<any[]> {
  const out: any[] = [];
  let after: string | null = null;
  for (let p = 0; p < maxPages; p++) {
    const q: Record<string, string> = { ...params };
    if (after) q.after = after;
    const body = await samsaraGet(path, q);
    if (Array.isArray(body.data)) out.push(...body.data);
    const pg = body.pagination || {};
    after = pg.hasNextPage && pg.endCursor ? pg.endCursor : null;
    if (!after) break;
  }
  return out;
}

// ---------------- config (sites + hidden list), cached ----------------
let configCache: { at: number; sites: Site[]; hidden: HiddenRule[] } | null = null;

function shapeFromAddress(a: any): Shape | null {
  const g = a?.geofence || {};
  if (g.polygon && Array.isArray(g.polygon.vertices) && g.polygon.vertices.length >= 3) {
    return { type: "polygon", vertices: g.polygon.vertices };
  }
  if (g.circle) {
    const lat = typeof g.circle.latitude === "number" ? g.circle.latitude : a.latitude;
    const lng = typeof g.circle.longitude === "number" ? g.circle.longitude : a.longitude;
    if (typeof lat === "number" && typeof lng === "number") {
      return { type: "circle", center: { latitude: lat, longitude: lng }, radiusMeters: g.circle.radiusMeters || 150 };
    }
  }
  return null;
}

function shapeCenter(s: Shape): Pt {
  if (s.type === "circle") return s.center;
  const n = s.vertices.length;
  return {
    latitude: s.vertices.reduce((t, v) => t + v.latitude, 0) / n,
    longitude: s.vertices.reduce((t, v) => t + v.longitude, 0) / n,
  };
}

// Supabase queries occasionally fail on a cold start ("JWT issued at future"
// clock skew). One quiet retry covers it.
async function db<T>(label: string, run: () => PromiseLike<{ data: T | null; error: any }>): Promise<T | null> {
  let res = await run();
  if (res.error) {
    await new Promise((r) => setTimeout(r, 600));
    res = await run();
  }
  if (res.error) throw new Error(label + ": " + res.error.message);
  return res.data;
}

// A site can also be a plain circle drawn by us (center_lat/center_lng/radius_m),
// for places that aren't a Samsara address, like the truck lot.
async function shapesForSite(row: any): Promise<Shape[]> {
  const manual: Shape[] = [];
  if (typeof row.center_lat === "number" && typeof row.center_lng === "number" && Number(row.radius_m) > 0) {
    manual.push({ type: "circle", center: { latitude: row.center_lat, longitude: row.center_lng }, radiusMeters: Number(row.radius_m) });
  }
  const fromSamsara = (row.samsara_address_ids ?? []).length ? await samsaraShapesForSite(row) : [];
  return [...fromSamsara, ...manual];
}

async function samsaraShapesForSite(row: any): Promise<Shape[]> {
  const ids: string[] = (row.samsara_address_ids ?? []).map(String);
  const cache = row.geofence_cache;
  const fresh = row.geofence_cached_at && Date.now() - Date.parse(row.geofence_cached_at) < GEOFENCE_TTL_MS;
  if (fresh && cache && Array.isArray(cache.shapes) && JSON.stringify(cache.ids) === JSON.stringify(ids)) {
    return cache.shapes as Shape[];
  }

  const shapes: Shape[] = [];
  let failed = false;
  for (const id of ids) {
    try {
      const body = await samsaraGet(`/addresses/${encodeURIComponent(id)}`);
      const sh = shapeFromAddress(body.data);
      if (sh) shapes.push(sh);
    } catch (e) {
      failed = true;
      console.log(`address ${id} (${row.name}) failed: ${e}`);
    }
  }
  if (failed && cache && Array.isArray(cache.shapes) && cache.shapes.length) {
    return cache.shapes as Shape[];  // keep the old shapes rather than lose the site
  }
  if (!failed) {
    const { error } = await sb.from("fleet_sites")
      .update({ geofence_cache: { ids, shapes }, geofence_cached_at: new Date().toISOString() })
      .eq("id", row.id);
    if (error) console.log(`geofence cache save failed (${row.name}): ${error.message}`);
  }
  return shapes;
}

async function loadConfig(): Promise<{ sites: Site[]; hidden: HiddenRule[] }> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache;

  const [siteRows, hidRows] = await Promise.all([
    db<any[]>("fleet_sites", () => sb.from("fleet_sites").select("*").eq("active", true).order("sort_order")),
    db<any[]>("fleet_hidden", () => sb.from("fleet_hidden").select("*")),
  ]);

  const sites: Site[] = [];
  for (const row of siteRows ?? []) {
    const shapes = await shapesForSite(row);
    let center: Pt | null = null;
    if (shapes.length) {
      const cs = shapes.map(shapeCenter);
      center = {
        latitude: cs.reduce((t, c) => t + c.latitude, 0) / cs.length,
        longitude: cs.reduce((t, c) => t + c.longitude, 0) / cs.length,
      };
    }
    sites.push({ name: row.name, isHome: row.is_home, sort: row.sort_order, shapes, center });
  }

  const hidden: HiddenRule[] = (hidRows ?? []).map((h: any) => ({
    assetType: h.asset_type, matchType: h.match_type, value: String(h.value).toLowerCase(),
  }));

  configCache = { at: Date.now(), sites, hidden };
  return configCache;
}

function isHidden(kind: "vehicle" | "trailer", id: string, name: string, rules: HiddenRule[]): boolean {
  const lid = String(id).toLowerCase(), lname = String(name || "").toLowerCase();
  return rules.some((r) => {
    if (r.assetType !== "any" && r.assetType !== kind) return false;
    return r.matchType === "id" ? r.value === lid : lname.includes(r.value);
  });
}

// ---------------- live snapshot, cached + de-duplicated ----------------
let liveCache: { at: number; body: any } | null = null;
let liveInflight: Promise<any> | null = null;

function pickAssignments(rows: any[]): Record<string, { id: string; name: string }> {
  // One driver per vehicle: prefer open assignments, then the latest start.
  const now = Date.now();
  const best: Record<string, { open: boolean; start: number; driver: any }> = {};
  for (const a of rows) {
    const vid = a?.vehicle?.id, d = a?.driver;
    if (!vid || !d?.id || a.isPassenger) continue;
    const end = a.endTime ? Date.parse(a.endTime) : NaN;
    const open = !a.endTime || end > now;
    const start = Date.parse(a.startTime) || 0;
    const cur = best[vid];
    if (!cur || (open && !cur.open) || (open === cur.open && start > cur.start)) {
      best[vid] = { open, start, driver: d };
    }
  }
  const out: Record<string, { id: string; name: string }> = {};
  for (const [vid, b] of Object.entries(best)) out[vid] = { id: String(b.driver.id), name: b.driver.name || "" };
  return out;
}

async function buildLive(): Promise<any> {
  const { sites, hidden } = await loadConfig();
  const end = new Date(), start = new Date(end.getTime() - 24 * 3600_000);

  const [locs, assigns, trailerStats, engineRows] = await Promise.all([
    samsaraAll("/fleet/vehicles/locations"),
    samsaraAll("/fleet/driver-vehicle-assignments", {
      startTime: start.toISOString(), endTime: end.toISOString(), filterBy: "drivers",
    }).catch((e) => { console.log("assignments failed: " + e); return []; }),
    samsaraAll("/fleet/trailers/stats", { types: "gps", limit: "200" }),
    // engine on/off (and when it last changed) + fuel level, in one call
    samsaraAll("/fleet/vehicles/stats", { types: "engineStates,fuelPercents" })
      .catch((e) => { console.log("engine/fuel stats failed: " + e); return []; }),
  ]);
  const mpgBy = await getMpg().catch((e) => { console.log("mpg failed: " + e); return {} as Record<string, any>; });

  const latestOf = (x: any) => Array.isArray(x) ? x[x.length - 1] : x;
  const engineBy: Record<string, { value: string; since: string | null }> = {};
  const fuelBy: Record<string, { pct: number; time: string | null }> = {};
  for (const v of engineRows) {
    if (!v?.id) continue;
    const e = latestOf(v.engineState ?? v.engineStates);
    if (e?.value) engineBy[String(v.id)] = { value: String(e.value), since: e.time || null };
    const f = latestOf(v.fuelPercent ?? v.fuelPercents);
    if (f && typeof f.value === "number") fuelBy[String(v.id)] = { pct: Math.round(f.value), time: f.time || null };
  }

  const driverBy = pickAssignments(assigns);

  const trucks = locs
    .filter((v: any) => v?.location && typeof v.location.latitude === "number")
    .filter((v: any) => !isHidden("vehicle", v.id, v.name, hidden))
    .map((v: any) => {
      const L = v.location;
      const lat = L.latitude, lng = L.longitude;
      const speed = Number(L.speedMilesPerHour ?? L.speed ?? 0) || 0;
      const d = driverBy[v.id];
      return {
        id: String(v.id),
        name: v.name || String(v.id),
        driver: d ? d.name : null,
        lat, lng, speed,
        heading: Number(L.heading ?? L.headingDegrees ?? 0) || 0,
        time: L.time || null,
        address: L.reverseGeo?.formattedLocation || "",
        site: siteFor(lat, lng, sites),
        engine: engineBy[String(v.id)]?.value ?? null,
        engineSince: engineBy[String(v.id)]?.since ?? null,
        fuel: fuelBy[String(v.id)]?.pct ?? null,
        fuelTime: fuelBy[String(v.id)]?.time ?? null,
        mpg7: mpgBy[String(v.id)]?.mpg ?? null,
        miles7: mpgBy[String(v.id)]?.miles ?? null,
      };
    });

  const trailers = trailerStats
    .filter((t: any) => t?.gps && typeof t.gps.latitude === "number")
    .map((t: any) => ({ ...t, _name: t.name || t.externalIds?.trailerNumber || String(t.id) }))
    .filter((t: any) => !isHidden("trailer", t.id, t._name, hidden))
    .map((t: any) => {
      const g = t.gps;
      const lat = g.latitude, lng = g.longitude;
      const ageMin = g.time ? Math.round((Date.now() - Date.parse(g.time)) / 60000) : null;
      return {
        id: String(t.id),
        name: t._name,
        lat, lng,
        speed: Number(g.speedMilesPerHour ?? 0) || 0,
        heading: Number(g.headingDegrees ?? 0) || 0,
        time: g.time || null,
        ageMin,
        address: g.reverseGeo?.formattedLocation || "",
        site: siteFor(lat, lng, sites),
        pairedTruckId: null as string | null,
        pairBasis: null as string | null,
      };
    });

  // ---- infer which truck is pulling which trailer ----
  for (const tr of trailers) {
    if (tr.site) continue;                                   // yards are too crowded to guess
    if (tr.ageMin === null || tr.ageMin > TRAILER_FRESH_MIN) continue;
    const trMoving = tr.speed > PAIR_MOVING_MPH;
    let best: { id: string; d: number } | null = null;
    for (const tk of trucks) {
      if (tk.site) continue;
      const tkMoving = tk.speed > PAIR_MOVING_MPH;
      const d = miles(tr.lat, tr.lng, tk.lat, tk.lng);
      let ok = false;
      if (trMoving && tkMoving) {
        // allow for the trailer's ping being a few minutes older than the truck's
        const slack = tk.speed * ((tr.ageMin ?? 0) / 60);
        ok = d <= PAIR_BASE_MI + slack && headingDiff(tr.heading, tk.heading) <= PAIR_HEADING_DEG;
      } else if (!trMoving && !tkMoving) {
        ok = d <= PAIR_PARKED_MI;
      }
      if (ok && (!best || d < best.d)) best = { id: tk.id, d };
    }
    if (best) {
      tr.pairedTruckId = best.id;
      tr.pairBasis = trMoving ? "moving" : "parked";
    }
  }

  return {
    ok: true,
    asOf: new Date().toISOString(),
    sites: sites.map((s) => ({ name: s.name, isHome: s.isHome, center: s.center, shapes: s.shapes })),
    trucks,
    trailers,
  };
}

async function getLive(): Promise<any> {
  // 1) this instance's memory
  if (liveCache && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache.body;

  // 2) the shared snapshot another instance just built
  try {
    const { data } = await sb.from("fleet_live_cache").select("body, built_at").eq("id", 1).maybeSingle();
    if (data && Date.now() - Date.parse(data.built_at) < LIVE_TTL_MS) {
      liveCache = { at: Date.parse(data.built_at), body: data.body };
      return data.body;
    }
  } catch (e) {
    console.log("live cache read failed: " + e);
  }

  // 3) pull fresh from Samsara and share it
  if (!liveInflight) {
    liveInflight = buildLive()
      .then(async (body) => {
        liveCache = { at: Date.now(), body };
        const { error } = await sb.from("fleet_live_cache")
          .upsert({ id: 1, body, built_at: new Date().toISOString() });
        if (error) console.log("live cache save failed: " + error.message);
        return body;
      })
      .finally(() => { liveInflight = null; });
  }
  return await liveInflight;
}

// ---------------- 7-day MPG (Samsara fuel & energy report) ----------------
// Built from the engine computer's fuel-burned figure, so no fuel card data is
// needed. Pulled at most every 6 hours and shared through Postgres.
const MPG_TTL_MS = 6 * 3600_000;
const MPG_DAYS = 7;
const MPG_MIN_MILES = 25;            // too few miles makes MPG meaningless
let mpgMem: { at: number; body: Record<string, any> } | null = null;

async function getMpg(): Promise<Record<string, any>> {
  if (mpgMem && Date.now() - mpgMem.at < MPG_TTL_MS) return mpgMem.body;
  const { data } = await sb.from("fleet_mpg_cache").select("body, built_at").eq("id", 1).maybeSingle();
  if (data && Date.now() - Date.parse(data.built_at) < MPG_TTL_MS) {
    mpgMem = { at: Date.parse(data.built_at), body: data.body };
    return data.body;
  }
  // Out of date: hand back the old numbers now and refresh in the background,
  // so a slow report never delays the live map.
  const stale = data?.body ?? {};
  const job = refreshMpg().catch((e) => console.log("mpg refresh failed: " + e));
  // keep this instance alive until the report finishes, even after the reply is sent
  (globalThis as any).EdgeRuntime?.waitUntil?.(job);
  mpgMem = { at: Date.now() - MPG_TTL_MS + 5 * 60_000, body: stale };   // retry in ~5 min if this fails
  return stale;
}

async function refreshMpg(): Promise<void> {
  const end = new Date(), start = new Date(end.getTime() - MPG_DAYS * 86400_000);
  const out: Record<string, any> = {};
  let after: string | null = null;
  for (let p = 0; p < 10; p++) {
    const q: Record<string, string> = { startDate: start.toISOString(), endDate: end.toISOString() };
    if (after) q.after = after;
    const body = await samsaraGet("/fleet/reports/vehicles/fuel-energy", q);
    const rows = body?.data?.vehicleReports ?? body?.vehicleReports ?? [];
    for (const r of rows) {
      const id = r?.vehicle?.id;
      if (!id) continue;
      const miles = (Number(r.distanceTraveledMeters) || 0) / 1609.344;
      const gal = (Number(r.fuelConsumedMl) || 0) / 3785.41;
      let mpg = miles >= MPG_MIN_MILES && gal > 0 ? miles / gal : null;
      if (mpg == null && typeof r.efficiencyMpge === "number" && miles >= MPG_MIN_MILES) mpg = r.efficiencyMpge;
      if (mpg != null && (mpg < 1 || mpg > 30)) mpg = null;    // sensor nonsense
      out[String(id)] = { mpg: mpg == null ? null : Math.round(mpg * 10) / 10, miles: Math.round(miles) };
    }
    const pg = body?.pagination || {};
    after = pg.hasNextPage && pg.endCursor ? pg.endCursor : null;
    if (!after) break;
  }
  await sb.from("fleet_mpg_cache").upsert({ id: 1, body: out, built_at: new Date().toISOString() });
  mpgMem = { at: Date.now(), body: out };
}

// ---------------- Samsara address book copy (daily) ----------------
// Lets new warehouses be matched to their real Samsara outlines by address.
const BOOK_TTL_MS = 24 * 3600_000;
let bookCheckedAt = 0;

function syncAddressBookIfDue(): void {
  if (Date.now() - bookCheckedAt < 10 * 60_000) return;     // check at most every 10 min
  bookCheckedAt = Date.now();
  const job = (async () => {
    const { data } = await sb.from("fleet_address_book").select("synced_at").order("synced_at", { ascending: false }).limit(1);
    if (data && data.length && Date.now() - Date.parse(data[0].synced_at) < BOOK_TTL_MS) return;
    const rows = await samsaraAll("/addresses", { limit: "512" });
    const now = new Date().toISOString();
    const recs = rows.filter((a: any) => a?.id).map((a: any) => ({
      id: String(a.id), name: a.name ?? null, formatted_address: a.formattedAddress ?? null,
      latitude: typeof a.latitude === "number" ? a.latitude : null,
      longitude: typeof a.longitude === "number" ? a.longitude : null,
      geofence: a.geofence ?? null, synced_at: now,
    }));
    for (let i = 0; i < recs.length; i += 200) {
      const { error } = await sb.from("fleet_address_book").upsert(recs.slice(i, i + 200));
      if (error) throw new Error(error.message);
    }
    console.log("address book synced: " + recs.length);
  })().catch((e) => console.log("address book sync failed: " + e));
  (globalThis as any).EdgeRuntime?.waitUntil?.(job);
}

// ---------------- route trail for one truck (on tap) ----------------
// Ported from detectStops() in the Fleet Command GAS project.
const STOP_MPH = 2;                  // slower than this counts as stopped
const STOP_MIN_MS = 5 * 60_000;      // stops shorter than 5 min are ignored
const STOP_DRIFT_MI = 0.05;          // GPS wobble allowed while parked
const TRAIL_MAX_POINTS = 600;        // keep the payload small for phones
const trailCache: Record<string, { at: number; body: any }> = {};

async function buildTrail(vehicleId: string, hours: number): Promise<any> {
  const key = vehicleId + ":" + hours;
  const hit = trailCache[key];
  if (hit && Date.now() - hit.at < 60_000) return hit.body;

  const end = new Date(), start = new Date(end.getTime() - hours * 3600_000);
  const rows = await samsaraAll("/fleet/vehicles/stats/history", {
    startTime: start.toISOString(), endTime: end.toISOString(), types: "gps", vehicleIds: vehicleId,
  });
  // A long history comes back across several pages, with the same truck
  // repeated on each page — merge them all.
  const raw: any[] = [];
  for (const r of rows) if (String(r.id) === vehicleId && Array.isArray(r.gps)) raw.push(...r.gps);

  const pts = raw
    .filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number" && p.time)
    .map((p) => ({ lat: p.latitude, lng: p.longitude, t: Date.parse(p.time), mph: Number(p.speedMilesPerHour ?? 0) || 0,
                   addr: p.reverseGeo?.formattedLocation || "" }))
    .sort((a, b) => a.t - b.t);

  // stops
  const stops: any[] = [];
  let cur: any = null;
  const closeStop = () => {
    if (cur && cur.end - cur.start >= STOP_MIN_MS) {
      stops.push({ lat: cur.lat, lng: cur.lng, start: new Date(cur.start).toISOString(),
                   end: new Date(cur.end).toISOString(), minutes: Math.round((cur.end - cur.start) / 60000), address: cur.addr });
    }
    cur = null;
  };
  for (const p of pts) {
    if (p.mph < STOP_MPH) {
      if (cur && miles(cur.lat, cur.lng, p.lat, p.lng) < STOP_DRIFT_MI) {
        cur.end = p.t; cur.n++;
        cur.lat += (p.lat - cur.lat) / cur.n; cur.lng += (p.lng - cur.lng) / cur.n;
        if (!cur.addr && p.addr) cur.addr = p.addr;
      } else {
        closeStop();
        cur = { lat: p.lat, lng: p.lng, start: p.t, end: p.t, n: 1, addr: p.addr };
      }
    } else {
      closeStop();
    }
  }
  closeStop();

  let total = 0;
  for (let i = 1; i < pts.length; i++) total += miles(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);

  // thin the line for the phone, always keeping first and last point
  let line = pts;
  if (pts.length > TRAIL_MAX_POINTS) {
    const step = Math.ceil(pts.length / TRAIL_MAX_POINTS);
    line = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  }

  const body = {
    ok: true, vehicleId, hours,
    points: line.map((p) => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lng * 1e6) / 1e6]),
    stops,
    miles: Math.round(total * 10) / 10,
    from: pts.length ? new Date(pts[0].t).toISOString() : null,
  };
  trailCache[key] = { at: Date.now(), body };
  return body;
}

async function loadStatuses(): Promise<Record<string, any>> {
  const rows = await db<any[]>("fleet_trailer_load", () => sb.from("fleet_trailer_load").select("*"));
  const out: Record<string, any> = {};
  for (const r of rows ?? []) out[r.trailer_id] = { status: r.status, by: r.updated_by, at: r.updated_at };
  return out;
}

// ---------------- background jobs shared through fleet_job_cache ----------------
// Same idea as the MPG cache: hand back the last result right away and refresh
// in the background, so Samsara reports never slow down the live map.
type Job = { key: string; ttl: number; mem: { at: number; body: any } | null; running: boolean; run: (prev: any) => Promise<any> };

async function getJob(job: Job): Promise<any> {
  if (job.mem && Date.now() - job.mem.at < job.ttl) return job.mem.body;
  const { data } = await sb.from("fleet_job_cache").select("body, built_at").eq("key", job.key).maybeSingle();
  const prev = data?.body ?? null;
  // a job that still has work queued (dwell first pass) asks to run again soon
  const ttl = prev?.pending ? 60_000 : job.ttl;
  if (data && Date.now() - Date.parse(data.built_at) < ttl) {
    job.mem = { at: Date.parse(data.built_at) - (job.ttl - ttl), body: prev };
    return prev;
  }
  if (!job.running) {
    job.running = true;
    const p = job.run(prev)
      .then(async (body) => {
        const { error } = await sb.from("fleet_job_cache").upsert({ key: job.key, body, built_at: new Date().toISOString() });
        if (error) console.log(job.key + " save failed: " + error.message);
        job.mem = { at: Date.now() - (body?.pending ? job.ttl - 60_000 : 0), body };
      })
      .catch((e) => console.log(job.key + " job failed: " + e))
      .finally(() => { job.running = false; });
    (globalThis as any).EdgeRuntime?.waitUntil?.(p);
  }
  job.mem = { at: Date.now() - job.ttl + 2 * 60_000, body: prev };   // this instance waits 2 min before trying again
  return prev;
}

// ---------------- trailer sitting time ("at Pernod since Tue") ----------------
// Follows every trailer's GPS history. First pass looks back 7 days (in batches,
// so it never runs too long); after that each run only reads what's new.
const DWELL_DAYS = 7;
const DWELL_SAME_MI = 0.25;          // off-site: still the same spot within a quarter mile
const DWELL_MOVING_MPH = 5;
const DWELL_BATCH = 25;              // trailers per first-pass history call
const DWELL_FIRST_PASS_PER_RUN = 4;  // batches per run (keeps each run well under the time limit)

type DwellState = { kind: "site" | "off" | "moving"; site: string | null; lat: number; lng: number;
  since: number; lastT: number; floor: boolean; addr: string };
type GpsPt = { lat: number; lng: number; t: number; mph: number; addr: string };

function gpsPoints(raw: any[]): GpsPt[] {
  return raw
    .filter((p) => typeof p?.latitude === "number" && typeof p?.longitude === "number" && p.time)
    .map((p) => ({ lat: p.latitude, lng: p.longitude, t: Date.parse(p.time), mph: Number(p.speedMilesPerHour ?? 0) || 0,
                   addr: p.reverseGeo?.formattedLocation || "" }))
    .filter((p) => !isNaN(p.t))
    .sort((a, b) => a.t - b.t);
}

// One GPS point moves the state machine on. Returns true when the trailer changed place.
function dwellStep(st: DwellState | null, p: GpsPt, sites: Site[], first: boolean): { st: DwellState; changed: boolean } {
  const site = siteFor(p.lat, p.lng, sites);
  let same = false;
  if (st) {
    if (site) same = st.kind === "site" && st.site === site;
    else if (st.kind === "off") same = miles(st.lat, st.lng, p.lat, p.lng) <= DWELL_SAME_MI;
    else if (st.kind === "moving") same = p.mph > DWELL_MOVING_MPH;
  }
  if (st && same) {
    st.lastT = p.t;
    if (!st.addr && p.addr) st.addr = p.addr;
    return { st, changed: false };
  }
  const kind: DwellState["kind"] = site ? "site" : p.mph > DWELL_MOVING_MPH ? "moving" : "off";
  return { st: { kind, site, lat: p.lat, lng: p.lng, since: p.t, lastT: p.t, floor: first && !st, addr: p.addr }, changed: true };
}

async function trailerHistory(params: Record<string, string>, maxPages = 60): Promise<Record<string, GpsPt[]>> {
  const rows = await samsaraAll("/fleet/trailers/stats/history", { types: "gps", ...params }, maxPages);
  const by: Record<string, any[]> = {};
  for (const r of rows) if (r?.id && Array.isArray(r.gps)) (by[String(r.id)] = by[String(r.id)] || []).push(...r.gps);
  const out: Record<string, GpsPt[]> = {};
  for (const id of Object.keys(by)) out[id] = gpsPoints(by[id]);
  return out;
}

const dwellJob: Job = {
  key: "dwell", ttl: 10 * 60_000, mem: null, running: false,
  run: async (prev: any) => {
    const { sites } = await loadConfig();
    const live = liveCache?.body ?? (await getLive());
    const ids: string[] = (live?.trailers ?? []).map((t: any) => String(t.id));
    const now = Date.now();
    const lastRun = Number(prev?.lastRun) || 0;
    const fresh = lastRun && now - lastRun < DWELL_DAYS * 86400_000;
    const state: Record<string, DwellState> = fresh ? (prev.state || {}) : {};

    // 1) catch up the trailers we already follow (one call covers all of them)
    if (fresh) {
      const pts = await trailerHistory({ startTime: new Date(lastRun - 15 * 60_000).toISOString(), endTime: new Date(now).toISOString() });
      for (const id of Object.keys(pts)) {
        let st = state[id];
        if (!st) continue;                     // new trailers wait for their first pass
        for (const p of pts[id]) if (p.t > st.lastT) st = dwellStep(st, p, sites, false).st;
        state[id] = st;
      }
    }

    // 2) first pass (7 days back) for trailers we don't follow yet, a few batches per run
    const todo = ids.filter((id) => !state[id]);
    const windowStart = new Date(now - DWELL_DAYS * 86400_000).toISOString();
    for (let b = 0; b < DWELL_FIRST_PASS_PER_RUN && todo.length; b++) {
      const batch = todo.splice(0, DWELL_BATCH);
      const pts = await trailerHistory({ startTime: windowStart, endTime: new Date(now).toISOString(), trailerIds: batch.join(",") });
      for (const id of batch) {
        let st: DwellState | null = null;
        for (const p of pts[id] || []) st = dwellStep(st, p, sites, true).st;
        // no ping in 7 days: nothing to say, but don't ask again until next week
        state[id] = st ?? { kind: "off", site: null, lat: 0, lng: 0, since: 0, lastT: now, floor: true, addr: "" };
      }
    }
    return { lastRun: now, pending: todo.length > 0, state };
  },
};

function dwellFor(t: any, dw: any): any {
  const st: DwellState | undefined = dw?.state?.[t.id];
  if (!st || !st.since || st.kind === "moving" || t.speed > DWELL_MOVING_MPH) return null;
  const match = st.kind === "site" ? st.site === t.site : (!t.site && miles(st.lat, st.lng, t.lat, t.lng) <= DWELL_SAME_MI + 0.05);
  if (!match) return null;   // the job hasn't caught up with a move yet
  return { since: new Date(st.since).toISOString(), floor: st.floor, site: st.site };
}

// ---------------- one trailer's last 7 days (on tap) ----------------
const STAY_MIN_MS = 20 * 60_000;
const trailerTrailCache: Record<string, { at: number; body: any }> = {};

async function buildTrailerTrail(trailerId: string, days: number): Promise<any> {
  const key = trailerId + ":" + days;
  const hit = trailerTrailCache[key];
  if (hit && Date.now() - hit.at < 120_000) return hit.body;
  const { sites } = await loadConfig();
  const end = new Date(), start = new Date(end.getTime() - days * 86400_000);
  const pts = (await trailerHistory({ startTime: start.toISOString(), endTime: end.toISOString(), trailerIds: trailerId }))[trailerId] || [];

  // group points into stays (same site, or same spot off-site) and drives
  const stays: any[] = [];
  let st: DwellState | null = null, n = 0, sumLat = 0, sumLng = 0;
  const close = () => {
    if (st && st.kind !== "moving" && (st.lastT - st.since >= STAY_MIN_MS || st.site)) {
      stays.push({ site: st.site, address: st.addr, lat: n ? sumLat / n : st.lat, lng: n ? sumLng / n : st.lng,
                   from: new Date(st.since).toISOString(), to: new Date(st.lastT).toISOString(), floor: st.floor });
    }
  };
  for (let i = 0; i < pts.length; i++) {
    const r = dwellStep(st, pts[i], sites, true);
    if (r.changed) { close(); n = 0; sumLat = 0; sumLng = 0; }
    st = r.st; n++; sumLat += pts[i].lat; sumLng += pts[i].lng;
  }
  close();
  // merge back-to-back stays at the same site (a gap in pings can split one)
  const merged: any[] = [];
  for (const s of stays) {
    const last = merged[merged.length - 1];
    if (last && s.site && last.site === s.site) last.to = s.to; else merged.push(s);
  }
  let line = pts;
  if (pts.length > TRAIL_MAX_POINTS) {
    const step = Math.ceil(pts.length / TRAIL_MAX_POINTS);
    line = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  }
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += miles(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
  const body = {
    ok: true, trailerId, days,
    points: line.map((p) => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lng * 1e6) / 1e6]),
    stays: merged,
    miles: Math.round(total),
    pings: pts.length,
    first: pts.length ? new Date(pts[0].t).toISOString() : null,
  };
  trailerTrailCache[key] = { at: Date.now(), body };
  return body;
}

// ---------------- truck DVIRs + open defects (Samsara E-Log) ----------------
const DVIR_DAYS = 7;
const DEFECT_DAYS = 180;             // open defects reported (or touched) in the last 6 months
const dvirJob: Job = {
  key: "dvir", ttl: 15 * 60_000, mem: null, running: false,
  run: async () => {
    const end = new Date();
    const out: any = { byVehicle: {}, err: null, defectErr: null };
    const friendly = (e: unknown, what: string) => {
      const m = String(e instanceof Error ? e.message : e);
      return / 40[13]/.test(m) ? `The Samsara API key can't read ${what}. Add the "Read DVIRs" and "Read Defects" permissions (Maintenance) to the key.` : m.slice(0, 200);
    };
    let dvirs: any[] = [];
    try {
      dvirs = await samsaraAll("/dvirs/stream", { startTime: new Date(end.getTime() - DVIR_DAYS * 86400_000).toISOString(), endTime: end.toISOString() }, 50);
    } catch (e) { out.err = friendly(e, "DVIRs"); return out; }
    let defects: any[] = [];
    try {
      defects = await samsaraAll("/defects/stream", { startTime: new Date(end.getTime() - DEFECT_DAYS * 86400_000).toISOString(), endTime: end.toISOString(), isResolved: "false" }, 50);
    } catch (e) { out.defectErr = friendly(e, "defects"); }
    const types: Record<string, string> = {};
    try {
      const all = await samsaraAll("/defect-types", {}, 10);
      for (const d of all) if (d?.id) types[String(d.id)] = d.label || d.name || d.defectType || "";
    } catch (e) { console.log("defect types failed: " + e); }
    const drivers: Record<string, string> = {};
    try {
      for (const status of ["active", "deactivated"]) {
        const ds = await samsaraAll("/fleet/drivers", { driverActivationStatus: status, limit: "512" }, 10);
        for (const d of ds) if (d?.id) drivers[String(d.id)] = d.name || "";
      }
    } catch (e) { console.log("drivers failed: " + e); }

    const tOf = (d: any) => Date.parse(d.dvirSubmissionTime || d.updatedAtTime || "") || 0;
    for (const d of dvirs) {
      const vid = d?.vehicle?.id;
      if (!vid || d.type === "mechanic") continue;
      const t = tOf(d);
      const cur = out.byVehicle[vid]?.last;
      if (cur && Date.parse(cur.time) >= t) continue;
      const sig = d.authorSignature?.signatoryUser?.id;
      out.byVehicle[vid] = out.byVehicle[vid] || { last: null, open: [] };
      out.byVehicle[vid].last = {
        type: d.type || "", safety: d.safetyStatus || "", time: new Date(t).toISOString(),
        by: sig ? (drivers[String(sig)] || "") : "", address: d.formattedAddress || "",
      };
    }
    for (const f of defects) {
      const vid = f?.vehicle?.id;
      if (!vid || f.isResolved) continue;
      out.byVehicle[vid] = out.byVehicle[vid] || { last: null, open: [] };
      out.byVehicle[vid].open.push({
        label: types[String(f.defectTypeId)] || "Defect", comment: String(f.comment || "").slice(0, 200),
        unsafe: f.defectSafetyStatus === "unsafe", created: f.createdAtTime || null,
      });
    }
    for (const v of Object.values(out.byVehicle) as any[]) {
      v.open.sort((a: any, b: any) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0));
      v.open = v.open.slice(0, 10);
    }
    return out;
  },
};

// ---------------- handler ----------------
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  if (!PIN || !TOKEN) return json({ ok: false, error: "Server not configured (missing secrets)." }, 500);
  if ((req.headers.get("x-fleet-pin") ?? "").trim() !== PIN) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return json({ ok: false, error: "Wrong PIN" }, 401);
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  const action = body.action || "live";

  try {
    if (action === "ping") return json({ ok: true });

    if (action === "live") {
      syncAddressBookIfDue();
      const [live, loads] = await Promise.all([getLive(), loadStatuses()]);
      // background jobs: never let them break or slow the live map
      const [dw, dv] = await Promise.all([
        getJob(dwellJob).catch((e) => { console.log("dwell: " + e); return null; }),
        getJob(dvirJob).catch((e) => { console.log("dvir: " + e); return null; }),
      ]);
      return json({
        ...live,
        trucks: live.trucks.map((t: any) => ({ ...t, dvir: dv?.byVehicle?.[t.id] || null })),
        trailers: live.trailers.map((t: any) => ({ ...t, load: loads[t.id] || null, dwell: dwellFor(t, dw) })),
        dvirStatus: dv ? (dv.err || dv.defectErr || "ok") : "loading",
        dwellStatus: dw ? (dw.pending ? "building" : "ok") : "loading",
      });
    }

    if (action === "trail") {
      const id = String(body.vehicleId || "").trim();
      if (!/^\d{1,20}$/.test(id)) return json({ ok: false, error: "vehicleId required" }, 400);
      const hours = Math.min(Math.max(Number(body.hours) || 8, 1), 12);
      return json(await buildTrail(id, hours));
    }

    if (action === "trailerTrail") {
      const id = String(body.trailerId || "").trim();
      if (!/^\d{1,20}$/.test(id)) return json({ ok: false, error: "trailerId required" }, 400);
      const days = Math.min(Math.max(Number(body.days) || 7, 1), 7);
      return json(await buildTrailerTrail(id, days));
    }

    if (action === "setLoad") {
      const id = String(body.trailerId || "").trim();
      const status = String(body.status || "");
      const by = String(body.by || "").slice(0, 60) || null;
      const name = String(body.trailerName || "").slice(0, 80) || null;
      if (!id) return json({ ok: false, error: "trailerId required" }, 400);

      if (status === "clear") {
        const { error } = await sb.from("fleet_trailer_load").delete().eq("trailer_id", id);
        if (error) throw new Error(error.message);
      } else if (status === "empty" || status === "loaded") {
        const { error } = await sb.from("fleet_trailer_load").upsert({
          trailer_id: id, trailer_name: name, status, updated_by: by, updated_at: new Date().toISOString(),
        });
        if (error) throw new Error(error.message);
      } else {
        return json({ ok: false, error: "status must be empty, loaded or clear" }, 400);
      }
      await sb.from("fleet_trailer_load_log").insert({
        trailer_id: id, trailer_name: name, status: status === "clear" ? "cleared" : status, updated_by: by,
      });
      return json({ ok: true });
    }

    if (action === "reloadConfig") {
      configCache = null; liveCache = null;
      await sb.from("fleet_sites").update({ geofence_cached_at: null }).neq("id", 0);
      await sb.from("fleet_live_cache").delete().eq("id", 1);
      return json({ ok: true });
    }

    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    console.log("fleet-live error: " + e);
    return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 502);
  }
});
