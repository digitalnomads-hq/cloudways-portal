import { NextRequest } from 'next/server';
import { uploadLogo } from '@/lib/wordpress';
import { listApps } from '@/lib/cloudways';

// Bulk upload images to a cloned site's WordPress media library.
// Streams per-file results back via SSE so a long batch surfaces progress.
//
// The target is chosen by appId and resolved against the Cloudways app list —
// never taken from the request as a URL. This endpoint sends the WordPress
// application password as Basic auth, so accepting a caller-supplied address
// would let anyone with the portal password point it at a host they control
// and collect credentials that grant admin on every site we manage.

export const maxDuration = 300;

function sseEvent(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Resolve an app id to its site URL using Cloudways as the source of truth. */
async function resolveSiteUrl(appId: string): Promise<string | null> {
  const app = (await listApps()).find((a) => a.id === appId);
  if (!app) return null;
  return app.app_fqdn ? `https://${app.app_fqdn}` : `http://${app.cname}`;
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, payload: Record<string, unknown> = {}) => {
        controller.enqueue(encoder.encode(sseEvent({ event, ...payload })));
      };

      try {
        const formData = await req.formData();
        const appId = (formData.get('appId') as string | null)?.trim();
        if (!appId) {
          send('error', { message: 'appId is required' });
          controller.close();
          return;
        }

        const files = formData.getAll('images').filter((f): f is File => f instanceof File);
        if (files.length === 0) {
          send('error', { message: 'No images provided' });
          controller.close();
          return;
        }

        const siteUrl = await resolveSiteUrl(appId);
        if (!siteUrl) {
          send('error', { message: 'Unknown app — it is not on the configured Cloudways server.' });
          controller.close();
          return;
        }

        const creds = {
          baseUrl: siteUrl,
          username: process.env.TEMPLATE_WP_USERNAME!,
          appPassword: process.env.TEMPLATE_WP_APP_PASSWORD!,
        };

        send('start', { total: files.length });

        let succeeded = 0;
        let failed = 0;

        for (const file of files) {
          if (file.size === 0) {
            failed++;
            send('file', { name: file.name, ok: false, error: 'Empty file' });
            continue;
          }
          try {
            const buffer = Buffer.from(await file.arrayBuffer());
            const mimeType = file.type || 'application/octet-stream';
            const mediaId = await uploadLogo(creds, buffer, file.name, mimeType);
            succeeded++;
            send('file', { name: file.name, ok: true, mediaId });
          } catch (err) {
            failed++;
            const message = err instanceof Error ? err.message : String(err);
            send('file', { name: file.name, ok: false, error: message.slice(0, 200) });
          }
        }

        send('complete', { succeeded, failed, total: files.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send('error', { message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
