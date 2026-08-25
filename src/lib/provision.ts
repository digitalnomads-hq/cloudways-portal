import { cloneApp, waitForClone, restartNginxAndWait, waitForWordPressReady, listApps } from './cloudways';
import { configureWordPress, setPluginStates, checkPluginUpdates } from './wordpress';
import type { ElementorColor, ElementorTypography, ElementorThemeStyles } from './wordpress';
import { deleteDefaultContent, createStandardPages, configureSiteSettings, createNavMenu } from './wp-setup';
import { sendSiteSummary } from './email';
import { getTemplate, TEMPLATES } from './templates';
import { appendEvent, failJob, finishJob, setPartialAppId, type Job } from './jobs';

export interface CloneParams {
  templateId: string;
  siteName: string;
  tagline: string;
  notificationEmail: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  textColor: string;
  headingFont: string;
  bodyFont: string;
  logo: { buffer: Buffer; filename: string; mimeType: string } | null;
  favicon: { buffer: Buffer; filename: string; mimeType: string } | null;
  pluginStates: Record<string, boolean>;
  themeStyles?: ElementorThemeStyles;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/**
 * Run the full provisioning pipeline, reporting progress into `job`.
 *
 * Never throws — every outcome is recorded on the job instead, because nothing
 * is awaiting this call.
 */
export async function runCloneJob(job: Job, params: CloneParams): Promise<void> {
  const step = (n: number) => (message: string) => appendEvent(job, n, message);

  try {
    const template = getTemplate(params.templateId) ?? TEMPLATES[0];

    const colors: ElementorColor[] = [
      { _id: 'primary',   title: 'Primary',   color: params.primaryColor },
      { _id: 'secondary', title: 'Secondary', color: params.secondaryColor },
      { _id: 'accent',    title: 'Accent',    color: params.accentColor },
      { _id: 'text',      title: 'Text',      color: params.textColor },
    ];

    const typography: ElementorTypography[] = [
      { _id: 'primary',   title: 'Primary',   typography_typography: 'custom', typography_font_family: params.headingFont, typography_font_weight: '600' },
      { _id: 'secondary', title: 'Secondary', typography_typography: 'custom', typography_font_family: params.headingFont, typography_font_weight: '400' },
      { _id: 'text',      title: 'Text',      typography_typography: 'custom', typography_font_family: params.bodyFont,    typography_font_weight: '400' },
      { _id: 'accent',    title: 'Accent',    typography_typography: 'custom', typography_font_family: params.bodyFont,    typography_font_weight: '500' },
    ];

    // ------------------------------------------------------------------
    // 1. Pre-flight: refuse to clone onto an existing label
    // ------------------------------------------------------------------
    const appLabel = slugify(params.siteName);
    step(1)('Checking for existing apps with this name…');

    const existingApps = await listApps();
    const collision = existingApps.find((a) => a.label === appLabel);
    if (collision) {
      throw new Error(
        `An app labelled "${appLabel}" already exists on this server (ID ${collision.id}). ` +
        `Delete it or choose a different site name — continuing would reconfigure the existing site.`,
      );
    }
    // Snapshot so the poll below can only ever match a genuinely new app.
    const preExistingIds = new Set(existingApps.map((a) => a.id));

    // ------------------------------------------------------------------
    // 2. Check plugins on template for available updates
    // ------------------------------------------------------------------
    if (template.wpUrl) {
      const templateCreds = {
        baseUrl: template.wpUrl,
        username: process.env.TEMPLATE_WP_USERNAME!,
        appPassword: process.env.TEMPLATE_WP_APP_PASSWORD!,
      };
      await checkPluginUpdates(templateCreds, step(2));
    } else {
      step(2)('Template URL not set — skipping plugin check.');
    }

    // ------------------------------------------------------------------
    // 3. Clone
    // ------------------------------------------------------------------
    step(3)(`Cloning "${template.name}" as "${appLabel}"…`);
    await cloneApp(appLabel, template.appId);
    step(3)('Clone started. Waiting for it to provision…');

    // ------------------------------------------------------------------
    // 4. Wait for cloned app to appear
    // ------------------------------------------------------------------
    const newApp = await waitForClone(appLabel, step(4), { excludeAppIds: preExistingIds });
    setPartialAppId(job, newApp.id);
    step(4)('Clone complete.');

    const siteUrl = newApp.app_fqdn ? `https://${newApp.app_fqdn}` : `http://${newApp.cname}`;
    const adminUrl = `${siteUrl}/wp-admin`;

    // ------------------------------------------------------------------
    // 5. Restart Nginx, then wait for WordPress itself to be ready
    // ------------------------------------------------------------------
    step(5)('Restarting Nginx…');
    await restartNginxAndWait(siteUrl, step(5));
    await waitForWordPressReady(siteUrl, step(5));

    const wpCreds = {
      baseUrl: siteUrl,
      username: process.env.TEMPLATE_WP_USERNAME!,
      appPassword: process.env.TEMPLATE_WP_APP_PASSWORD!,
    };

    // ------------------------------------------------------------------
    // 6. WordPress: branding (title, logo, Elementor kit)
    // ------------------------------------------------------------------
    step(6)('Configuring branding…');
    try {
      await configureWordPress(
        wpCreds,
        {
          title: params.siteName,
          tagline: params.tagline,
          logoBuffer: params.logo?.buffer ?? null,
          logoFilename: params.logo?.filename ?? '',
          logoMimeType: params.logo?.mimeType ?? '',
          faviconBuffer: params.favicon?.buffer ?? null,
          faviconFilename: params.favicon?.filename ?? '',
          faviconMimeType: params.favicon?.mimeType ?? '',
          colors,
          typography,
          themeStyles: params.themeStyles,
        },
        step(6),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Elementor')) {
        step(6)(`⚠ Elementor globals not set (${msg.slice(0, 120)}) — set colours/fonts manually in Elementor → Site Settings.`);
      } else {
        throw err;
      }
    }

    // ------------------------------------------------------------------
    // 7. WordPress: cleanup default content
    // ------------------------------------------------------------------
    step(7)('Cleaning up default content…');
    await deleteDefaultContent(wpCreds, step(7));

    // ------------------------------------------------------------------
    // 8. WordPress: create standard pages
    // ------------------------------------------------------------------
    step(8)('Creating standard pages…');
    const pages = await createStandardPages(wpCreds, step(8));

    // ------------------------------------------------------------------
    // 9. WordPress: site settings (timezone, front page, comments)
    // ------------------------------------------------------------------
    step(9)('Configuring site settings…');
    await configureSiteSettings(wpCreds, pages.home, step(9));

    // ------------------------------------------------------------------
    // 10. Nav menu + plugin states
    // ------------------------------------------------------------------
    step(10)('Setting up navigation menu…');
    await createNavMenu(
      wpCreds,
      [
        { title: 'Home',     id: pages.home },
        { title: 'About',    id: pages.about },
        { title: 'Services', id: pages.services },
        { title: 'Contact',  id: pages.contact },
      ],
      step(10),
    );

    if (Object.keys(params.pluginStates).length > 0) {
      step(10)('Configuring plugins…');
      await setPluginStates(wpCreds, params.pluginStates, step(10));
    }

    // ------------------------------------------------------------------
    // 11. Summary email (non-fatal)
    // ------------------------------------------------------------------
    const smtpReady = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    if (smtpReady && params.notificationEmail) {
      step(11)(`Sending summary email to ${params.notificationEmail}…`);
      try {
        await sendSiteSummary({
          to: params.notificationEmail,
          siteName: params.siteName,
          siteUrl,
          adminUrl,
          tagline: params.tagline,
          primaryColor: params.primaryColor,
          headingFont: params.headingFont,
          bodyFont: params.bodyFont,
          pagesCreated: ['Home', 'About', 'Services', 'Contact', 'Privacy Policy'],
          cloudwaysAppId: newApp.id,
        });
        step(11)('Summary email sent.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        step(11)(`Email failed (${msg}) — site is still ready.`);
      }
    }

    appendEvent(job, 11, 'Site is ready!');
    finishJob(job, { siteUrl, adminUrl, cloudwaysAppId: newApp.id });
  } catch (err) {
    failJob(job, err instanceof Error ? err.message : String(err));
  }
}
