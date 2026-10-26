'use strict';

// Messages printed by the CLI itself (to stderr). Hook messages for agents stay English.
const en = {
  watchUnsupported: 'watch mode is not supported through the queue. Use a one-shot command (e.g. `vitest run`).',
  noCommand: 'No command given. See `szq --help`.',
  cacheHit: 'cache hit',
  cacheHitWaited: 'reused the result of an identical run that finished while waiting',
  reusedAt: '({time}, exit code {code})',
  failNote:
    ' - failed results are reused for {minutes} min and invalidated automatically when the code changes (force a re-run with --no-cache)',
  waitLine: 'waiting #{pos} ({running}/{cap} running), {elapsed} elapsed{who}',
  waitAhead: ' - ahead: {who}',
  followLine: 'an identical run (pid {pid}, {where}) is ahead; sharing its result when it finishes - {elapsed} elapsed',
  turnCame: 'your turn (waited {elapsed}).',
  waitTimeout: 'gave up waiting after {elapsed}. Check `szq status` for a stuck queue.',
  execTimeout: 'run exceeded {elapsed}; terminating it.',
  exited: 'exit code {code} (ran {elapsed})',
  spawnFailed: 'failed to start: {msg}',
  cmdRejected: 'refusing to start a .cmd/.bat shim with an argument containing {chars} (cmd.exe injection risk). Run the .exe directly or avoid those characters.',
  internal: 'internal error: {msg}',
  stateUnsafe: 'unsafe state directory {dir}: {why}',
  statusHead: 'running {running}/{cap} | waiting {waiting}{joined} | load {load}',
  statusJoined: ' | joined {n}',
  statusRunning: 'running',
  statusWaiting: 'waiting',
  statusJoinedLabel: 'joined',
  statusCache: 'cache entries: {n}',
  statusDisable: 'WARNING: a DISABLE file exists, so guard hooks allow direct runs',
  cacheCleared: 'removed {n} cache entries.',
  usageConfig: 'usage: szq config [show|path|set <key> <json-value>]',
  configSet: '{key} = {value}',
  ruleHeader: 'Rules block for AGENTS.md / CLAUDE.md:',
};

const ko = {
  watchUnsupported: 'watch 모드는 큐에서 지원하지 않습니다. 한 번 실행하는 명령(예: vitest run)을 쓰세요.',
  noCommand: '실행할 명령이 없습니다. `szq --help`를 보세요.',
  cacheHit: '캐시 적중',
  cacheHitWaited: '대기 중 끝난 동일 작업의 결과를 재사용',
  reusedAt: '({time} 결과, 종료 코드 {code})',
  failNote: ' - 실패 결과는 {minutes}분만 재사용하며 코드가 바뀌면 자동으로 다시 실행됩니다(강제 재실행: --no-cache)',
  waitLine: '대기 {pos}번째 (실행 중 {running}/{cap}), 경과 {elapsed}{who}',
  waitAhead: ' - 앞: {who}',
  followLine: '같은 작업(pid {pid}, {where})이 앞서 있어 끝나면 결과를 공유합니다 - 경과 {elapsed}',
  turnCame: '차례가 왔습니다(대기 {elapsed}).',
  waitTimeout: '{elapsed} 동안 기다렸지만 포기합니다. `szq status`로 큐가 막혔는지 확인하세요.',
  execTimeout: '실행 시간이 {elapsed}을 넘어 작업을 종료합니다.',
  exited: '종료 코드 {code} (실행 {elapsed})',
  spawnFailed: '실행하지 못했습니다: {msg}',
  cmdRejected: '{chars} 문자가 들어 있는 인자로 .cmd/.bat 래퍼를 실행하지 않습니다(cmd.exe 인젝션 위험). .exe를 직접 실행하거나 해당 문자를 피하세요.',
  internal: '내부 오류: {msg}',
  stateUnsafe: '안전하지 않은 상태 디렉터리 {dir}: {why}',
  statusHead: '실행 {running}/{cap} | 대기 {waiting}{joined} | load {load}',
  statusJoined: ' | 합류 {n}',
  statusRunning: '실행',
  statusWaiting: '대기',
  statusJoinedLabel: '합류',
  statusCache: '캐시 {n}건',
  statusDisable: '경고: DISABLE 파일이 있어 훅이 직접 실행을 허용하고 있습니다',
  cacheCleared: '캐시 {n}건을 지웠습니다.',
  usageConfig: '사용: szq config [show|path|set <키> <JSON 값>]',
  configSet: '{key} = {value}',
  ruleHeader: 'AGENTS.md / CLAUDE.md 에 넣을 규칙 블록:',
};

const tables = { en, ko };
let current = 'en';

function detectLang(env = process.env, cfgLang = 'auto') {
  const pick = (v) => (typeof v === 'string' && /^ko/i.test(v) ? 'ko' : typeof v === 'string' && /^en/i.test(v) ? 'en' : null);
  if (cfgLang && cfgLang !== 'auto') return pick(cfgLang) || 'en';
  return pick(env.SZQ_LANG) || pick(env.LC_ALL) || pick(env.LC_MESSAGES) || pick(env.LANG) || 'en';
}

function setLang(lang) {
  current = tables[lang] ? lang : 'en';
}

function t(key, vars = {}) {
  const table = tables[current] || en;
  const raw = table[key] || en[key] || key;
  return raw.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
}

module.exports = { t, setLang, detectLang, tables };
