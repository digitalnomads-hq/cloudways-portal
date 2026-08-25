'use client';

import { useEffect, useState, useCallback, Fragment } from 'react';
import Link from 'next/link';
import ImageUploader from '@/components/ImageUploader';

interface SiteRecord {
  appId: string;
  siteName: string;
  siteUrl: string;
  adminUrl: string;
  templateId: string | null;
  templateName: string | null;
  primaryColor: string | null;
  indexing: boolean;
  createdAt: string;
  liveOnCloudways: boolean;
}

interface ResumableJob {
  id: string;
  siteName: string;
  appId: string | null;
  siteUrl: string | null;
  lastPhase: number;
  error: string | null;
  updatedAt: string;
}

export default function SitesPage() {
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [resumable, setResumable] = useState<ResumableJob[]>([]);
  const [dbAvailable, setDbAvailable] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [sitesRes, resumeRes] = await Promise.all([
        fetch('/api/sites').then((r) => r.json()),
        fetch('/api/clone/resume').then((r) => r.json()).catch(() => ({ jobs: [] })),
      ]);
      setSites(sitesRes.sites ?? []);
      setDbAvailable(sitesRes.dbAvailable !== false);
      setResumable(resumeRes.jobs ?? []);
    } catch {
      setDbAvailable(false);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleDelete(appId: string, siteName: string) {
    if (!confirm(`Delete "${siteName}" from Cloudways? This cannot be undone.`)) return;
    setBusy(appId);
    try {
      const res = await fetch(`/api/delete-app?appId=${appId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        alert(`Delete failed: ${data.error ?? res.statusText}`);
        return;
      }
      await fetch(`/api/sites?appId=${appId}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleForget(appId: string) {
    if (!confirm('Remove this site from the shared list? The Cloudways app will not be deleted.')) return;
    setBusy(appId);
    try {
      await fetch(`/api/sites?appId=${appId}`, { method: 'DELETE' });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function handleToggleIndexing(site: SiteRecord) {
    const turningOn = !site.indexing;
    if (turningOn && !confirm(`Allow search engines to index "${site.siteName}"? Do this only when the site is ready to launch.`)) return;

    setBusy(site.appId);
    setNotice(null);
    try {
      const res = await fetch('/api/sites/indexing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: site.appId, enabled: turningOn }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setNotice(
        turningOn
          ? `Search engine indexing enabled for ${site.siteName}.`
          : `Indexing disabled again for ${site.siteName}.`,
      );
      await refresh();
    } catch (err) {
      alert(`Could not change indexing: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleResume(jobId: string) {
    setBusy(jobId);
    try {
      const res = await fetch('/api/clone/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      // Hand off to the dashboard, which knows how to follow a running job.
      window.location.href = `/?job=${encodeURIComponent(data.jobId)}`;
    } catch (err) {
      alert(`Could not resume: ${err instanceof Error ? err.message : String(err)}`);
      setBusy(null);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Sites</h1>
            <p className="mt-1 text-gray-500 text-sm">
              Every site created through this portal, shared across the team.
            </p>
          </div>
          <Link
            href="/"
            className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition"
          >
            + New site
          </Link>
        </div>

        {!dbAvailable && loaded && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <strong>Shared list unavailable.</strong> DATABASE_URL is not configured, so sites
            created here are not being recorded. Set it to enable the shared registry.
          </div>
        )}

        {notice && (
          <div className="mb-6 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            {notice}
          </div>
        )}

        {/* Resumable failed builds */}
        {resumable.length > 0 && (
          <div className="mb-6 rounded-2xl border border-orange-200 bg-orange-50 p-5">
            <h2 className="text-sm font-semibold text-orange-900 mb-1">Unfinished builds</h2>
            <p className="text-xs text-orange-700 mb-3">
              These builds created a site but failed partway through configuring it. Resuming
              continues from where it stopped — it will not clone a second site.
            </p>
            <ul className="space-y-2">
              {resumable.map((j) => (
                <li key={j.id} className="flex items-start justify-between gap-3 rounded-lg bg-white border border-orange-200 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-800">{j.siteName}</p>
                    <p className="text-xs text-gray-500">
                      Stopped after phase {j.lastPhase} · {new Date(j.updatedAt).toLocaleString()}
                    </p>
                    {j.error && (
                      <p className="text-xs text-red-600 mt-1 break-words line-clamp-2">{j.error}</p>
                    )}
                  </div>
                  <button
                    onClick={() => handleResume(j.id)}
                    disabled={busy === j.id}
                    className="shrink-0 rounded-md bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
                  >
                    {busy === j.id ? 'Resuming…' : 'Resume'}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!loaded ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : sites.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-10 text-center">
            <p className="text-sm text-gray-500">No sites yet. Create one from the dashboard.</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <tr>
                  <th className="text-left px-5 py-3">Site</th>
                  <th className="text-left px-5 py-3">Template</th>
                  <th className="text-left px-5 py-3">Indexing</th>
                  <th className="text-left px-5 py-3">Created</th>
                  <th className="text-right px-5 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sites.map((r) => (
                  <Fragment key={r.appId}>
                    <tr className={r.liveOnCloudways ? 'hover:bg-gray-50' : 'bg-gray-50/60 opacity-60'}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <span
                            className="w-3 h-3 rounded-full shrink-0 border border-gray-200"
                            style={{ backgroundColor: r.primaryColor ?? '#e5e7eb' }}
                          />
                          <div className="min-w-0">
                            <p className="font-medium text-gray-800">
                              {r.siteName}
                              {!r.liveOnCloudways && (
                                <span className="ml-2 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600 uppercase">
                                  Deleted
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-gray-400 break-all">{r.siteUrl}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-gray-600">{r.templateName ?? '—'}</td>
                      <td className="px-5 py-3">
                        <button
                          onClick={() => handleToggleIndexing(r)}
                          disabled={busy === r.appId || !r.liveOnCloudways}
                          title={r.indexing ? 'Search engines can index this site' : 'Search engines are discouraged'}
                          className={`rounded-full px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${
                            r.indexing
                              ? 'bg-green-100 text-green-800 hover:bg-green-200'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}
                        >
                          {busy === r.appId ? '…' : r.indexing ? 'Indexed' : 'Not indexed'}
                        </button>
                      </td>
                      <td className="px-5 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {new Date(r.createdAt).toLocaleString()}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex justify-end gap-2 flex-wrap">
                          <a
                            href={r.siteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
                          >
                            Site
                          </a>
                          <a
                            href={r.adminUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
                          >
                            Admin
                          </a>
                          <button
                            onClick={() => setUploadOpen(uploadOpen === r.appId ? null : r.appId)}
                            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                              uploadOpen === r.appId
                                ? 'border-blue-300 bg-blue-50 text-blue-700'
                                : 'border-gray-200 text-gray-700 hover:bg-gray-100'
                            }`}
                          >
                            {uploadOpen === r.appId ? 'Close' : 'Images'}
                          </button>
                          <button
                            onClick={() => handleForget(r.appId)}
                            disabled={busy === r.appId}
                            className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                            title="Remove from the list only"
                          >
                            Forget
                          </button>
                          <button
                            onClick={() => handleDelete(r.appId, r.siteName)}
                            disabled={busy === r.appId || !r.liveOnCloudways}
                            className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                          >
                            {busy === r.appId ? 'Working…' : 'Delete'}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {uploadOpen === r.appId && (
                      <tr className="bg-gray-50">
                        <td colSpan={5} className="px-5 py-4">
                          <ImageUploader appId={r.appId} compact label={`Upload to ${r.siteName}`} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
