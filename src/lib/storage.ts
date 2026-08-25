// Client-side localStorage helpers for form autosave.
//
// Clone history used to live here too, but a per-browser list meant nobody
// could see anyone else's sites. It now lives server-side in the shared
// registry (src/lib/registry.ts).

const FORM_KEY = 'cloudways-portal:form';

export interface SavedFormState {
  siteName?: string;
  tagline?: string;
  notificationEmail?: string;
  selectedTemplate?: string;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  textColor?: string;
  headingFont?: string;
  bodyFont?: string;
  showPlugins?: boolean;
  pluginStates?: Record<string, boolean>;
  showThemeStyles?: boolean;
  btnBgVar?: string;
  btnTextVar?: string;
  btnHoverBgVar?: string;
  btnBorderRadius?: number;
  linkColorVar?: string;
  linkHoverColorVar?: string;
  containerWidth?: number;
}

export function loadForm(): SavedFormState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(FORM_KEY);
    return raw ? (JSON.parse(raw) as SavedFormState) : null;
  } catch {
    return null;
  }
}

export function saveForm(state: SavedFormState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FORM_KEY, JSON.stringify(state));
  } catch {
    // Quota or serialisation errors are non-fatal
  }
}

export function clearForm(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(FORM_KEY);
  } catch {
    // Ignore
  }
}
