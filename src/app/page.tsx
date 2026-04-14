'use client';

import { useState, useRef, useEffect, useCallback, FormEvent, ChangeEvent } from 'react';
import FontPicker from '@/components/FontPicker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SseEvent =
  | { event: 'status'; step: number; message: string }
  | { event: 'complete'; message: string; siteUrl: string; adminUrl: string; cloudwaysAppId: string }
  | { event: 'error'; message: string; cloudwaysAppId?: string };

type FormState = 'idle' | 'submitting' | 'complete' | 'error';

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

type TestState = 'idle' | 'running' | 'done';

interface Plugin {
  plugin: string;
  name: string;
  status: string;
}

type ColorVar = 'primary' | 'secondary' | 'accent' | 'text' | 'white' | 'black';

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Home() {
  const [formState, setFormState] = useState<FormState>('idle');
  const [statusMessages, setStatusMessages] = useState<string[]>([]);
  const [result, setResult] = useState<{ siteUrl: string; adminUrl?: string; appId: string } | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [faviconPreview, setFaviconPreview] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [partialAppId, setPartialAppId] = useState<string | undefined>();
  const [deleteState, setDeleteState] = useState<'idle' | 'deleting' | 'deleted'>('idle');
  const logRef = useRef<HTMLDivElement>(null);

  // Fonts
  const [fonts, setFonts] = useState<string[]>([]);
  const [headingFont, setHeadingFont] = useState('Montserrat');
  const [bodyFont, setBodyFont] = useState('Open Sans');

  // Colors (lifted for preview)
  const [primaryColor, setPrimaryColor] = useState('#3B82F6');
  const [secondaryColor, setSecondaryColor] = useState('#6366F1');
  const [accentColor, setAccentColor] = useState('#10B981');
  const [textColor, setTextColor] = useState('#111827');

  // Plugins
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [pluginStates, setPluginStates] = useState<Record<string, boolean>>({});
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);

  // Duplicate detection
  const [siteNameValue, setSiteNameValue] = useState('');
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [duplicateChecking, setDuplicateChecking] = useState(false);

  // Pre-flight
  const [showPreflight, setShowPreflight] = useState(false);
  const pendingFormDataRef = useRef<FormData | null>(null);

  // Elementor theme styles
  const [showThemeStyles, setShowThemeStyles] = useState(false);
  const [btnBgVar, setBtnBgVar] = useState<ColorVar>('accent');
  const [btnTextVar, setBtnTextVar] = useState<ColorVar>('white');
  const [btnHoverBgVar, setBtnHoverBgVar] = useState<ColorVar>('primary');
  const [btnBorderRadius, setBtnBorderRadius] = useState(4);
  const [linkColorVar, setLinkColorVar] = useState<ColorVar>('primary');
  const [linkHoverColorVar, setLinkHoverColorVar] = useState<ColorVar>('accent');
  const [containerWidth, setContainerWidth] = useState(1140);

  useEffect(() => {
    fetch('/api/fonts')
      .then((r) => r.json())
      .then((d) => setFonts(d.fonts ?? []))
      .catch(() => setFonts(['Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Inter']));

    setPluginsLoading(true);
    fetch('/api/plugins')
      .then((r) => r.json())
      .then((d: { plugins: Plugin[] }) => {
        setPlugins(d.plugins ?? []);
        const states: Record<string, boolean> = {};
        for (const p of d.plugins ?? []) {
          states[p.plugin] = p.status === 'active';
        }
        setPluginStates(states);
      })
      .catch(() => {})
      .finally(() => setPluginsLoading(false));
  }, []);

  // Dynamically load Google Fonts for preview
  useEffect(() => {
    const loadFont = (family: string) => {
      const id = `gfont-${family.replace(/\s+/g, '-')}`;
      if (document.getElementById(id)) return;
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;600&display=swap`;
      document.head.appendChild(link);
    };
    if (headingFont) loadFont(headingFont);
    if (bodyFont) loadFont(bodyFont);
  }, [headingFont, bodyFont]);

  // Duplicate site name check
  const checkDuplicate = useCallback(async (name: string) => {
    const label = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    if (!label) { setDuplicateWarning(null); return; }
    setDuplicateChecking(true);
    try {
      const res = await fetch(`/api/check-app?label=${encodeURIComponent(label)}`);
      const data = await res.json();
      if (data.exists) {
        setDuplicateWarning(`An app named "${label}" already exists${data.url ? ` — ${data.url}` : ''}.`);
      } else {
        setDuplicateWarning(null);
      }
    } catch { setDuplicateWarning(null); }
    finally { setDuplicateChecking(false); }
  }, []);

  // Resolve a colour var name to its hex value at submit time
  function resolveColorVar(v: ColorVar): string {
    switch (v) {
      case 'primary':   return primaryColor;
      case 'secondary': return secondaryColor;
      case 'accent':    return accentColor;
      case 'text':      return textColor;
      case 'white':     return '#ffffff';
      case 'black':     return '#000000';
    }
  }

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

  function handleFaviconChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setFaviconPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleDeleteApp() {
    if (!partialAppId) return;
    setDeleteState('deleting');
    try {
      const res = await fetch(`/api/delete-app?appId=${partialAppId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        alert(`Delete failed: ${data.error}`);
        setDeleteState('idle');
      } else {
        setDeleteState('deleted');
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      setDeleteState('idle');
    }
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const formData = new FormData(e.currentTarget);
    formData.set('pluginStates', JSON.stringify(showPlugins ? pluginStates : {}));

    if (showThemeStyles) {
      const ts = {
        buttonBackgroundColor: resolveColorVar(btnBgVar),
        buttonTextColor: resolveColorVar(btnTextVar),
        buttonHoverBackgroundColor: resolveColorVar(btnHoverBgVar),
        buttonBorderRadius: btnBorderRadius,
        linkColor: resolveColorVar(linkColorVar),
        linkHoverColor: resolveColorVar(linkHoverColorVar),
        containerWidth,
      };
      formData.set('themeStyles', JSON.stringify(ts));
    }

    pendingFormDataRef.current = formData;
    setShowPreflight(true);
  }

  async function doSubmit() {
    const formData = pendingFormDataRef.current;
    if (!formData) return;
    setShowPreflight(false);
    setFormState('submitting');
    setStatusMessages([]);
    setErrorMsg('');
    setResult(null);
    setPartialAppId(undefined);
    setDeleteState('idle');

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
              if (parsed.cloudwaysAppId) setPartialAppId(parsed.cloudwaysAppId);
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
                value={siteNameValue}
                onChange={(e) => { setSiteNameValue(e.target.value); setDuplicateWarning(null); }}
                onBlur={(e) => checkDuplicate(e.target.value)}
              />
              {duplicateChecking && <p className="mt-1 text-xs text-gray-400">Checking for duplicates…</p>}
              {duplicateWarning && (
                <p className="mt-1 text-xs text-amber-600 font-medium">⚠ {duplicateWarning}</p>
              )}
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

          {/* Logo & Favicon */}
          <Card title="Logo & Favicon">
            <div className="grid grid-cols-2 gap-6">
              {/* Logo */}
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">Logo</p>
                <div className="flex flex-col items-start gap-3">
                  {logoPreview ? (
                    <img src={logoPreview} alt="Logo preview" className="w-16 h-16 rounded-xl object-contain border border-gray-100 bg-gray-50" />
                  ) : (
                    <div className="w-16 h-16 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center text-gray-300 text-[10px] text-center select-none">
                      No logo
                    </div>
                  )}
                  <label htmlFor="logo" className="cursor-pointer inline-block rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition">
                    Choose file
                  </label>
                  <input id="logo" name="logo" type="file" accept="image/*" className="sr-only" onChange={handleLogoChange} disabled={isSubmitting} />
                  <p className="text-xs text-gray-400">PNG, SVG or JPG</p>
                </div>
              </div>

              {/* Favicon */}
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">Favicon</p>
                <div className="flex flex-col items-start gap-3">
                  {faviconPreview ? (
                    <img src={faviconPreview} alt="Favicon preview" className="w-16 h-16 rounded-xl object-contain border border-gray-100 bg-gray-50" />
                  ) : (
                    <div className="w-16 h-16 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center text-gray-300 text-[10px] text-center select-none">
                      No favicon
                    </div>
                  )}
                  <label htmlFor="favicon" className="cursor-pointer inline-block rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition">
                    Choose file
                  </label>
                  <input id="favicon" name="favicon" type="file" accept="image/*" className="sr-only" onChange={handleFaviconChange} disabled={isSubmitting} />
                  <p className="text-xs text-gray-400">PNG or ICO, 512×512</p>
                </div>
              </div>
            </div>
          </Card>

          {/* Brand Colours */}
          <Card title="Brand Colours">
            <div className="grid grid-cols-2 gap-4">
              <ControlledColorField name="primaryColor" label="Primary" value={primaryColor} onChange={setPrimaryColor} disabled={isSubmitting} />
              <ControlledColorField name="secondaryColor" label="Secondary" value={secondaryColor} onChange={setSecondaryColor} disabled={isSubmitting} />
              <ControlledColorField name="accentColor" label="Accent" value={accentColor} onChange={setAccentColor} disabled={isSubmitting} />
              <ControlledColorField name="textColor" label="Text" value={textColor} onChange={setTextColor} disabled={isSubmitting} />
            </div>

            {/* Live preview */}
            <div className="mt-4 rounded-xl overflow-hidden border border-gray-200 text-xs">
              <div className="px-4 py-2.5 flex items-center gap-3" style={{ backgroundColor: primaryColor }}>
                <span className="font-bold text-white text-sm opacity-90">Brand Preview</span>
                <span className="ml-auto flex gap-2">
                  <span className="w-2 h-2 rounded-full bg-white opacity-60" />
                  <span className="w-2 h-2 rounded-full bg-white opacity-60" />
                  <span className="w-2 h-2 rounded-full bg-white opacity-60" />
                </span>
              </div>
              <div className="p-4 bg-white flex gap-3 items-start">
                <div className="flex-1">
                  <div className="h-2.5 rounded mb-2 w-2/3" style={{ backgroundColor: textColor, opacity: 0.85 }} />
                  <div className="h-2 rounded mb-1.5 w-full opacity-20" style={{ backgroundColor: textColor }} />
                  <div className="h-2 rounded mb-3 w-4/5 opacity-20" style={{ backgroundColor: textColor }} />
                  <button
                    type="button"
                    className="px-3 py-1.5 rounded-lg text-white text-xs font-medium"
                    style={{ backgroundColor: accentColor }}
                  >
                    Call to action
                  </button>
                </div>
                <div className="w-16 h-16 rounded-lg flex-shrink-0" style={{ backgroundColor: secondaryColor, opacity: 0.15 }} />
              </div>
              <div className="px-4 py-2 flex gap-3" style={{ backgroundColor: secondaryColor }}>
                <span className="text-white opacity-70 text-[10px]">Footer • Secondary colour</span>
              </div>
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

            {/* Live font preview */}
            <div className="mt-2 rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-2">
              <p style={{ fontFamily: `'${headingFont}', sans-serif`, fontWeight: 600, fontSize: '1.25rem', color: textColor, lineHeight: 1.2 }}>
                The quick brown fox jumps
              </p>
              <p style={{ fontFamily: `'${bodyFont}', sans-serif`, fontWeight: 400, fontSize: '0.875rem', color: textColor, opacity: 0.75, lineHeight: 1.6 }}>
                Over the lazy dog. This is how your body text will look across the site — readable, clean, and on-brand.
              </p>
            </div>
          </Card>

          {/* Plugins */}
          <CollapsibleCard
            title="Plugins"
            checked={showPlugins}
            onToggle={setShowPlugins}
            disabled={isSubmitting}
            summary={showPlugins ? undefined : 'Configure which plugins are active on the cloned site'}
          >
            {pluginsLoading ? (
              <p className="text-sm text-gray-400">Loading plugins…</p>
            ) : plugins.length === 0 ? (
              <p className="text-sm text-gray-400">No plugins found — set TEMPLATE_WP_URL to load plugins.</p>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-gray-400 mb-3">Choose which plugins to activate on the cloned site.</p>
                {plugins.map((p) => (
                  <label key={p.plugin} className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={pluginStates[p.plugin] ?? false}
                      onChange={(e) => setPluginStates((prev) => ({ ...prev, [p.plugin]: e.target.checked }))}
                      disabled={isSubmitting}
                      className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                    />
                    <span className="text-sm text-gray-700 group-hover:text-gray-900">{p.name}</span>
                    <span className={`ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-full ${p.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {p.status}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </CollapsibleCard>

          {/* Elementor Theme Styles */}
          <CollapsibleCard
            title="Elementor Theme Styles"
            checked={showThemeStyles}
            onToggle={setShowThemeStyles}
            disabled={isSubmitting}
            summary={showThemeStyles ? undefined : 'Set buttons, links and layout defaults in the Elementor kit'}
          >
            <div className="space-y-5">
              {/* Buttons */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Button</p>
                <div className="grid grid-cols-2 gap-4">
                  <ColorVarField label="Background" value={btnBgVar} onChange={setBtnBgVar} disabled={isSubmitting} colors={{ primaryColor, secondaryColor, accentColor, textColor }} />
                  <ColorVarField label="Text" value={btnTextVar} onChange={setBtnTextVar} disabled={isSubmitting} colors={{ primaryColor, secondaryColor, accentColor, textColor }} />
                  <ColorVarField label="Hover Background" value={btnHoverBgVar} onChange={setBtnHoverBgVar} disabled={isSubmitting} colors={{ primaryColor, secondaryColor, accentColor, textColor }} />
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Border Radius (px)</label>
                    <input
                      type="number"
                      min={0}
                      max={50}
                      value={btnBorderRadius}
                      onChange={(e) => setBtnBorderRadius(Number(e.target.value))}
                      disabled={isSubmitting}
                      className={inputCls}
                    />
                  </div>
                </div>
              </div>

              {/* Links */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Links</p>
                <div className="grid grid-cols-2 gap-4">
                  <ColorVarField label="Link Color" value={linkColorVar} onChange={setLinkColorVar} disabled={isSubmitting} colors={{ primaryColor, secondaryColor, accentColor, textColor }} />
                  <ColorVarField label="Hover Color" value={linkHoverColorVar} onChange={setLinkHoverColorVar} disabled={isSubmitting} colors={{ primaryColor, secondaryColor, accentColor, textColor }} />
                </div>
              </div>

              {/* Layout */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Layout</p>
                <div className="max-w-xs">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Container Width</label>
                  <select
                    value={containerWidth}
                    onChange={(e) => setContainerWidth(Number(e.target.value))}
                    disabled={isSubmitting}
                    className={inputCls}
                  >
                    <option value={1140}>1140px (default)</option>
                    <option value={1200}>1200px</option>
                    <option value={1280}>1280px</option>
                    <option value={1440}>1440px (wide)</option>
                  </select>
                </div>
              </div>
            </div>
          </CollapsibleCard>

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
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                onClick={() => { setFormState('idle'); setErrorMsg(''); setStatusMessages([]); setPartialAppId(undefined); setDeleteState('idle'); }}
                className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100 transition"
              >
                Try again
              </button>
              {partialAppId && deleteState !== 'deleted' && (
                <button
                  onClick={handleDeleteApp}
                  disabled={deleteState === 'deleting'}
                  className="rounded-lg border border-red-400 bg-red-100 px-4 py-2 text-sm font-medium text-red-800 hover:bg-red-200 disabled:opacity-50 transition"
                >
                  {deleteState === 'deleting' ? 'Deleting…' : 'Delete cloned site'}
                </button>
              )}
              {deleteState === 'deleted' && (
                <span className="rounded-lg border border-green-300 bg-green-50 px-4 py-2 text-sm font-medium text-green-700">
                  ✓ Cloned site deleted
                </span>
              )}
            </div>
            {partialAppId && deleteState !== 'deleted' && (
              <p className="mt-2 text-xs text-red-500">App ID: {partialAppId} — delete this if you want to start fresh.</p>
            )}
          </div>
        )}
      </div>

      {/* Pre-flight confirmation modal */}
      {showPreflight && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-900">Ready to create site?</h2>
            <p className="text-sm text-gray-500">Review what will be configured before we start.</p>

            <ul className="text-sm space-y-2">
              <PreflightRow label="Site name" value={siteNameValue || '—'} />
              <PreflightRow label="Logo" value={logoPreview ? 'Yes' : 'None'} />
              <PreflightRow label="Favicon" value={faviconPreview ? 'Yes' : 'None'} />
              <PreflightRow label="Primary" value={<Swatch color={primaryColor} />} />
              <PreflightRow label="Secondary" value={<Swatch color={secondaryColor} />} />
              <PreflightRow label="Accent" value={<Swatch color={accentColor} />} />
              <PreflightRow label="Text" value={<Swatch color={textColor} />} />
              <PreflightRow label="Heading font" value={headingFont} />
              <PreflightRow label="Body font" value={bodyFont} />
              <PreflightRow
                label="Plugins"
                value={showPlugins ? `${Object.values(pluginStates).filter(Boolean).length} active` : 'Inherit from template'}
              />
              <PreflightRow
                label="Theme styles"
                value={showThemeStyles ? `Button radius ${btnBorderRadius}px, container ${containerWidth}px` : 'Not configured'}
              />
            </ul>

            {duplicateWarning && (
              <p className="text-xs text-amber-600 font-medium bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">⚠ {duplicateWarning}</p>
            )}

            <div className="flex gap-3 pt-2">
              <button
                onClick={doSubmit}
                className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition"
              >
                Create site
              </button>
              <button
                onClick={() => setShowPreflight(false)}
                className="flex-1 rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
              >
                Go back
              </button>
            </div>
          </div>
        </div>
      )}
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

function PreflightRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-4">
      <span className="text-gray-500 shrink-0">{label}</span>
      <span className="font-medium text-gray-800 text-right">{value}</span>
    </li>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block w-4 h-4 rounded border border-gray-200 shrink-0" style={{ backgroundColor: color }} />
      <span className="font-mono text-xs">{color}</span>
    </span>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{title}</h2>
      {children}
    </section>
  );
}

function CollapsibleCard({
  title,
  checked,
  onToggle,
  disabled,
  summary,
  children,
}: {
  title: string;
  checked: boolean;
  onToggle: (v: boolean) => void;
  disabled?: boolean;
  summary?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
      <label className="flex items-center gap-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onToggle(e.target.checked)}
          disabled={disabled}
          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
        />
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{title}</span>
        {!checked && summary && (
          <span className="ml-2 text-xs text-gray-400 font-normal normal-case tracking-normal">{summary}</span>
        )}
      </label>
      {checked && <div className="mt-4 space-y-4">{children}</div>}
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

function ControlledColorField({
  name,
  label,
  value,
  onChange,
  disabled,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 bg-white">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent p-0 disabled:opacity-50"
          aria-label={`${label} colour picker`}
        />
        <input
          name={name}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="flex-1 font-mono text-sm text-gray-700 focus:outline-none bg-transparent disabled:opacity-50"
          pattern="^#[0-9A-Fa-f]{6}$"
        />
      </div>
    </div>
  );
}

const COLOR_VAR_OPTIONS: { value: ColorVar; label: string }[] = [
  { value: 'primary',   label: 'Primary' },
  { value: 'secondary', label: 'Secondary' },
  { value: 'accent',    label: 'Accent' },
  { value: 'text',      label: 'Text' },
  { value: 'white',     label: 'White' },
  { value: 'black',     label: 'Black' },
];

function resolveVar(v: ColorVar, colors: { primaryColor: string; secondaryColor: string; accentColor: string; textColor: string }): string {
  switch (v) {
    case 'primary':   return colors.primaryColor;
    case 'secondary': return colors.secondaryColor;
    case 'accent':    return colors.accentColor;
    case 'text':      return colors.textColor;
    case 'white':     return '#ffffff';
    case 'black':     return '#000000';
  }
}

function ColorVarField({
  label,
  value,
  onChange,
  disabled,
  colors,
}: {
  label: string;
  value: ColorVar;
  onChange: (v: ColorVar) => void;
  disabled?: boolean;
  colors: { primaryColor: string; secondaryColor: string; accentColor: string; textColor: string };
}) {
  const hex = resolveVar(value, colors);
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 bg-white">
        <span className="w-5 h-5 rounded flex-shrink-0 border border-gray-200" style={{ backgroundColor: hex }} />
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as ColorVar)}
          disabled={disabled}
          className="flex-1 text-sm text-gray-700 focus:outline-none bg-transparent disabled:opacity-50"
        >
          {COLOR_VAR_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <span className="font-mono text-xs text-gray-400">{hex}</span>
      </div>
    </div>
  );
}
