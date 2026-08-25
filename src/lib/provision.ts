import { cloneApp, waitForClone, restartNginxAndWait, waitForWordPressReady, listApps } from './cloudways';
import { configureWordPress, setPluginStates, checkPluginUpdates } from './wordpress';
import type { ElementorColor, ElementorTypography, ElementorThemeStyles } from './wordpress';
import { deleteDefaultContent, createStandardPages, configureSiteSettings, createNavMenu } from './wp-setup';
import { sendSiteSummary } from './email';
import { getTemplate, TEMPLATES } from './templates';
import { appendEvent, failJob, finishJob, setPartialAppId, type Job } from './jobs';
import { recordSite } from './registry';
import {
  PHASE,
  attachApp,
  closeCheckpoint,
  createCheckpoint,
  markPhase,
} from './checkpoints';

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
 * A previously-cloned app to continue configuring, instead of cloning a new one.
 */
export interface ResumeContext {
  appId: string;
  siteUrl: string;
  /** Highest phase already completed; everything after it is re-run. */
  fromPhase: number;
  /**
   * Checkpoint row to keep updating. A resume runs under a fresh in-memory job
   * id, but progress must accumulate on the original record so the build can be
   * resumed again if it fails a second time.
   */
  checkpointId: string;
}

/**
 * Run the provisioning pipeline, reporting progress into `job`.
 *
 * With `resume`, the clone phases are skipped and configuration continues on the
 * existing app. Every configuration step is idempotent, so re-running a phase
 * that partially succeeded is safe.
 *
 * Never throws — every outcome is recorded on the job instead, because nothing
 * is awaiting this call.
 */
