import { query, tryQuery, isDbConfigured } from './db';
import { listApps } from './cloudways';

// Shared registry of sites this portal has created.
//
// Replaces the per-browser localStorage history: the record lives server-side
// so the whole team sees the same list from any machine.
//
// The Cloudways API remains the source of truth for whether a site still
// exists — the registry only adds the metadata Cloudways does not track
// (which template was used, the brand colour, when we created it). Listing
// reconciles the two, so a site deleted directly in Cloudways stops appearing
// here without anyone having to tidy up the registry by hand.

export interface SiteRecord {
  appId: string;
  siteName: string;
  siteUrl: string;
  adminUrl: string;
  templateId: string | null;
  templateName: string | null;
  primaryColor: string | null;
  /** Whether search engine indexing has been turned back on. */
  indexing: boolean;
  createdAt: string;
  /** False when the app is in the registry but no longer exists in Cloudways. */
  liveOnCloudways: boolean;
}

interface SiteRow extends Record<string, unknown> {
  app_id: string;
  site_name: string;
  site_url: string;
  admin_url: string;
  template_id: string | null;
  template_name: string | null;
  primary_color: string | null;
  indexing: boolean;
  created_at: Date;
}

function toRecord(row: SiteRow, liveIds: Set<string> | null): SiteRecord {
  return {
    appId: row.app_id,
    siteName: row.site_name,
    siteUrl: row.site_url,
    adminUrl: row.admin_url,
    templateId: row.template_id,
    templateName: row.template_name,
    primaryColor: row.primary_color,
    indexing: row.indexing,
    createdAt: row.created_at.toISOString(),
    // Unknown liveness (Cloudways unreachable) is reported as live rather than
    // showing every site as deleted on a transient API failure.
    liveOnCloudways: liveIds ? liveIds.has(row.app_id) : true,
  };
}

export async function recordSite(site: {
  appId: string;
  siteName: string;
  siteUrl: string;
  adminUrl: string;
  templateId?: string | null;
  templateName?: string | null;
  primaryColor?: string | null;
}): Promise<void> {
  if (!isDbConfigured()) return;

  await query(
    `INSERT INTO sites (app_id, site_name, site_url, admin_url, template_id, template_name, primary_color)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (app_id) DO UPDATE SET
       site_name     = EXCLUDED.site_name,
       site_url      = EXCLUDED.site_url,
       admin_url     = EXCLUDED.admin_url,
       template_id   = EXCLUDED.template_id,
       template_name = EXCLUDED.template_name,
       primary_color = EXCLUDED.primary_color`,
    [
      site.appId,
      site.siteName,
      site.siteUrl,
      site.adminUrl,
      site.templateId ?? null,
      site.templateName ?? null,
      site.primaryColor ?? null,
    ],
  );
}

export async function listSites(): Promise<{ sites: SiteRecord[]; dbAvailable: boolean }> {
  const rows = await tryQuery<SiteRow>(
    `SELECT * FROM sites ORDER BY created_at DESC`,
  );

  if (!rows) return { sites: [], dbAvailable: false };

  // Reconcile against Cloudways so deleted apps are flagged.
  let liveIds: Set<string> | null = null;
  try {
    liveIds = new Set((await listApps()).map((a) => a.id));
  } catch {
    // Leave as null — liveness is reported as unknown-but-live.
  }

  return { sites: rows.map((r) => toRecord(r, liveIds)), dbAvailable: true };
}

export async function getSite(appId: string): Promise<SiteRecord | null> {
  const rows = await tryQuery<SiteRow>(`SELECT * FROM sites WHERE app_id = $1`, [appId]);
  if (!rows || rows.length === 0) return null;
  return toRecord(rows[0], null);
}

export async function setIndexing(appId: string, indexing: boolean): Promise<void> {
  if (!isDbConfigured()) return;
  await query(`UPDATE sites SET indexing = $2 WHERE app_id = $1`, [appId, indexing]);
}

export async function forgetSite(appId: string): Promise<void> {
  if (!isDbConfigured()) return;
  await query(`DELETE FROM sites WHERE app_id = $1`, [appId]);
}
