'use client';

import { useState, useRef, useEffect, FormEvent, ChangeEvent } from 'react';
import FontPicker from '@/components/FontPicker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SseEvent =
  | { event: 'status'; step: number; message: string }
  | { event: 'complete'; message: string; siteUrl: string; adminUrl: string; cloudwaysAppId: string }
  | { event: 'error'; message: string };

type FormState = 'idle' | 'submitting' | 'complete' | 'error';

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

type TestState = 'idle' | 'running' | 'done';

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Home() {
  const [formState, setFormState] = useState<FormState>('idle');
  const [statusMessages, setStatusMessages] = useState<string[]>([]);
  const [result, setResult] = useState<{ siteUrl: string; adminUrl?: string; appId: string } | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  // Fonts
  const [fonts, setFonts] = useState<string[]>([]);
  const [headingFont, setHeadingFont] = useState('Montserrat');
  const [bodyFont, setBodyFont] = useState('Open Sans');

  useEffect(() => {
    fetch('/api/fonts')
      .then((r) => r.json())
      .then((d) => setFonts(d.fonts ?? []))
      .catch(() => setFonts(['Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Inter']));
  }, []);

  // Config test
  const [testState, setTestState] = useState<TestState>('idle');
  const [testChecks, setTestChecks] = useState<CheckResult[]>([]);

  async function runTests() {
    setTestState('running');
    setTestChecks([]);
    try {
      const res = await fetch('/api/test');
      const data = await res.json();
      setTestChecks(data.checks ?? []);
    } catch (err) {
      setTestChecks([{ name: 'Connection', ok: false, message: err instanceof Error ? err.message : String(err) }]);
    }
    setTestState('done');
  }

  function addMessage(msg: string) {
    setStatusMessages((prev) => [...prev, msg]);
    setTimeout(
      () => logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }),
      50,
    );
  }

  function handleLogoChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setLogoPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormState('submitting');
    setStatusMessages([]);
    setErrorMsg('');
    setResult(null);

    const formData = new FormData(e.currentTarget);

    try {
      const res = await fetch('/api/clone', { method: 'POST', body: formData });

      if (!res.ok || !res.body) {
        throw new Error(`Request failed: ${res.status} ${res.statusText}`);
      }

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
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          try {
            const parsed: SseEvent = JSON.parse(dataLine.slice(5).trim());
            if (parsed.event === 'status') {
              addMessage(parsed.message);
            } else if (parsed.event === 'complete') {
              addMessage(parsed.message);
              setResult({ siteUrl: parsed.siteUrl, adminUrl: parsed.adminUrl, appId: parsed.cloudwaysAppId });
              setFormState('complete');
            } else if (parsed.event === 'error') {
              setErrorMsg(parsed.message);
              setFormState('error');
            }
          } catch {
            // Ignore malformed chunks
          }
        }
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setFormState('error');
    }
  }

  const isSubmitting = formState === 'submitting';

  return (
    <main className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">New WordPress Site</h1>
          <p className="mt-1 text-gray-500 text-sm">
            Fill in the details below — we&apos;ll clone the framework site and configure it automatically.
          </p>
        </div>

        {/* Config test */}
        <div className="mb-6 bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-700">Configuration Check</h2>
              <p className="text-xs text-gray-400 mt-0.5">Verify your .env.local credentials before creating a site</p>
            </div>
            <button
              type="button"
              onClick={runTests}
              disabled={testState === 'running'}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {testState === 'running' ? 'Testing…' : 'Test Config'}
            </button>
          </div>

          {(testState === 'running' || testChecks.length > 0) && (
            <ul className="mt-4 space-y-2">
              {testChecks.map((check) => (
                <li key={check.name} className="flex items-start gap-3 text-sm">
                  <span className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold ${check.ok ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'}`}>
                    {check.ok ? '✓' : '✕'}
                  </span>
                  <span>
                    <span className="font-medium text-gray-700">{check.name}</span>
                    <span className="text-gray-500"> — {check.message}</span>
                  </span>
                </li>
              ))}
              {testState === 'running' && (
                <li className="flex items-center gap-3 text-sm text-gray-400">
                  <span className="w-4 h-4 rounded-full border-2 border-gray-200 border-t-blue-500 animate-spin flex-shrink-0" />
                  Checking…
                </li>
              )}
            </ul>
          )}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-6">

          {/* Basic Details */}
          <Card title="Basic Details">
            <Field label="Site Name" required>
              <input
                name="siteName"
                type="text"
                required
                placeholder="Acme Corp"
                disabled={isSubmitting}
                className={inputCls}
              />
            </Field>
            <Field label="Tagline">
              <input
                name="tagline"
                type="text"
                placeholder="Just another great site"
                disabled={isSubmitting}
                className={inputCls}
              />
            </Field>
            <Field label="Notification Email">
              <input
                name="notificationEmail"
                type="email"
                placeholder="client@example.com — receives a summary when the site is ready"
                disabled={isSubmitting}
                className={inputCls}
              />
            </Field>
          </Card>

          {/* Logo */}
          <Card title="Logo">
            <div className="flex items-center gap-5">
              {logoPreview ? (
                <img
                  src={logoPreview}
                  alt="Logo preview"
                  className="w-20 h-20 rounded-xl object-contain border border-gray-100 bg-gray-50"
                />
              ) : (
                <div className="w-20 h-20 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center text-gray-300 text-[10px] text-center select-none">
                  No logo
                </div>
              )}
              <div>
                <label
                  htmlFor="logo"
                  className="cursor-pointer inline-block rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
                >
                  Choose file
                </label>
                <input
                  id="logo"
                  name="logo"
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={handleLogoChange}
                  disabled={isSubmitting}
                />
                <p className="mt-1 text-xs text-gray-400">PNG, SVG, or JPG recommended</p>
              </div>
            </div>
          </Card>

          {/* Brand Colours */}
          <Card title="Brand Colours">
            <div className="grid grid-cols-2 gap-4">
              <ColorField name="primaryColor" label="Primary" defaultValue="#3B82F6" disabled={isSubmitting} />
              <ColorField name="secondaryColor" label="Secondary" defaultValue="#6366F1" disabled={isSubmitting} />
              <ColorField name="accentColor" label="Accent" defaultValue="#10B981" disabled={isSubmitting} />
              <ColorField name="textColor" label="Text" defaultValue="#111827" disabled={isSubmitting} />
            </div>
          </Card>

          {/* Typography */}
          <Card title="Typography">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Heading Font">
                <FontPicker
                  name="headingFont"
                  value={headingFont}
                  onChange={setHeadingFont}
                  fonts={fonts}
                  disabled={isSubmitting}
                  placeholder={fonts.length === 0 ? 'Loading fonts…' : 'Search fonts…'}
                />
              </Field>
              <Field label="Body Font">
                <FontPicker
                  name="bodyFont"
                  value={bodyFont}
                  onChange={setBodyFont}
                  fonts={fonts}
                  disabled={isSubmitting}
                  placeholder={fonts.length === 0 ? 'Loading fonts…' : 'Search fonts…'}
                />
              </Field>
            </div>
          </Card>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-xl bg-blue-600 px-6 py-3 text-white font-semibold text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {isSubmitting ? 'Creating site…' : 'Create Site'}
          </button>
        </form>

        {/* Progress log */}
        {statusMessages.length > 0 && (
          <div className="mt-8 bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Progress</h2>
            <div ref={logRef} className="max-h-48 overflow-y-auto space-y-1 font-mono text-xs text-gray-600">
              {statusMessages.map((msg, i) => (
                <p key={i}>
                  <span className="text-gray-300 mr-2 select-none">{String(i + 1).padStart(2, '0')}</span>
                  {msg}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* Success */}
        {formState === 'complete' && result && (
          <div className="mt-6 bg-green-50 border border-green-200 rounded-2xl p-6">
            <h2 className="text-base font-semibold text-green-800 mb-1">Site ready!</h2>
            <p className="text-sm text-green-700 mb-3">
              Your new WordPress site has been cloned and configured.
            </p>
            <a
              href={result.siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 transition"
            >
              Open site →
            </a>
            {result.adminUrl && (
              <a
                href={result.adminUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block rounded-lg border border-green-300 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-100 transition ml-2"
              >
                WP Admin →
              </a>
            )}
            <p className="mt-3 text-xs text-green-600">Cloudways App ID: {result.appId}</p>
          </div>
        )}

        {/* Error */}
        {formState === 'error' && errorMsg && (
          <div className="mt-6 bg-red-50 border border-red-200 rounded-2xl p-6">
            <h2 className="text-base font-semibold text-red-800 mb-1">Something went wrong</h2>
            <pre className="text-sm text-red-700 whitespace-pre-wrap font-mono">{errorMsg}</pre>
            <button
              onClick={() => { setFormState('idle'); setErrorMsg(''); setStatusMessages([]); }}
              className="mt-4 rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100 transition"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Shared style
// ---------------------------------------------------------------------------

const inputCls =
  'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white disabled:opacity-50';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}

function ColorField({
  name,
  label,
  defaultValue,
  disabled,
}: {
  name: string;
  label: string;
  defaultValue: string;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(defaultValue);

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 bg-white">
        <input
          type="color"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent p-0 disabled:opacity-50"
          aria-label={`${label} colour picker`}
        />
        <input
          name={name}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          className="flex-1 font-mono text-sm text-gray-700 focus:outline-none bg-transparent disabled:opacity-50"
          pattern="^#[0-9A-Fa-f]{6}$"
        />
      </div>
    </div>
  );
}
