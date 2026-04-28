'use client';

import { useRef, useState, ChangeEvent, DragEvent } from 'react';

interface FileResult {
  name: string;
  status: 'pending' | 'ok' | 'error';
  error?: string;
}

interface Props {
  siteUrl: string;
  /** Optional label shown above the dropzone. */
  label?: string;
  /** Compact variant (smaller padding) for inline use in lists. */
  compact?: boolean;
}

export default function ImageUploader({ siteUrl, label, compact }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<Record<string, FileResult>>({});
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  function addFiles(incoming: FileList | File[]) {
    const list = Array.from(incoming).filter((f) => f.type.startsWith('image/'));
    if (list.length === 0) return;
    setFiles((prev) => [...prev, ...list]);
    setResults((prev) => {
      const next = { ...prev };
      for (const f of list) next[f.name] = { name: f.name, status: 'pending' };
      return next;
    });
    setSummary(null);
  }

  function handleSelect(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = '';
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
  }

  function clearAll() {
    setFiles([]);
    setResults({});
    setSummary(null);
  }

  async function handleUpload() {
    if (files.length === 0 || uploading) return;
    setUploading(true);
    setSummary(null);

    const formData = new FormData();
    formData.set('siteUrl', siteUrl);
    for (const f of files) formData.append('images', f);

    try {
      const res = await fetch('/api/upload-images', { method: 'POST', body: formData });
      if (!res.ok || !res.body) throw new Error(`Upload failed: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const chunk of parts) {
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            if (ev.event === 'file') {
              setResults((prev) => ({
                ...prev,
                [ev.name]: { name: ev.name, status: ev.ok ? 'ok' : 'error', error: ev.error },
              }));
            } else if (ev.event === 'complete') {
              setSummary(`Uploaded ${ev.succeeded}/${ev.total}${ev.failed ? ` — ${ev.failed} failed` : ''}.`);
            } else if (ev.event === 'error') {
              setSummary(`Failed: ${ev.message}`);
            }
          } catch {
            // Ignore malformed chunks
          }
        }
      }
    } catch (err) {
      setSummary(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  const padding = compact ? 'p-4' : 'p-6';

  return (
    <div className="space-y-3">
      {label && <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{label}</p>}

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`${padding} cursor-pointer rounded-xl border-2 border-dashed text-center transition ${
          dragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-gray-50 hover:border-gray-300'
        }`}
      >
        <p className="text-sm font-medium text-gray-700">
          Drop images here or <span className="text-blue-600 underline">browse</span>
        </p>
        <p className="text-xs text-gray-400 mt-1">PNG, JPG, WebP, SVG, GIF — uploaded to the site&apos;s media library</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*"
          className="sr-only"
          onChange={handleSelect}
        />
      </div>

      {files.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white">
          <ul className="max-h-48 overflow-y-auto divide-y divide-gray-100">
            {files.map((f) => {
              const r = results[f.name];
              return (
                <li key={f.name} className="px-3 py-2 flex items-center gap-3 text-sm">
                  <span className="flex-1 truncate text-gray-700">{f.name}</span>
                  <span className="text-xs text-gray-400 shrink-0">{Math.round(f.size / 1024)} KB</span>
                  <span className="shrink-0 w-5 text-center">
                    {r?.status === 'ok' && <span className="text-green-600">✓</span>}
                    {r?.status === 'error' && (
                      <span className="text-red-600" title={r.error}>✕</span>
                    )}
                    {r?.status === 'pending' && uploading && (
                      <span className="inline-block w-3 h-3 rounded-full border-2 border-gray-200 border-t-blue-500 animate-spin" />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="px-3 py-2 border-t border-gray-100 flex items-center justify-between gap-3">
            <p className="text-xs text-gray-500">
              {summary ?? `${files.length} file${files.length === 1 ? '' : 's'} ready`}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={clearAll}
                disabled={uploading}
                className="rounded-md border border-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={handleUpload}
                disabled={uploading || files.length === 0}
                className="rounded-md bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uploading ? 'Uploading…' : `Upload ${files.length}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
