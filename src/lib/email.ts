import nodemailer from 'nodemailer';

export interface SiteSummaryParams {
  to: string;
  siteName: string;
  siteUrl: string;
  adminUrl: string;
  tagline: string;
  primaryColor: string;
  headingFont: string;
  bodyFont: string;
  pagesCreated: string[];
  cloudwaysAppId: string;
}

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error('SMTP not configured — set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env.local');
  }

  return nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

export async function sendSiteSummary(params: SiteSummaryParams): Promise<void> {
  const transporter = getTransporter();

  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER!;

  const pageList = params.pagesCreated.map((p) => `<li>${p}</li>`).join('');

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; background: #f9fafb; margin: 0; padding: 32px 16px; }
    .card { background: #fff; border-radius: 12px; border: 1px solid #e5e7eb; max-width: 560px; margin: 0 auto; padding: 32px; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    p.sub { color: #6b7280; font-size: 14px; margin: 0 0 24px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    td { padding: 8px 0; font-size: 14px; vertical-align: top; }
    td:first-child { color: #6b7280; width: 140px; }
    td:last-child { font-weight: 500; }
    .swatch { display: inline-block; width: 14px; height: 14px; border-radius: 3px; vertical-align: middle; margin-right: 6px; border: 1px solid #e5e7eb; }
    .btn { display: inline-block; background: #2563eb; color: #fff !important; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; margin: 4px 4px 4px 0; }
    .btn.secondary { background: #f3f4f6; color: #111 !important; }
    ul { margin: 0; padding-left: 20px; }
    li { font-size: 14px; margin: 3px 0; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
    .note { background: #fef9c3; border: 1px solid #fde047; border-radius: 8px; padding: 12px 16px; font-size: 13px; color: #713f12; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${params.siteName}</h1>
    <p class="sub">${params.tagline || 'Your new WordPress site is ready.'}</p>

    <a href="${params.siteUrl}" class="btn">View Site</a>
    <a href="${params.adminUrl}" class="btn secondary">WP Admin</a>

    <hr>

    <table>
      <tr><td>Site URL</td><td><a href="${params.siteUrl}">${params.siteUrl}</a></td></tr>
      <tr><td>Admin URL</td><td><a href="${params.adminUrl}">${params.adminUrl}</a></td></tr>
      <tr><td>Primary Colour</td><td><span class="swatch" style="background:${params.primaryColor}"></span>${params.primaryColor}</td></tr>
      <tr><td>Heading Font</td><td>${params.headingFont}</td></tr>
      <tr><td>Body Font</td><td>${params.bodyFont}</td></tr>
      <tr><td>Cloudways App ID</td><td>${params.cloudwaysAppId}</td></tr>
    </table>

    <hr>

    <strong style="font-size:14px">Pages created</strong>
    <ul style="margin-top:8px">${pageList}</ul>

    <hr>

    <div class="note">
      <strong>Next steps:</strong> Point your custom domain to the site in Cloudways, enable SSL, then re-enable search engine indexing before launch.
    </div>
  </div>
</body>
</html>`;

  await transporter.sendMail({
    from: `"Site Portal" <${from}>`,
    to: params.to,
    subject: `✅ ${params.siteName} — site ready`,
    html,
    text: `${params.siteName} is ready.\n\nSite: ${params.siteUrl}\nAdmin: ${params.adminUrl}\n\nPages: ${params.pagesCreated.join(', ')}`,
  });
}
