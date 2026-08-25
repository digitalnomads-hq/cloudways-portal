import { Client } from 'ssh2';
import fs from 'fs'; // used only when SSH_KEY_PATH is set (local dev)
import net from 'net';

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  privateKey: Buffer;
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

/**
 * Build a WP-CLI command that first `cd`s into the WordPress directory.
 * Cloudways wp-config.php uses relative require('wp-salt.php'), so WP-CLI
 * must run with the WP root as the working directory — --path alone isn't enough.
 */
function wp(wpPath: string, args: string): string {
  return `cd "${wpPath}" && wp ${args} --allow-root`;
}

/** Test raw TCP reachability before attempting SSH handshake. */
function checkTcpReachable(host: string, port: number, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Cannot reach ${host}:${port} — TCP connection timed out. Check SSH_HOST and that the server is reachable from this network.`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Cannot reach ${host}:${port} — ${err.message}`));
    });
  });
}

/** Validate that a private key buffer looks like a PEM key. */
function validatePrivateKey(key: Buffer): void {
  const str = key.toString('utf-8');
  if (!str.includes('-----BEGIN')) {
    throw new Error(
      'SSH_PRIVATE_KEY appears malformed — ensure the full key including the -----BEGIN and -----END lines is pasted into your environment variables.',
    );
  }
}

/** Run a single command over SSH. Returns stdout. Throws on non-zero exit. */
async function runCommand(config: SshConfig, command: string): Promise<string> {
  await checkTcpReachable(config.host, config.port);
  validatePrivateKey(config.privateKey);
  return runCommandInner(config, command);
}

function runCommandInner(config: SshConfig, command: string): Promise<string> {
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
      readyTimeout: 30000,
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