export async function runCloneJob(
  job: Job,
  params: CloneParams,
  resume?: ResumeContext,
): Promise<void> {
  const step = (n: number) => (message: string) => appendEvent(job, n, message);

  // Phases at or below this have already been done and are skipped.
  const done = resume?.fromPhase ?? 0;
  const shouldRun = (phase: number) => phase > done;

  // Checkpoints accumulate on the original row across resumes.
  const cpId = resume?.checkpointId ?? job.id;

  /** Run a phase, then checkpoint it so a later failure resumes after it. */
  const completed = async (phase: number) => {
    await markPhase(cpId, phase).catch(() => {
      // A checkpoint write failing must not fail the build — it only costs us
      // the ability to resume from this exact point.
    });
  };

  try {
    const template = getTemplate(params.templateId) ?? TEMPLATES[0];

    if (resume) {
      step(0)(`Resuming build for app ${resume.appId} from phase ${done + 1}.`);
    } else {
      await createCheckpoint(job.id, params).catch(() => {});
    }

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

    const appLabel = slugify(params.siteName);
    let appId = resume?.appId ?? '';
    let siteUrl = resume?.siteUrl ?? '';

    // ------------------------------------------------------------------
    // 1. Pre-flight: refuse to clone onto an existing label
    // ------------------------------------------------------------------
    let preExistingIds = new Set<string>();

    if (shouldRun(PHASE.PREFLIGHT)) {
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
      preExistingIds = new Set(existingApps.map((a) => a.id));
      await completed(PHASE.PREFLIGHT);
    }

    // ------------------------------------------------------------------
    // 2. Check plugins on template for available updates
    // ------------------------------------------------------------------
    if (shouldRun(PHASE.PLUGIN_CHECK)) {
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
      await completed(PHASE.PLUGIN_CHECK);
    }

    // ------------------------------------------------------------------
    // 3. Clone
    // ------------------------------------------------------------------
    if (shouldRun(PHASE.CLONE)) {
      step(3)(`Cloning "${template.name}" as "${appLabel}"…`);
      await cloneApp(appLabel, template.appId);
      step(3)('Clone started. Waiting for it to provision…');
      await completed(PHASE.CLONE);
    }

    // ------------------------------------------------------------------
    // 4. Wait for cloned app to appear
    // ------------------------------------------------------------------
    if (shouldRun(PHASE.WAIT_APP)) {
      const newApp = await waitForClone(appLabel, step(4), { excludeAppIds: preExistingIds });
      appId = newApp.id;
      siteUrl = newApp.app_fqdn ? `https://${newApp.app_fqdn}` : `http://${newApp.cname}`;

      setPartialAppId(job, appId);
      // Attach before anything else can fail, so a build that dies during
      // configuration is still resumable rather than orphaning the app.
      await attachApp(cpId, appId, siteUrl).catch(() => {});
      step(4)('Clone complete.');
      await completed(PHASE.WAIT_APP);
    } else {
      setPartialAppId(job, appId);
    }

    const adminUrl = `${siteUrl}/wp-admin`;

    // ------------------------------------------------------------------
    // 5. Restart Nginx, then wait for WordPress itself to be ready
    // ------------------------------------------------------------------
    if (shouldRun(PHASE.SITE_READY)) {
      step(5)('Restarting Nginx…');
      await restartNginxAndWait(siteUrl, step(5));
      await waitForWordPressReady(siteUrl, step(5));
      await completed(PHASE.SITE_READY);
    } else {
      // Even when resuming past this phase, confirm WordPress is actually
      // answering before issuing writes against it.
      await waitForWordPressReady(siteUrl, step(5));
    }

    const wpCreds = {
      baseUrl: siteUrl,
      username: process.env.TEMPLATE_WP_USERNAME!,
      appPassword: process.env.TEMPLATE_WP_APP_PASSWORD!,
    };

    // ------------------------------------------------------------------
    // 6. WordPress: branding (title, logo, Elementor kit)
    // ------------------------------------------------------------------
    if (shouldRun(PHASE.BRANDING)) {
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
      await completed(PHASE.BRANDING);
    }

    // ------------------------------------------------------------------
    // 7. WordPress: cleanup default content
    // ------------------------------------------------------------------
    if (shouldRun(PHASE.CLEANUP)) {
      step(7)('Cleaning up default content…');
      await deleteDefaultContent(wpCreds, step(7));
      await completed(PHASE.CLEANUP);
    }

    // ------------------------------------------------------------------
    // 8. WordPress: create standard pages
    //
    // Always runs, even on a resume past this phase — later phases need the
    // page IDs, and createStandardPages reuses existing pages rather than
    // creating duplicates.
    // ------------------------------------------------------------------
    step(8)('Creating standard pages…');
    const pages = await createStandardPages(wpCreds, step(8));
    await completed(PHASE.PAGES);

    // ------------------------------------------------------------------
    // 9. WordPress: site settings (timezone, front page, comments)
    // ------------------------------------------------------------------
    if (shouldRun(PHASE.SETTINGS)) {
      step(9)('Configuring site settings…');
      await configureSiteSettings(wpCreds, pages.home, step(9));
      await completed(PHASE.SETTINGS);
    }

    // ------------------------------------------------------------------
    // 10. Nav menu + plugin states
    // ------------------------------------------------------------------
    if (shouldRun(PHASE.MENU_PLUGINS)) {
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
      await completed(PHASE.MENU_PLUGINS);
    }

    // ------------------------------------------------------------------
    // 11. Summary email (non-fatal)
    // ------------------------------------------------------------------
    const smtpReady = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    if (shouldRun(PHASE.EMAIL) && smtpReady && params.notificationEmail) {
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
          cloudwaysAppId: appId,
        });
        step(11)('Summary email sent.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        step(11)(`Email failed (${msg}) — site is still ready.`);
      }
    }
    await completed(PHASE.EMAIL);

    // Register the site so the whole team sees it, not just this browser.
    await recordSite({
      appId,
      siteName: params.siteName,
      siteUrl,
      adminUrl,
      templateId: template.id,
      templateName: template.name,
      primaryColor: params.primaryColor,
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      step(11)(`⚠ Could not add to the shared site list (${msg.slice(0, 100)}) — the site itself is fine.`);
    });

    appendEvent(job, 11, 'Site is ready!');
    finishJob(job, { siteUrl, adminUrl, cloudwaysAppId: appId });
    await closeCheckpoint(cpId, 'complete').catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failJob(job, message);
    await closeCheckpoint(cpId, 'error', message).catch(() => {});
  }
}
