#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../src/config.mjs';

const args = process.argv.slice(2);
if (args.length) {
  console.log('Usage: poki update\nUpdate a clean checkout of its default branch, or show prebuilt package download instructions.');
  process.exit(args.length === 1 && ['--help', '-h'].includes(args[0]) ? 0 : 1);
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('Git could not inspect this checkout. Check that Git is installed and the repository is readable.');
  return result.stdout.trim();
}

// The branch origin names as its default: main upstream, master in this fork. A clone records it as
// origin/HEAD; without one, main.
function defaultBranch() {
  const result = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim().replace(/^origin\//, '') : 'main';
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed. Resolve the error above and run poki update again. The service was not restarted.`);
}

try {
  if (!existsSync(join(root, '.git'))) {
    console.log('Prebuilt Poki package. Download the package for this system from the newest Poki MCP release, tagged vX.Y.Z:\nhttps://github.com/ImSingee/poki-mcp/releases\nExtract it into a new directory, then run npm ci --no-audit --no-fund there.\nIf you use Poki Agent, also run npm ci --prefix agent.\nStop your existing service, and update your MCP client path and shell PATH to that directory; the client starts the service from there (or run npm start there for a long-lived one).\nKeep your existing POKI_MCP_STATE_DIR. The current installation was not changed.');
  } else {
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(root)) throw new Error('Poki must be at the root of its own Git checkout.');
    const branch = defaultBranch();
    if (git('branch', '--show-current') !== branch) throw new Error(`Update stopped: this checkout is not on ${branch}. Switch to ${branch} yourself before updating.`);
    if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Update stopped: this checkout has local changes. Commit or stash them yourself before updating.');
    console.log('Fetching Poki updates...');
    run('git', ['fetch']);
    console.log('Fast-forwarding Poki without overwriting ignored files...');
    run('git', ['merge', '--ff-only', '--no-overwrite-ignore', '@{upstream}']);
    console.log('Building Poki with ./bin/setup...');
    run('./bin/setup', []);
    console.log('Poki updated. A service an MCP client started is replaced on its next call once it is idle. A service you started with npm start (or a user service) keeps the old code: stop it and start it again.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
