'use client';

import { useEffect, useState, Fragment } from 'react';
import Link from 'next/link';
import { loadHistory, removeClone, type CloneRecord } from '@/lib/storage';
import ImageUploader from '@/components/ImageUploader';

export default function SitesPage() {
  const [history, setHistory] = useState<CloneRecord[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [uploadOpen, setUploadOpen] = useState<string | null>(null);

  useEffect(() => {
    setHistory(loadHistory());
    setLoaded(true);
  }, []);

  async function handleDelete(appId: string, siteName: string) {
    if (!confirm(`Delete "${siteName}" from Cloudways? This cannot be undone.`)) return;
    setDeleting(appId);
    try {
      const res = await fetch(`/api/delete-app?appId=${appId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        alert(`Delete failed: ${data.error ?? res.statusText}`);
        return;
      }
      removeClone(appId);
      setHistory(loadHistory());
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(null);
    }
  }

  function handleForget(appId: string) {
    if (!confirm('Remove this site from your local history? The Cloudways app will not be deleted.')) return;
    removeClone(appId);
    setHistory(loadHistory());
  }

  return (
    <main className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Clone History</h1>
            <p className="mt-1 text-gray-500 text-sm">
              Sites created in this browser. Stored locally — clear your browser data to reset.
            </p>
          </div>
          <Link
            href="/"
            className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition"
          >
            + New site
          </Link>
        </div>

        {!loaded ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : history.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-10 text-center">
            <p className="text-sm text-gray-500">No sites yet. Create one from the dashboard.</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <tr>
                  <th className="text-left px-5 py-3">Site</th>
                  <th className="text-left px-5 py-3">Template</th>
                  <th className="text-left px-5 py-3">Created</th>
                  <th className="text-right px-5 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {history.map((r) => (
                  <Fragment key={r.appId}>
                  <tr className="hover:bg-gray-50">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span
                          className="w-3 h-3 rounded-full shrink-0 border border-gray-200"
                          style={{ backgroundColor: r.primaryColor }}
                        />
                        <div>
                          <p className="font-medium text-gray-800">{r.siteName}</p>
                          <p className="text-xs text-gray-400 break-all">{r.siteUrl}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-gray-600">{r.templateName}</td>
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
                          className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100"
                          title="Remove from history only"
                        >
                          Forget
                        </button>
                        <button
                          onClick={() => handleDelete(r.appId, r.siteName)}
                          disabled={deleting === r.appId}
                          className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                        >
                          {deleting === r.appId ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {uploadOpen === r.appId && (
                    <tr className="bg-gray-50">
                      <td colSpan={4} className="px-5 py-4">
                        <ImageUploader siteUrl={r.siteUrl} compact label={`Upload to ${r.siteName}`} />
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
