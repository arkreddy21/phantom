import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryDirectories: string[] = [];
let builtServerEntrypoint: string;

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function isolatedDirectory() {
  const tempRoot = '/tmp/opencode';
  mkdirSync(tempRoot, { recursive: true });
  const directory = mkdtempSync(join(tempRoot, 'phantom-startup-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

beforeAll(() => {
  const buildRoot = isolatedDirectory();
  const outputDirectory = join(buildRoot, 'dist');
  symlinkSync(join(projectRoot, 'node_modules'), join(buildRoot, 'node_modules'), 'dir');
  execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.server.json', '--outDir', join(outputDirectory, 'server')], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
  execFileSync('pnpm', ['exec', 'vite', 'build', '--outDir', join(outputDirectory, 'client')], {
    cwd: projectRoot,
    stdio: 'pipe',
    env: {
      ...process.env,
      AUTH_USERNAME: '',
      AUTH_PASSWORD: '',
      PUBLIC_ORIGIN: '',
      NODE_ENV: 'production',
      PORT: '3001',
      DATA_DIR: join(buildRoot, 'build-data'),
    },
  });
  builtServerEntrypoint = join(outputDirectory, 'server/server/index.js');
}, 120_000);

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => server.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolveListen()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function childEnvironment(directory: string, port: number) {
  const env = { ...process.env };
  for (const key of ['AUTH_USERNAME', 'AUTH_PASSWORD', 'AUTH_TRUST_PROXY', 'PUBLIC_ORIGIN', 'NODE_ENV', 'HOST', 'PORT', 'DATA_DIR']) delete env[key];
  env.PORT = String(port);
  env.DATA_DIR = join(directory, 'data');
  env.HOST = '127.0.0.1';
  return env;
}

function launch(entrypoint: 'dev' | 'start', directory: string, port: number, extraEnv: NodeJS.ProcessEnv = {}) {
  const env = { ...childEnvironment(directory, port), ...extraEnv };
  const executable = entrypoint === 'dev'
    ? join(projectRoot, 'node_modules/.bin/tsx')
    : process.execPath;
  const args = entrypoint === 'dev'
    ? [join(projectRoot, 'server/index.ts')]
    : [builtServerEntrypoint, '--production'];
  if (entrypoint === 'start') env.NODE_ENV = 'production';
  const child = spawn(executable, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  return { child, get output() { return output; } };
}

function waitForServer(child: ChildProcess, output: () => string, timeoutMs = 20_000) {
  return new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Server did not start: ${output()}`)), timeoutMs);
    const onOutput = () => {
      if (output().includes('Persona server listening')) finish();
    };
    const onExit = (code: number | null) => finish(new Error(`Server exited with ${code}: ${output()}`));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout?.off('data', onOutput);
      child.stderr?.off('data', onOutput);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolveReady();
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.once('exit', onExit);
    onOutput();
  });
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolveStop) => child.once('exit', () => resolveStop()));
}

async function expectSuccessfulStartup(entrypoint: 'dev' | 'start', options: { exportedCredentials?: boolean; envFile?: boolean } = {}) {
  const directory = isolatedDirectory();
  const port = await unusedPort();
  const envUsername = 'startup-env-owner';
  const envPassword = 'startup-env-password-unique';
  const fileUsername = options.exportedCredentials ? 'file-owner' : envUsername;
  const filePassword = options.exportedCredentials ? 'file-password-unique' : envPassword;
  if (options.envFile !== false) {
    writeFileSync(join(directory, '.env'), `AUTH_USERNAME=${fileUsername}\nAUTH_PASSWORD=${filePassword}\n`);
  }
  const child = launch(entrypoint, directory, port, options.exportedCredentials ? {
    AUTH_USERNAME: 'exported-owner',
    AUTH_PASSWORD: 'exported-password-unique',
  } : {});
  try {
    await waitForServer(child.child, () => child.output);
    if (entrypoint === 'start') {
      const favicon = await fetch(`http://127.0.0.1:${port}/icons/icon-192.png`);
      expect(favicon.status).toBe(200);
      expect(favicon.headers.get('content-type')).toContain('image/png');
    }
    const credentials = options.exportedCredentials
      ? { username: 'exported-owner', password: 'exported-password-unique' }
      : { username: envUsername, password: envPassword };
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials),
    });
    expect(login.status).toBe(200);
    expect(child.output).not.toContain(envPassword);
    expect(child.output).not.toContain('exported-password-unique');
  } finally {
    await stop(child.child);
  }
}

describe('server startup environment loading', () => {
  it('loads root .env values in dev without sourcing the file manually', async () => {
    await expectSuccessfulStartup('dev');
  });

  it('loads root .env values for the built production start', async () => {
    await expectSuccessfulStartup('start');
  });

  it('keeps exported credentials ahead of root .env values in the built start', async () => {
    await expectSuccessfulStartup('start', { exportedCredentials: true });
  });

  it('starts with exported credentials when the optional .env file is missing', async () => {
    await expectSuccessfulStartup('dev', { exportedCredentials: true, envFile: false });
  });

  it('keeps exported environment credentials ahead of root .env values', async () => {
    await expectSuccessfulStartup('dev', { exportedCredentials: true });
  });

  it('still fails for missing required credentials and does not disclose secrets', async () => {
    const directory = isolatedDirectory();
    const child = launch('dev', directory, await unusedPort());
    let output = '';
    child.child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit) => child.child.once('exit', resolveExit));
    expect(exitCode).not.toBe(0);
    expect(output).toContain('AUTH_USERNAME and AUTH_PASSWORD must both be configured');
    expect(output).not.toContain('startup-env-password-unique');
  });

  it('reports invalid configured values instead of silently ignoring .env', async () => {
    const directory = isolatedDirectory();
    writeFileSync(join(directory, '.env'), 'AUTH_USERNAME=invalid-config-owner\nAUTH_PASSWORD=invalid-config-password\nAUTH_TRUST_PROXY=2\n');
    const child = launch('dev', directory, await unusedPort());
    let output = '';
    child.child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit) => child.child.once('exit', resolveExit));
    expect(exitCode).not.toBe(0);
    expect(output).toContain('AUTH_TRUST_PROXY must be exactly 1 or 0 when set');
    expect(output).not.toContain('invalid-config-password');
  });
});
