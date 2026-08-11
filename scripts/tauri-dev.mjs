#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(scriptPath), '..');
const DEFAULT_DEV_PORT = 1420;
const MAX_PORT_ATTEMPTS = 100;
const tauriCliPath = path.join(rootDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const tauriTargetDir = path.join(rootDir, 'src-tauri', 'target');
const tauriTargetWorkspaceMarker = path.join(tauriTargetDir, '.cobble-workspace-root');

const readTextFile = async (filePath) => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

const findCachedWorkspaceRoot = async () => {
  const buildDir = path.join(tauriTargetDir, 'debug', 'build');
  let entries;
  try {
    entries = await fs.readdir(buildDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('cobble-')) continue;
    const output = await readTextFile(path.join(buildDir, entry.name, 'output'));
    const match = output?.match(/cargo:rerun-if-changed=(.+)\/src-tauri\/tauri(?:\.macos)?\.conf\.json/);
    if (match?.[1]) return path.resolve(match[1]);
  }
  return null;
};

export const prepareTauriTarget = async () => {
  const recordedRoot = (await readTextFile(tauriTargetWorkspaceMarker))?.trim() || null;
  const cachedRoot = recordedRoot ?? await findCachedWorkspaceRoot();
  if (cachedRoot && path.resolve(cachedRoot) !== rootDir) {
    console.log(`Tauri build cache belongs to ${cachedRoot}. Rebuilding it for ${rootDir}.`);
    await fs.rm(tauriTargetDir, { recursive: true, force: true });
  }
  await fs.mkdir(tauriTargetDir, { recursive: true });
  await fs.writeFile(tauriTargetWorkspaceMarker, `${rootDir}\n`, 'utf8');
};

const portHasListener = (port, host) =>
  new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const finish = (inUse) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(inUse);
    };

    socket.setTimeout(300);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', (error) => finish(error.code !== 'ECONNREFUSED'));
  });

const isPortInUse = async (port) => {
  const [ipv4InUse, ipv6InUse] = await Promise.all([
    portHasListener(port, '127.0.0.1'),
    portHasListener(port, '::1'),
  ]);
  return ipv4InUse || ipv6InUse;
};

const findAvailablePort = async (startPort) => {
  for (let port = startPort; port < startPort + MAX_PORT_ATTEMPTS; port++) {
    if (!(await isPortInUse(port))) return port;
  }
  throw new Error(`No free port found in range ${startPort}-${startPort + MAX_PORT_ATTEMPTS - 1}`);
};

const runTauriCli = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tauriCliPath, ...args], {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 0);
    });
  });

const main = async () => {
  const [subcommand, ...restArgs] = process.argv.slice(2);

  if (subcommand !== 'dev') {
    const code = await runTauriCli(process.argv.slice(2));
    process.exitCode = code;
    return;
  }

  await prepareTauriTarget();
  const port = await findAvailablePort(DEFAULT_DEV_PORT);
  const devUrl = `http://localhost:${port}`;
  const beforeDevCommand = `node scripts/vite-dev.mjs --port ${port}`;
  const configPatch = JSON.stringify({
    build: {
      devUrl,
      beforeDevCommand,
    },
  });

  if (port !== DEFAULT_DEV_PORT) {
    console.log(`Port ${DEFAULT_DEV_PORT} is in use — using ${port} for this dev session.`);
  }

  const code = await runTauriCli(['dev', '--config', configPatch, ...restArgs]);
  process.exitCode = code;
};

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
