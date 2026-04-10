import { Client } from 'ssh2';
import fs from 'fs'; // used only when SSH_KEY_PATH is set (local dev)

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  privateKey: Buffer;
}

export interface PluginUpdateResult {
  updated: string[];
  skipped: string[];  // already up to date
  errors: string[];
  rawOutput: string;
}

/**
 * Resolve the SSH private key from env vars.
 *
 * Two options (in priority order):
 *  1. SSH_PRIVATE_KEY — the key content itself (best for online/cloud hosting
 *     where you paste the key into the platform's env var UI).
 *  2. SSH_KEY_PATH    — path to a key file on disk (convenient for local dev).
 *
 * On Cloudways (and most online hosts) use SSH_PRIVATE_KEY.
 * Paste the full contents of your private key, replacing literal newlines with \n.
 * Most platforms (Cloudways, Railway, Render) handle multi-line env vars natively,
 * so you can usually just paste the key as-is.
 */
function resolvePrivateKey(): Buffer | null {
  const keyContent = process.env.SSH_PRIVATE_KEY;
  if (keyContent) {
    // Platforms sometimes store newlines as literal \n — normalise them
    const normalised = keyContent.replace(/\\n/g, '\n');
    return Buffer.from(normalised, 'utf-8');
  }

  const keyPath = process.env.SSH_KEY_PATH;
  if (keyPath) {
    if (!fs.existsSync(keyPath)) return null; // path set but file missing — treat as unconfigured
    return fs.readFileSync(keyPath);
  }

  return null;
}

function getSshConfig(): SshConfig | null {
  const host = process.env.SSH_HOST;
  const username = process.env.SSH_USER;
  const privateKey = resolvePrivateKey();

  if (!host || !username || !privateKey) return null;

  return {
    host,
    port: parseInt(process.env.SSH_PORT ?? '22', 10),
    username,
    privateKey,
  };
}

/** Returns true if SSH env vars are configured. */
export function isSshConfigured(): boolean {
  return getSshConfig() !== null;
}

/** Run a command over SSH using the configured credentials. */
export async function runSshCommand(command: string): Promise<string> {
  const config = getSshConfig();
  if (!config) throw new Error('SSH not configured');
  return runCommand(config, command);
}

/**
 * Build a WP-CLI command that first `cd`s into the WordPress directory.
 * Cloudways wp-config.php uses relative require('wp-salt.php'), so WP-CLI
 * must run with the WP root as the working directory — --path alone isn't enough.
 */
function wp(wpPath: string, args: string): string {
  return `cd "${wpPath}" && wp ${args} --allow-root`;
}

/** Run a single command over SSH. Returns stdout. Throws on non-zero exit. */
function runCommand(config: SshConfig, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        stream.on('close', (code: number) => {
          conn.end();
          if (code !== 0) {
            reject(new Error(`Command exited with code ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`));
          } else {
            resolve(stdout);
          }
        });

        stream.on('data', (data: Buffer) => { stdout += data.toString(); });
        stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      });
    });

    conn.on('error', reject);

    conn.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
    });
  });
}

/** Test the SSH connection and verify WP-CLI is available. */
export async function testSshConnection(): Promise<{ wpCliVersion: string; pluginsNeedingUpdate: number }> {
  const config = getSshConfig();
  if (!config) throw new Error('SSH not configured');

  const wpCliVersion = (await runCommand(config, 'wp --version --allow-root')).trim();

  const wpPath = process.env.TEMPLATE_WP_PATH;
  if (!wpPath) throw new Error('TEMPLATE_WP_PATH is not set in .env.local');

  const countStr = await runCommand(
    config,
    wp(wpPath, 'plugin list --update=available --format=count'),
  );
  const pluginsNeedingUpdate = parseInt(countStr.trim(), 10) || 0;

  return { wpCliVersion, pluginsNeedingUpdate };
}

/**
 * Run `wp plugin update --all` on the template site via SSH.
 * Returns a summary of what was updated.
 */
