#!/usr/bin/env node
/**
 * 一条命令发版：检查 → 升版本 + 提交 + 打 tag → 推 GitHub，剩下的交给 CI。
 *   npm run release patch           # 0.3.1 -> 0.3.2
 *   npm run release minor|major
 *   npm run release 0.4.0
 *   npm run release patch -- --dry-run       # 只检查、只打印将执行的命令
 *   npm run release patch -- --local-publish # 兜底：本机直接 npm publish
 *
 * 发布本身走 GitHub Actions 的 OIDC（npm Trusted Publishing），本机不存 npm token。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const bump = positional[0] || 'patch';
const dryRun = flags.has('--dry-run');
const skipRelease = flags.has('--no-release');
const localPublish = flags.has('--local-publish');
const pkgPath = new URL('../package.json', import.meta.url);
const MAIN_BRANCH = 'main';

function run(command, commandArgs) {
  const shown = [command, ...commandArgs].join(' ');
  console.log(dryRun ? '  [dry-run] ' + shown : '  $ ' + shown);
  if (dryRun) return '';
  return execFileSync(command, commandArgs, { encoding: 'utf8', stdio: 'inherit' });
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { encoding: 'utf8' }).trim();
}

function fail(message) {
  console.error('\n✗ ' + message);
  process.exit(1);
}

function nextVersion(current, input) {
  if (/^\d+\.\d+\.\d+/.test(input)) return input;
  const [major, minor, patch] = current.split('.').map((p) => Number.parseInt(p, 10));
  if (input === 'major') return (major + 1) + '.0.0';
  if (input === 'minor') return major + '.' + (minor + 1) + '.0';
  if (input === 'patch') return major + '.' + minor + '.' + (patch + 1);
  fail('版本参数只能是 patch / minor / major / x.y.z，收到：' + input);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = nextVersion(pkg.version, bump);
const tag = 'v' + version;

console.log('发布 ' + pkg.name + ' ' + pkg.version + ' -> ' + version + (dryRun ? '（dry-run）' : ''));

// 1. 仓库状态：干净、main、与远端同步、tag 不冲突
if (git('status', '--porcelain') !== '') fail('工作区不干净，先提交或 stash');
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== MAIN_BRANCH) fail('发布请在 ' + MAIN_BRANCH + ' 上');
if (!dryRun) run('git', ['fetch', 'origin', '--tags']);
if (git('rev-list', '--count', 'origin/' + MAIN_BRANCH + '..HEAD') !== '0') fail('本地领先 origin/' + MAIN_BRANCH + '，先 push');
if (git('rev-list', '--count', 'HEAD..origin/' + MAIN_BRANCH) !== '0') fail('本地落后 origin/' + MAIN_BRANCH + '，先 pull');
if (git('tag', '--list', tag) !== '') fail('tag ' + tag + ' 已存在');

// 2. 本地检查（读操作，dry-run 也真跑）
console.log('  $ npm run check');
execFileSync('npm', ['run', 'check'], { stdio: 'inherit' });

// 3. 版本号 + 提交 + tag
run('npm', ['version', version, '-m', 'chore(release): %s']);

// 4. 推分支和 tag（CI 接手）
run('git', ['push', 'origin', MAIN_BRANCH, '--follow-tags']);

if (localPublish) {
  run('npm', ['publish', '--access', 'public']);           // 需要 ~/.npmrc 里可直发的 token
  if (!skipRelease) run('gh', ['release', 'create', tag, '--title', tag, '--generate-notes', '--verify-tag']);
  process.exit(0);
}

console.log('\n✓ ' + tag + ' 已推送到 GitHub，npm 由 CI 发布');
console.log("  看进度：gh run watch $(gh run list --workflow publish.yml --limit 1 --json databaseId -q '.[0].databaseId')");
console.log('  验证：npm view ' + pkg.name + ' version');
