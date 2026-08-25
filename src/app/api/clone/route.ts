import { NextRequest, NextResponse } from 'next/server';
import type { ElementorThemeStyles } from '@/lib/wordpress';
import { createJob } from '@/lib/jobs';
import { runCloneJob, type CloneParams } from '@/lib/provision';

// Starts a provisioning job and returns its id immediately. The work runs
// detached from this request — progress is read back via /api/clone/stream,
// which can be re-attached after a disconnect. See src/lib/jobs.ts.

async function filePart(
  formData: FormData,
  key: string,
): Promise<{ buffer: Buffer; filename: string; mimeType: string } | null> {
  const file = formData.get(key) as File | null;
  if (!file || file.size === 0) return null;
  return {
    buffer: Buffer.from(await file.arrayBuffer()),
    filename: file.name,
    mimeType: file.type || 'image/png',
  };
}

export async function POST(req: NextRequest) {
  let params: CloneParams;

  try {
    const formData = await req.formData();

    const siteName = (formData.get('siteName') as string | null)?.trim();
    if (!siteName) {
      return NextResponse.json({ error: 'Site name is required.' }, { status: 400 });
    }

    const pluginStatesRaw = formData.get('pluginStates') as string | null;
    const themeStylesRaw = formData.get('themeStyles') as string | null;

    params = {
      templateId: (formData.get('templateId') as string | null) ?? 'standard',
      siteName,
      tagline: (formData.get('tagline') as string | null)?.trim() ?? '',
      notificationEmail: (formData.get('notificationEmail') as string | null)?.trim() ?? '',
      primaryColor: formData.get('primaryColor') as string,
      secondaryColor: formData.get('secondaryColor') as string,
      accentColor: formData.get('accentColor') as string,
      textColor: formData.get('textColor') as string,
      headingFont: formData.get('headingFont') as string,
      bodyFont: formData.get('bodyFont') as string,
      logo: await filePart(formData, 'logo'),
      favicon: await filePart(formData, 'favicon'),
      pluginStates: pluginStatesRaw ? JSON.parse(pluginStatesRaw) : {},
      themeStyles: themeStylesRaw ? (JSON.parse(themeStylesRaw) as ElementorThemeStyles) : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Invalid request: ${message}` }, { status: 400 });
  }

  const job = createJob();

  // Intentionally not awaited — the job outlives this request. runCloneJob
  // records every outcome on the job and never rejects.
  void runCloneJob(job, params);

  return NextResponse.json({ jobId: job.id });
}
