// Client-side localStorage helpers for form autosave + clone history.

const FORM_KEY = 'cloudways-portal:form';
const HISTORY_KEY = 'cloudways-portal:clones';

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

export interface CloneRecord {
  appId: string;
  siteName: string;
  siteUrl: string;
  adminUrl: string;
  templateId: string;
  templateName: string;
  primaryColor: string;
  createdAt: string; // ISO
}

export function loadHistory(): CloneRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as CloneRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveClone(record: CloneRecord): void {
  if (typeof window === 'undefined') return;
  try {
    const existing = loadHistory();
    const deduped = existing.filter((r) => r.appId !== record.appId);
    const next = [record, ...deduped].slice(0, 100);
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // Ignore
  }
}

export function removeClone(appId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const next = loadHistory().filter((r) => r.appId !== appId);
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // Ignore
  }
}
