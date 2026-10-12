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

const LIVE_TTL_MS = 20_000;          // one Samsara pull serves everyone for 20s
const CONFIG_TTL_MS = 10 * 60_000;   // sites/geofences/hidden list refresh every 10 min

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

async function loadConfig(): Promise<{ sites: Site[]; hidden: HiddenRule[] }> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache;

  const [siteRes, hidRes] = await Promise.all([
    sb.from("fleet_sites").select("*").eq("active", true).order("sort_order"),
    sb.from("fleet_hidden").select("*"),
  ]);
  if (siteRes.error) throw new Error("fleet_sites: " + siteRes.error.message);
  if (hidRes.error) throw new Error("fleet_hidden: " + hidRes.error.message);

  const sites: Site[] = [];
  for (const row of siteRes.data ?? []) {
    const shapes: Shape[] = [];
    for (const id of row.samsara_address_ids ?? []) {
      try {
        const body = await samsaraGet(`/addresses/${encodeURIComponent(id)}`);
        const sh = shapeFromAddress(body.data);
        if (sh) shapes.push(sh);
      } catch (e) {
        console.log(`address ${id} (${row.name}) failed: ${e}`);
      }
    }
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

  const hidden: HiddenRule[] = (hidRes.data ?? []).map((h: any) => ({
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

  const [locs, assigns, trailerStats] = await Promise.all([
    samsaraAll("/fleet/vehicles/locations"),
    samsaraAll("/fleet/driver-vehicle-assignments", {
      startTime: start.toISOString(), endTime: end.toISOString(), filterBy: "drivers",
    }).catch((e) => { console.log("assignments failed: " + e); return []; }),
    samsaraAll("/fleet/trailers/stats", { types: "gps", limit: "200" }),
  ]);

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
  if (liveCache && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache.body;
  if (!liveInflight) {
    liveInflight = buildLive()
      .then((body) => { liveCache = { at: Date.now(), body }; return body; })
      .finally(() => { liveInflight = null; });
  }
  return await liveInflight;
}

async function loadStatuses(): Promise<Record<string, any>> {
  const { data, error } = await sb.from("fleet_trailer_load").select("*");
  if (error) throw new Error("fleet_trailer_load: " + error.message);
  const out: Record<string, any> = {};
  for (const r of data ?? []) out[r.trailer_id] = { status: r.status, by: r.updated_by, at: r.updated_at };
  return out;
}

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
      const [live, loads] = await Promise.all([getLive(), loadStatuses()]);
      return json({
        ...live,
        trailers: live.trailers.map((t: any) => ({ ...t, load: loads[t.id] || null })),
      });
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

    if (action === "reloadConfig") { configCache = null; liveCache = null; return json({ ok: true }); }

    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    console.log("fleet-live error: " + e);
    return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 502);
  }
});