export async function updateAllPlugins(
  onProgress?: (msg: string) => void,
): Promise<PluginUpdateResult> {
  const config = getSshConfig();
  if (!config) throw new Error('SSH not configured — set SSH_HOST, SSH_USER, SSH_KEY_PATH in .env.local');

  const wpPath = process.env.TEMPLATE_WP_PATH;
  if (!wpPath) throw new Error('TEMPLATE_WP_PATH is not set in .env.local');

  onProgress?.('Connecting to server via SSH…');

  // First get a count so we can show a useful message
  let pendingCount = 0;
  try {
    const countStr = await runCommand(
      config,
      wp(wpPath, 'plugin list --update=available --format=count'),
    );
    pendingCount = parseInt(countStr.trim(), 10) || 0;
  } catch {
    // Non-fatal — we'll still try to update
  }

  if (pendingCount === 0) {
    onProgress?.('All plugins are already up to date.');
    return { updated: [], skipped: [], errors: [], rawOutput: '' };
  }

  onProgress?.(`Updating ${pendingCount} plugin${pendingCount === 1 ? '' : 's'}…`);

  const rawOutput = await runCommand(
    config,
    wp(wpPath, 'plugin update --all --format=json'),
  );

  // WP-CLI outputs a JSON array of update results when --format=json is used
  let parsed: Array<{ name: string; status: string; old_version: string; new_version: string }> = [];
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    // WP-CLI may print warnings before the JSON; extract just the JSON part
    const jsonMatch = rawOutput.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch { /* ignore */ }
    }
  }

  const updated = parsed.filter((r) => r.status === 'Updated').map((r) => `${r.name} (${r.old_version} → ${r.new_version})`);
  const skipped = parsed.filter((r) => r.status === 'Skipped').map((r) => r.name);
  const errors  = parsed.filter((r) => r.status === 'Error').map((r) => r.name);

  onProgress?.(
    updated.length > 0
      ? `Updated: ${updated.join(', ')}`
      : 'No plugins were updated.',
  );

  return { updated, skipped, errors, rawOutput };
}

// ---------------------------------------------------------------------------
// New-site setup commands (run against the cloned app, not the template)
// ---------------------------------------------------------------------------

/**
 * Derive the WordPress path for a cloned app from its sys_user.
 * Cloudways stores apps at /home/{server_id}.cloudwaysapps.com/{sys_user}/public_html
 */
export function clonedWpPath(sysUser: string): string {
  const serverId = process.env.CLOUDWAYS_SERVER_ID!;
  return `/home/${serverId}.cloudwaysapps.com/${sysUser}/public_html`;
}

/** Set permalink structure to /%postname%/ and flush rewrite rules. */
export async function setPermalinkStructure(
  wpPath: string,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const config = getSshConfig();
  if (!config) throw new Error('SSH not configured');

  onProgress?.('Setting permalink structure to /%postname%/…');
  await runCommand(config, wp(wpPath, `rewrite structure '/%postname%/' --hard`));
  onProgress?.('  Permalink structure updated');
}

/** Set blog_public=0 to discourage search engine indexing during development. */
export async function discourageSearchIndexing(
  wpPath: string,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const config = getSshConfig();
  if (!config) throw new Error('SSH not configured');

  onProgress?.('Discouraging search engine indexing…');
  await runCommand(config, wp(wpPath, 'option update blog_public 0'));
  onProgress?.('  Search indexing discouraged (remember to re-enable before launch)');
}

/**
 * Create a "Primary Menu", add standard pages to it, and assign it to the
 * first registered nav menu location (usually 'primary' or 'main').
 */
export async function createNavMenu(
  wpPath: string,
  pages: { title: string; id: number }[],
  onProgress?: (msg: string) => void,
): Promise<void> {
  const config = getSshConfig();
  if (!config) throw new Error('SSH not configured');

  onProgress?.('Creating navigation menu…');

  const menuId = (await runCommand(config, wp(wpPath, 'menu create "Primary Menu" --porcelain'))).trim();

  for (const page of pages) {
    await runCommand(config, wp(wpPath, `menu item add-post ${menuId} ${page.id} --title="${page.title}"`));
    onProgress?.(`  Added "${page.title}" to menu`);
  }

  try {
    const locationsJson = await runCommand(config, wp(wpPath, 'menu location list --format=json'));
    const locations: Array<{ location: string }> = JSON.parse(locationsJson);
    if (locations.length > 0) {
      const slug = locations[0].location;
      await runCommand(config, wp(wpPath, `menu location assign primary-menu ${slug}`));
      onProgress?.(`  Assigned to menu location: ${slug}`);
    }
  } catch {
    onProgress?.('  Could not auto-assign menu location — assign manually in WordPress');
  }
}
