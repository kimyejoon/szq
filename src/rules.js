'use strict';

/** A rules block to paste into AGENTS.md / CLAUDE.md / .cursor/rules for agents that have no hook support. */
function rulesBlock(lang, commands) {
  const list = commands.map((c) => `\`${c}\``).join(', ');
  if (lang === 'ko') {
    return `## 검증 명령 공용 큐 (szq)
- ${list} 및 이를 부르는 \`test\`·\`typecheck\` 스크립트 같은 무거운 검증 명령은 직접 실행하지 않고 \`szq --digest <명령>\`으로 실행한다. 예: \`szq --digest tsc --noEmit\`, \`szq --digest vitest run <파일>\`, \`szq --digest pnpm test\`. \`--digest\`는 긴 출력을 머리·꼬리·오류 줄로 줄이고 전체 로그 경로를 알려 주므로, 더 필요하면 그 파일을 읽는다.
- 같은 머신의 모든 에이전트 세션이 같은 큐를 공유한다. 대기 중이면 순번이 출력되고, 같은 코드 상태의 같은 명령은 결과를 공유(캐시)한다. 강제 재실행은 \`--no-cache\`.
- 변경한 범위만 검증하고, 전체 검증은 커밋 직전에 한 번만 돌린다. 현황은 \`szq status\`.
- 큐를 우회하려고 설정이나 \`DISABLE\` 파일을 건드리지 않는다(사용자 전용).
`;
  }
  return `## Shared queue for verification commands (szq)
- Do not run ${list} (or the \`test\` / \`typecheck\` scripts that call them) directly. Run them as \`szq --digest <command>\`, e.g. \`szq --digest tsc --noEmit\`, \`szq --digest vitest run <file>\`, \`szq --digest pnpm test\`. \`--digest\` keeps long output short (head, tail and error lines) and prints where the full log is; read that file if you need more.
- Every agent session on this machine shares one queue. While waiting you will see your position; an identical command on identical code reuses the previous result. Force a fresh run with \`--no-cache\`.
- Verify only what you changed; run the full suite once, right before committing. Inspect the queue with \`szq status\`.
- Do not edit szq's configuration or create its \`DISABLE\` file to bypass the queue (that switch is for the human).
`;
}

module.exports = { rulesBlock };
