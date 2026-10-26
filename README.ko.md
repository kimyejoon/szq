# szq

**AI 코딩 에이전트가 계속 돌리는 무거운 명령(tsc·vitest·jest)을 위한 공용 큐, git 상태 기반 결과 캐시, 그리고 가드 훅.**

[![CI](https://github.com/kimyejoon/szq/actions/workflows/ci.yml/badge.svg)](https://github.com/kimyejoon/szq/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) · 한국어

---

노트북 한 대에서 Claude Code / Codex / Cursor 세션을 다섯 개쯤 띄우면, 각 세션이 시간당 수없이
`tsc --noEmit`, `vitest`, `jest`를 실행합니다. 게다가 **같은 코드에 같은 검사를 같은 순간에** 돌리는 경우가
많습니다. 8코어 노트북에서 load average가 50을 넘는 일이 쉽게 벌어지고, 개발 서버는 응답을 못 하고, CPU 시간의
상당수는 중복 작업입니다.

`szq`는 이 문제를 명령 단위에서 해결합니다.

1. **머신당 큐 하나.** 무거운 명령은 동시 실행 수(기본: CPU 코어 수 / 4)가 제한된 FIFO 큐를 거칩니다.
   기다리는 에이전트에게 자기 순번이 보입니다.
2. **같은 요청은 한 번만 실행.** 요청을 *명령 + git 작업 트리*(HEAD, 추적 파일 변경분, 추적 안 된 파일)로 지문화합니다.
   N개 에이전트가 같은 것을 요청하면 하나만 실행하고 나머지는 같은 출력과 종료 코드를 받습니다.
   코드가 그대로라면 다시 호출해도 캐시에서 즉시 돌아옵니다.
3. **속이지 않고 알려 줍니다.** 에이전트용 훅이 `tsc`/`vitest`/`jest` 직접 실행을 막고, 모델에게
   `szq tsc ...`로 다시 실행하라고 안내합니다. 몰래 바꿔치기하지 않으므로 에이전트가 규칙을 배웁니다.

```text
# 예시 (설명용)
$ szq vitest run src/billing
[szq] 대기 2번째 (실행 중 2/2), 경과 14s - 앞: ~/work/app-b: vitest run src/auth
[szq] 차례가 왔습니다(대기 31s).
 ✓ src/billing/invoice.test.ts (12 tests)
[szq] 종료 코드 0 (실행 9s)

$ szq vitest run src/billing          # 바뀐 것 없음
 ✓ src/billing/invoice.test.ts (12 tests)
[szq] 캐시 적중 (14:02:11 결과, 종료 코드 0)
```

> **상태: 0.1.0.** macOS와 Linux에서 동작합니다. Windows는 구현되어 CI에서 테스트되지만 작성자가 실제 Windows
> 장비에서 써 본 것은 아닙니다([플랫폼 지원](#플랫폼-지원)). Gemini CLI 지원은 실험적입니다.

## 설치

```sh
npm install -g szq            # 첫 npm 릴리스 이후
# 소스에서:
git clone https://github.com/kimyejoon/szq.git && cd szq && npm link
```

Node.js 18 이상과 `git`이 필요합니다(git이 없으면 큐는 동작하지만 캐시는 못 씁니다). 의존성은 없습니다.

## 빠른 시작

```sh
# 1. 에이전트 앞에 가드를 둡니다 (설치는 멱등이며 백업을 남깁니다)
szq hook install claude-code
szq hook install codex          # 그다음 Codex 안에서 `/hooks`로 한 번 신뢰해야 합니다
szq hook install cursor

# 2. 점검
szq doctor

# 3. 직접 쓸 때도 똑같이
szq tsc --noEmit
szq vitest run path/to/file.test.ts
szq pnpm --filter api test
szq status                      # 누가 실행 중이고 누가 대기 중인지
```

이제 에이전트가 `tsc --noEmit`을 직접 치면 다음 안내를 받고 `szq`로 다시 실행합니다.

> `[szq] Running 'tsc' directly is blocked on this machine. ... Re-run the same command prefixed with szq, e.g. szq tsc --noEmit ...`

언제든 `szq hook uninstall <agent>`로 제거할 수 있습니다.

## "같은 요청"의 기준

같은 **명령줄**, 저장소 안의 같은 **디렉터리**, 같은 **git 작업 트리**입니다. 즉 `HEAD` + `git diff HEAD` +
추적 안 된(무시되지 않은) 파일 내용에, Node 버전과 `cache.env`에 적은 환경변수 값이 더해집니다.

**포함되지 않는 것**: git이 무시하는 파일(`node_modules`, 생성된 `dist/` 등), 저장소 밖의 파일, 그 밖의 환경.
명령이 이런 것에 의존하면 `--no-cache`를 쓰거나(큐는 그대로 적용) 캐시를 끄세요. 성공 결과는 24시간, 실패 결과는
10분 보관하고, 타임아웃·비정상 종료는 캐시하지 않습니다. 자세한 내용: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 명령

| | |
|---|---|
| `szq [옵션] [--] <명령...>` | 큐를 거쳐 실행. `--cap N`, `--timeout 초`, `--max-wait 초`, `--no-cache`, `--changed[=REF]`(vitest/jest 전용) |
| `szq status` | 실행·대기·합류 중인 작업과 캐시 크기 |
| `szq cache clear` | 캐시 비우기 |
| `szq hook install\|uninstall\|status <agent>` | 에이전트 훅 관리 (`--project`, `--local`, `--dry-run`, `--absolute-node`) |
| `szq shim install\|uninstall\|status` | `tsc`·`vitest`·`jest` 이름의 PATH 런처 — 어떤 에이전트에서도 동작 |
| `szq rules [--lang en\|ko]` | 훅이 없는 에이전트용으로 `AGENTS.md`/`CLAUDE.md`에 붙여 넣을 규칙 블록 출력 |
| `szq config [show\|path\|set <키> <json>]` | 설정 보기·변경 |
| `szq doctor` | 설치 진단 |

종료 코드: 명령 자체의 코드, `64` 사용법 오류, `70` 내부 오류, `75` 대기 시간 초과, `124` 실행 시간 초과, `127` 실행 실패.
입력을 기다리거나 watch 모드로 도는 명령은 지원하지 않습니다(stdin을 닫고 `--watch`는 거부합니다).

## 에이전트 지원

| 에이전트 | 방식 | 상태 |
|---|---|---|
| Claude Code | `PreToolUse` 훅 (사유와 함께 거부) | 공식 문서 기준 검증 |
| OpenAI Codex CLI | `PreToolUse` 훅 (사유와 함께 거부) | 공식 문서 기준 검증 |
| Cursor | `beforeShellExecution` 훅 (거부) | 공식 문서 기준 검증 |
| Gemini CLI | `BeforeTool` 훅 (exit 2) | 실험적 |
| 그 외 | `szq shim install` 또는 `szq rules`를 에이전트 지침에 추가 | 동작 |
| 직접 만들기 | [어댑터](docs/ADAPTERS.md) 작성 (`--adapter-module`) | - |

"공식 문서 기준 검증"은 공개된 훅 프로토콜대로 구현하고 그 규격에 맞춰 단위 테스트했다는 뜻입니다
([docs/ADAPTERS.md](docs/ADAPTERS.md)). 이 가드는 **협조적이지만 게으른 에이전트를 위한 안전벨트이지 보안 경계가
아닙니다** — 작정하면 언제든 우회할 수 있습니다(`eval`, tsc를 부르는 스크립트 등). 훅은 fail-open이라 문제가 생기면
명령을 허용합니다.

## 설정

`szq config path`로 파일 위치를 확인합니다(`~/.config/szq/config.json`, Windows는 `%APPDATA%\szq\config.json`).

```json
{
  "concurrency": "auto",
  "timeoutSec": 900,
  "maxWaitSec": 1800,
  "cache": { "enabled": true, "successTtlHours": 24, "failureTtlMinutes": 10, "maxEntryMB": 4, "env": [] },
  "incremental": { "tsc": false },
  "guard": { "commands": ["tsc", "vitest", "jest"], "scripts": ["test", "typecheck"] },
  "lang": "auto"
}
```

`guard.commands`/`guard.scripts`가 훅이 막을 대상을 정합니다(`pytest`, `eslint`, `check` 등을 추가할 수 있습니다).
환경변수: `SZQ_CONCURRENCY`, `SZQ_HOME`(상태 디렉터리), `SZQ_CONFIG`, `SZQ_LANG`(`en`|`ko`), `SZQ_CACHE_SALT`.
사람용 비상 스위치: 상태 디렉터리에 `DISABLE`이라는 빈 파일을 만들면 훅이 모든 명령을 허용합니다.

## 플랫폼 지원

| | |
|---|---|
| macOS | 테스트됨: 작성자의 주 사용 환경이며 전체 테스트 통과 |
| Linux | CI(`ubuntu-latest`)로 검증 |
| Windows | 구현됨: `PATHEXT` 탐색, `npm`/`pnpm`/`tsc.cmd` 같은 `.cmd`/`.bat` 래퍼를 `cmd.exe`로 실행, `taskkill /T`로 프로세스 트리 종료. `windows-latest` CI로 검증하지만 **작성자가 실제 Windows 장비에서 확인하지는 못했습니다.** `.cmd` 래퍼에는 `"`나 `%`가 들어간 인자를 거부합니다(cmd.exe가 다시 해석하기 때문). `.exe`를 직접 실행하거나 해당 문자를 피하세요. Git Bash가 없는 Windows의 Claude Code는 훅을 PowerShell에서 실행하며, szq의 훅 명령(`node "<경로>" guard ...`)은 양쪽에서 동작합니다. |

## 벤치마크

원 데이터는 [bench/RESULTS.md](bench/RESULTS.md)에 있고, `npm run bench`로 직접 재현할 수 있습니다.
설계상 요약: *N개 에이전트의 같은 명령*은 N번이 아니라 한 번 실행되고, *서로 다른 명령*은 유휴 상태의 머신에서
"한꺼번에 몰아 실행"하는 것보다 벽시계 기준으로는 **늦게** 끝나지만 머신이 계속 반응합니다(큐는 처리량을 내주고
나머지 작업의 지연을 지킵니다). *반복 호출*은 코드가 그대로면 약 0.1초입니다.

## 대안

szq가 이 문제를 처음 다룬 도구는 아닙니다. [tman](https://github.com/standardbeagle/tman)은 프로세스 감독(멈춘 실행
종료, 메모리/CPU 제한), 큐, 폭넓은 에이전트 연동을 제공하고, [tdd-cli](https://github.com/geuben/tdd-cli)는 동시에 도는
테스트 실행들이 코어를 나눠 쓰게 하며, `tsp`/`pueue`는 범용 작업 큐입니다. szq가 더하는 것은 **git 작업 트리 기반 결과 공유**와
**안내하며 거부하는 훅**이고, 의존성 없는 Node 패키지입니다. 솔직한 비교: [docs/ALTERNATIVES.md](docs/ALTERNATIVES.md).

## 보안

상태는 사용자 전용입니다(모드 `0700`, 소유자 검사). git은 저장소가 지정한 헬퍼 실행을 끈 채로 돌고, POSIX에서는 셸을
쓰지 않으며, 훅은 fail-open입니다. 캐시된 출력은 평문으로 저장되므로 **비밀을 출력하는 명령은 캐시를 거치지 마세요**
(`--no-cache`). 전체 위협 모델과 취약점 신고 방법: [SECURITY.md](SECURITY.md).

## 기여

이슈와 PR을 환영합니다. 특히 더 많은 에이전트용 어댑터가 반갑습니다. [CONTRIBUTING.md](CONTRIBUTING.md)를 보세요.

## 라이선스

[MIT](LICENSE) © Kim Yejoon
