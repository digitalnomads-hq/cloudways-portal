import { NextRequest } from 'next/server';
import { cloneApp, waitForClone, restartNginxAndWait } from '@/lib/cloudways';
import { configureWordPress, setPluginStates } from '@/lib/wordpress';
import type { ElementorColor, ElementorTypography, ElementorThemeStyles } from '@/lib/wordpress';
import { checkPluginUpdates } from '@/lib/wordpress';
import { deleteDefaultContent, createStandardPages, configureSiteSettings, createNavMenu } from '@/lib/wp-setup';
import { sendSiteSummary } from '@/lib/email';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sseEvent(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, payload: Record<string, unknown> = {}) => {
        controller.enqueue(encoder.encode(sseEvent({ event, ...payload })));
      };

      let partialAppId: string | undefined;

      try {
        // ----------------------------------------------------------------
        // 1. Parse form data
        // ----------------------------------------------------------------
        const formData = await req.formData();

        const siteName = (formData.get('siteName') as string | null)?.trim();
        const tagline = (formData.get('tagline') as string | null)?.trim() ?? '';
        const notificationEmail = (formData.get('notificationEmail') as string | null)?.trim() ?? '';
        const primaryColor = formData.get('primaryColor') as string;
        const secondaryColor = formData.get('secondaryColor') as string;
        const accentColor = formData.get('accentColor') as string;
        const textColor = formData.get('textColor') as string;
        const headingFont = formData.get('headingFont') as string;
        const bodyFont = formData.get('bodyFont') as string;
        const logoFile = formData.get('logo') as File | null;

        if (!siteName) {
          send('error', { message: 'Site name is required.' });
          controller.close();
          return;
        }

        const colors: ElementorColor[] = [
          { _id: 'primary',   title: 'Primary',   color: primaryColor },
          { _id: 'secondary', title: 'Secondary', color: secondaryColor },
          { _id: 'accent',    title: 'Accent',    color: accentColor },
          { _id: 'text',      title: 'Text',      color: textColor },
        ];

        const typography: ElementorTypography[] = [
          { _id: 'primary',   title: 'Primary',   typography_typography: 'custom', typography_font_family: headingFont, typography_font_weight: '600' },
          { _id: 'secondary', title: 'Secondary', typography_typography: 'custom', typography_font_family: headingFont, typography_font_weight: '400' },
          { _id: 'text',      title: 'Text',      typography_typography: 'custom', typography_font_family: bodyFont,    typography_font_weight: '400' },
          { _id: 'accent',    title: 'Accent',    typography_typography: 'custom', typography_font_family: bodyFont,    typography_font_weight: '500' },
        ];

        let logoBuffer: Buffer | null = null;
        let logoFilename = '';
        let logoMimeType = '';
        if (logoFile && logoFile.size > 0) {
          logoBuffer = Buffer.from(await logoFile.arrayBuffer());
          logoFilename = logoFile.name;
          logoMimeType = logoFile.type || 'image/png';
        }

        const faviconFile = formData.get('favicon') as File | null;
        let faviconBuffer: Buffer | null = null;
        let faviconFilename = '';
        let faviconMimeType = '';
        if (faviconFile && faviconFile.size > 0) {
          faviconBuffer = Buffer.from(await faviconFile.arrayBuffer());
          faviconFilename = faviconFile.name;
          faviconMimeType = faviconFile.type || 'image/png';
        }

        // Plugin states: { 'plugin/plugin.php': true/false }
        const pluginStatesRaw = formData.get('pluginStates') as string | null;
        const pluginStates: Record<string, boolean> = pluginStatesRaw ? JSON.parse(pluginStatesRaw) : {};

        // Theme styles (optional)
        const themeStylesRaw = formData.get('themeStyles') as string | null;
        const themeStyles: ElementorThemeStyles | undefined = themeStylesRaw ? JSON.parse(themeStylesRaw) : undefined;

        // ----------------------------------------------------------------
        // 2. Check plugins on template for available updates
        // ----------------------------------------------------------------
        if (process.env.TEMPLATE_WP_URL) {
          const templateCreds = {
            baseUrl: process.env.TEMPLATE_WP_URL,
            username: process.env.TEMPLATE_WP_USERNAME!,
            appPassword: process.env.TEMPLATE_WP_APP_PASSWORD!,
          };
          await checkPluginUpdates(templateCreds, (msg) => send('status', { step: 2, message: msg }));
        } else {
          send('status', { step: 2, message: 'TEMPLATE_WP_URL not set — skipping plugin check.' });
        }

        // ----------------------------------------------------------------
        // 3. Clone
        // ----------------------------------------------------------------
        const appLabel = slugify(siteName);
        send('status', { step: 3, message: `Cloning template as "${appLabel}"…` });

        await cloneApp(appLabel);
        send('status', { step: 3, message: 'Clone started. Waiting for it to provision…' });

        // ----------------------------------------------------------------
        // 4. Wait for cloned app to appear
        // ----------------------------------------------------------------
        const newApp = await waitForClone(
          appLabel,
          (msg) => send('status', { step: 4, message: msg }),
        );
        partialAppId = newApp.id;
        send('status', { step: 4, message: 'Clone complete.' });
        const siteUrl = newApp.app_fqdn ? `https://${newApp.app_fqdn}` : `http://${newApp.cname}`;
        const adminUrl = `${siteUrl}/wp-admin`;

        // ----------------------------------------------------------------
        // 5. Restart Nginx + wait for site to be reachable
        // ----------------------------------------------------------------
        send('status', { step: 5, message: 'Restarting Nginx…' });
        await restartNginxAndWait(siteUrl, (msg) => send('status', { step: 5, message: msg }));

        // ----------------------------------------------------------------
        // 6. WordPress: branding (title, logo, Elementor kit)
        // ----------------------------------------------------------------
        const wpCreds = {
          baseUrl: siteUrl,
          username: process.env.TEMPLATE_WP_USERNAME!,
          appPassword: process.env.TEMPLATE_WP_APP_PASSWORD!,
        };

        send('status', { step: 6, message: 'Configuring branding…' });
        try {
          await configureWordPress(
            wpCreds,
            { title: siteName, tagline, logoBuffer, logoFilename, logoMimeType, faviconBuffer, faviconFilename, faviconMimeType, colors, typography, themeStyles },
            (msg) => send('status', { step: 6, message: msg }),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('Elementor')) {
            send('status', { step: 6, message: `⚠ Elementor globals not set (${msg.slice(0, 120)}) — set colours/fonts manually in Elementor → Site Settings.` });
          } else {
            throw err;
          }
        }

        // ----------------------------------------------------------------
        // 7. WordPress: cleanup default content
        // ----------------------------------------------------------------
        send('status', { step: 7, message: 'Cleaning up default content…' });
        await deleteDefaultContent(wpCreds, (msg) => send('status', { step: 7, message: msg }));

        // ----------------------------------------------------------------
        // 8. WordPress: create standard pages
        // ----------------------------------------------------------------
        send('status', { step: 8, message: 'Creating standard pages…' });
        const pages = await createStandardPages(wpCreds, (msg) => send('status', { step: 8, message: msg }));

        // ----------------------------------------------------------------
        // 9. WordPress: site settings (timezone, front page, comments)
        // ----------------------------------------------------------------
        send('status', { step: 9, message: 'Configuring site settings…' });
        await configureSiteSettings(wpCreds, pages.home, (msg) => send('status', { step: 9, message: msg }));

        // ----------------------------------------------------------------
        // 10. Nav menu via REST API
        // ----------------------------------------------------------------
        send('status', { step: 10, message: 'Setting up navigation menu…' });
        await createNavMenu(
          wpCreds,
          [
            { title: 'Home',     id: pages.home },
            { title: 'About',    id: pages.about },
            { title: 'Services', id: pages.services },
            { title: 'Contact',  id: pages.contact },
          ],
          (msg) => send('status', { step: 10, message: msg }),
        );

        // ----------------------------------------------------------------
        // 10.5 Set plugin states
        // ----------------------------------------------------------------
        if (Object.keys(pluginStates).length > 0) {
          send('status', { step: 10, message: 'Configuring plugins…' });
          await setPluginStates(wpCreds, pluginStates, (msg) => send('status', { step: 10, message: msg }));
        }

        // ----------------------------------------------------------------
        // 11. Send summary email (if SMTP configured and email provided)
        // ----------------------------------------------------------------
        const smtpReady = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
        if (smtpReady && notificationEmail) {
          send('status', { step: 11, message: `Sending summary email to ${notificationEmail}…` });
          try {
            await sendSiteSummary({
              to: notificationEmail,
              siteName,
              siteUrl,
              adminUrl,
              tagline,
              primaryColor,
              headingFont,
              bodyFont,
              pagesCreated: ['Home', 'About', 'Services', 'Contact', 'Privacy Policy'],
              cloudwaysAppId: newApp.id,
            });
            send('status', { step: 11, message: 'Summary email sent.' });
          } catch (err) {
            // Non-fatal — site is ready, email just failed
            const msg = err instanceof Error ? err.message : String(err);
            send('status', { step: 11, message: `Email failed (${msg}) — site is still ready.` });
          }
        }

        // ----------------------------------------------------------------
        // Done
        // ----------------------------------------------------------------
        send('complete', {
          message: 'Site is ready!',
          siteUrl,
          adminUrl,
          cloudwaysAppId: newApp.id,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send('error', { message, cloudwaysAppId: partialAppId });
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
