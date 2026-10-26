# szq

**AI 코딩 에이전트가 계속 돌리는 무거운 명령(tsc·vitest·jest)을 위한 공용 큐, git 상태 기반 결과 캐시, 그리고 가드 훅.**

[![CI](https://github.com/kimyejoon/szq/actions/workflows/ci.yml/badge.svg)](https://github.com/kimyejoon/szq/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) · 한국어

---

노트북 한 대에서 Claude Code / Codex / Cursor 세션을 다섯 개쯤 띄우면, 각 세션이 시간당 수없이
`tsc --noEmit`, `vitest`, `jest`를 실행합니다. 게다가 **같은 코드에 같은 검사를 같은 순간에** 돌리는 경우가
많습니다. 8코어 노트북에서 load average가 50을 넘는 일이 쉽게 벌어지고, 개발 서버는 응답을 못 하고, CPU 시간의
상당수는 중복 작업이며, 매번 수천 줄의 출력이 에이전트의 컨텍스트를 채웁니다.

`szq`는 이 문제를 명령 단위에서 해결합니다.

1. **머신당 큐 하나.** 무거운 명령은 FIFO 큐를 거칩니다. CPU 코어 수 / 4개로 시작해 CPU에 여유가 있으면 더 늘리고,
   큐 밖의 다른 이유로 머신이 바쁘면 1개로 줄입니다. 기다리는 에이전트에게 순번이 보이고, 사람이 터미널에서 직접 친
   명령이 먼저 실행됩니다.
2. **같은 요청은 한 번만 실행.** 요청을 *명령 + git 작업 트리의 내용*으로 지문화합니다. N개 에이전트가 같은 것을
   요청하면 하나만 실행하고 나머지는 같은 출력과 종료 코드를 받습니다. 코드가 그대로라면 다시 호출해도 캐시에서
   즉시 돌아오고, `szq explain`이 캐시 미스의 이유를 알려 줍니다.
3. **속이지 않고 알려 줍니다.** 에이전트용 훅이 `tsc`/`vitest`/`jest` 직접 실행을 막고, 모델에게
   `szq --digest ...`로 다시 실행하라고 안내합니다. 몰래 바꿔치기하지 않으므로 에이전트가 규칙을 배웁니다.
4. **에이전트가 덜 읽습니다.** `--digest`는 수천 줄의 출력을 머리·꼬리·오류 줄로 줄이고 전체 로그의 위치를 알려
   줍니다. 중요한 정보는 그대로 두고 벤치마크에서 컨텍스트를 약 97% 줄였습니다.

```text
# 예시 (설명용)
$ szq --digest vitest run src/billing
[szq] 대기 2번째 (실행 중 2/2), 경과 14s - 앞: ~/work/app-b: vitest run src/auth
[szq] 차례가 왔습니다(대기 31s).
 FAIL  src/billing/invoice.test.ts > rounds totals
   AssertionError: expected 10.01 to be 10
 ...
[szq] digest: showing 58 of 1843 lines (head, tail and error lines). Full output: ~/.local/state/szq/logs/20261026-140211-3ac5.log
[szq] 종료 코드 1 (실행 9s)

$ szq --digest vitest run src/billing          # 바뀐 것 없음: 즉시, 같은 출력, 같은 종료 코드
[szq] 캐시 적중 (14:02:11 결과, 종료 코드 1 - 실패 결과는 10분만 재사용 ...)

$ szq explain -- vitest run src/billing
마지막 실행과 다른 이유:
  - modified 1 file(s): src/billing/invoice.ts
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
szq hook install cursor         # 그 밖에: windsurf, copilot, gemini(실험적)

# 2. 점검
szq doctor

# 3. 직접 쓸 때도 똑같이
szq tsc --noEmit
szq vitest run path/to/file.test.ts
szq pnpm --filter api test
szq status                      # 누가 실행 중이고 누가 대기 중인지
szq stats                       # 캐시와 공유로 아낀 작업량
```

이제 에이전트가 `tsc --noEmit`을 직접 치면 다음 안내를 받고 `szq --digest`로 다시 실행합니다.

> `[szq] Running 'tsc' directly is blocked on this machine. ... Re-run the same command prefixed with szq --digest, e.g. szq --digest tsc --noEmit ...`

언제든 `szq hook uninstall <agent>`로 제거할 수 있습니다.

## "같은 요청"의 기준

같은 **명령줄**, 저장소 안의 같은 **디렉터리**, 같은 **작업 트리 내용**입니다. 추적 파일 전부(디스크에 있는 그대로,
삭제된 파일 포함), 무시되지 않은 추적 안 된 파일 전부, 초기화된 서브모듈, 그리고 Node 버전과 `cache.env`에 적은
환경변수 값입니다. szq가 파일을 직접 읽어 해시하고 git에게 내용 비교를 시키지 않으므로, 저장소가 정의한 필터나 diff
헬퍼는 실행되지 않습니다.

**포함되지 않는 것**: git이 무시하는 파일(`node_modules`, 생성된 `dist/` 등), 저장소 밖의 파일, 그 밖의 환경.
명령이 이런 것에 의존하면 `--no-cache`를 쓰거나(큐는 그대로 적용), `cache.extraFiles`에 그 파일을 적거나
(예: `node_modules/.modules.yaml`), 캐시를 끄세요. 성공 결과는 24시간, 실패 결과는 10분 보관하고, 타임아웃·비정상
종료·실행 중에 트리가 바뀐 경우는 캐시하지 않습니다. 자세한 내용: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 명령

| | |
|---|---|
| `szq [옵션] [--] <명령...>` | 큐를 거쳐 실행 (옵션은 아래) |
| `szq status [--json]` | 실행·대기·합류 중인 작업과 캐시 크기 |
| `szq explain [--] <명령...>` | 캐시에서 제공될까? 아니라면 마지막 실행 이후 어떤 파일이 바뀌었나? |
| `szq logs [show [N]\|path]` | 최근 실행의 전체 원본 출력 |
| `szq stats [--days N] [--json]` | 실행·캐시 적중·공유 실행 수와 아낀 작업량 |
| `szq cache clear` | 캐시 비우기 |
| `szq hook install\|uninstall\|status <agent>` | 에이전트 훅 관리 (`--project`, `--local`, `--dry-run`, `--absolute-node`) |
| `szq shim install\|uninstall\|status` | `tsc`·`vitest`·`jest` 이름의 PATH 런처 — 어떤 에이전트에서도 동작 |
| `szq rules [--lang en\|ko]` | 훅이 없는 에이전트용으로 `AGENTS.md`/`CLAUDE.md`에 붙여 넣을 규칙 블록 출력 |
| `szq config [show\|path\|set <키> <json>]` | 설정 보기·변경 |
| `szq doctor` | 설치 진단 |

실행 옵션: `--cap N`, `--timeout 초`, `--stall 초`(출력이 없는 실행 종료), `--max-mem MB`(POSIX), `--max-wait 초`,
`--exclusive`(혼자 실행), `--priority high|normal|low`, `--digest` / `--no-digest`, `--no-cache`,
`--changed[=REF]`(vitest/jest 전용).

종료 코드: 명령 자체의 코드, `64` 사용법 오류, `70` 내부 오류, `75` 대기 시간 초과, `124` 실행 시간 초과, `125` 멈춤,
`126` 메모리 한도, `127` 실행 실패. 입력을 기다리거나 watch 모드로 도는 명령은 지원하지 않습니다(stdin을 닫고
실제 watch 옵션은 거부합니다).

`--digest`는 stdout이 터미널이 아니고 **에이전트 환경이 감지될 때**(`CLAUDECODE` 또는 `SZQ_AGENT`) 기본으로 켜집니다.
일반 파이프(`szq tsc | grep error`)는 절대 바꾸지 않습니다. digest 모드에서는 stdout과 stderr가 하나로 합쳐지고,
전체 출력은 항상 보관됩니다(`szq logs`).

## 에이전트 지원

| 에이전트 | 방식 | 상태 |
|---|---|---|
| Claude Code | `PreToolUse` 훅 (사유와 함께 거부) | 공식 문서 기준 검증 |
| OpenAI Codex CLI | `PreToolUse` 훅 (사유와 함께 거부) | 공식 문서 기준 검증 |
| Cursor | `beforeShellExecution` 훅 (거부) | 공식 문서 기준 검증 |
| Windsurf (Devin Desktop) | `pre_run_command` 훅 (exit 2) | 공식 문서 기준 검증 |
| GitHub Copilot CLI | `preToolUse` 훅 (거부, 항상 exit 0) | 공식 문서 기준 검증 |
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
  "maxConcurrency": "auto",
  "headroom": { "enabled": true, "cpuBelow": 0.55, "settleMs": 800 },
  "timeoutSec": 900,
  "maxWaitSec": 1800,
  "stallSec": 0,
  "maxMemMB": 0,
  "adaptive": { "enabled": true, "loadPerCpu": 1.5 },
  "output": { "digest": "auto", "maxLines": 200, "head": 15, "tail": 40 },
  "logs": { "keep": 50 },
  "cache": { "enabled": true, "successTtlHours": 24, "failureTtlMinutes": 10, "maxEntryMB": 4, "env": [], "extraFiles": [] },
  "incremental": { "tsc": false },
  "guard": { "commands": ["tsc", "vitest", "jest"], "scripts": ["test", "typecheck"] },
  "lang": "auto"
}
```

`concurrency: "auto"`는 CPU 코어 수 / 4로 시작해, 최근 CPU 사용률이 `headroom.cpuBelow`보다 낮은 동안 더 많은 실행을
받아들입니다(`maxConcurrency`까지, 기본은 CPU의 75%). 숫자를 쓰면 고정됩니다. `guard.commands`/`guard.scripts`가 훅이 막을 대상을 정합니다(`pytest`, `eslint`, `check` 등을 추가할 수 있습니다).
`adaptive`는 1분 load average가 `loadPerCpu` × CPU 수를 넘는 동안 실효 동시 실행 수를 1로 낮춥니다(Windows에서는
사용 불가). 환경변수: `SZQ_CONCURRENCY`, `SZQ_HOME`(상태 디렉터리), `SZQ_CONFIG`, `SZQ_LANG`(`en`|`ko`),
`SZQ_CACHE_SALT`, `SZQ_AGENT=1`(이 셸을 에이전트로 취급). 사람용 비상 스위치: 상태 디렉터리에 `DISABLE`이라는 빈 파일을
만들면 훅이 모든 명령을 허용합니다.

## 플랫폼 지원

| | |
|---|---|
| macOS | 테스트됨: 작성자의 주 사용 환경이며 전체 테스트 통과 |
| Linux | CI(`ubuntu-latest`)로 검증 |
| Windows | 구현됨: `PATHEXT` 탐색, `npm`/`pnpm`/`tsc.cmd` 같은 `.cmd`/`.bat` 래퍼를 `cmd.exe`로 실행, `taskkill /T`로 프로세스 트리 종료. `windows-latest` CI로 검증하지만 **작성자가 실제 Windows 장비에서 확인하지는 못했습니다.** `.cmd` 래퍼에는 `"`나 `%`가 들어간 인자를 거부합니다(cmd.exe가 다시 해석하기 때문). `.exe`를 직접 실행하거나 해당 문자를 피하세요. 메모리 한도와 부하 적응은 없고, 비정상 종료한 szq가 남긴 자식 프로세스는 정리하지 않습니다(Windows는 PID가 너무 빨리 재사용되어 기록된 PID로 안전하게 종료할 수 없습니다). |

## 벤치마크

**tman 0.7.10 릴리스 바이너리**와 동시 실행 수를 맞추고 모든 호출의 결과를 검증한 직접 비교는
[bench/TMAN.md](bench/TMAN.md)에 있습니다. `npm run bench:tman -- --tman /absolute/path/to/tman`으로 재현합니다.

M1 Pro에서 요청 8개, 양쪽 동시 실행 상한 2개, 3회 중앙값입니다.

| 시나리오 | tman | szq | 속도 비율 |
|---|---:|---:|---:|
| 서로 다른 약 2 CPU초 작업 8개 | 13.09초 | 9.20초 | 1.42배 |
| 같은 TypeScript 검사 8개 동시 요청 | 22.32초 | 4.46초 | 5.01배 |
| 준비 실행 후 같은 TypeScript 검사 8회 순차 반복 | 30.23초 | 0.59초 | 51.11배 |

모든 호출이 올바른 성공 결과를 받았습니다. macOS의 tman 0.7.10과 고정 동시성으로 비교한 결과이며,
보고서에 옵션·측정 범위·배경 부하·원자료와 준비 실행에서 제외한 비용을 함께 기록했습니다.

방법, 프로파일, 개선 전후 숫자는 [docs/PERFORMANCE.md](docs/PERFORMANCE.md)에, 원 데이터는
[bench/RESULTS.md](bench/RESULTS.md)에 있고 `npm run bench`로 재현합니다. 다른 작업으로 바쁜 Apple M1 Pro(8코어)에서
"에이전트" 8개를 동시에 돌린 결과입니다.

| 시나리오 | szq 없이 | szq 사용 |
|---|---|---|
| 8개 에이전트가 같은 코드에 **같은** 명령 실행 | 실행 8번, CPU 18초, CPU 100%, 2.7~3.0초 | **실행 1번, CPU 2초**, CPU 43~56%, **2.2초** |
| 8개 에이전트가 같은 코드에 실제 `tsc --noEmit` 실행(생성한 프로젝트) | 8.3~9.6초 | **2.9~3.2초** |
| 8개 에이전트가 8개의 **서로 다른** 명령 실행 | 한꺼번에 2.7초 | 큐 처리: 여유 있는 머신에서 **8.5초**, 다른 작업으로 바쁠 때 17초 — **더 느림** |
| 바뀌지 않은 코드에서 같은 명령 반복 | 매번 실행 | 첫 호출만 실행, 나머지는 **약 0.07초** |
| 에이전트가 읽어야 하는 출력(2,502줄, 오류 1개) | 약 8,968 토큰 | `--digest`: 약 280 토큰, 오류 줄 유지 |

큐는 **처리량을 내주고 반응성을 얻는 거래**입니다. 유휴 머신에서는 서로 다른 명령이 한꺼번에 몰아 돌릴 때보다 늦게
끝나지만 머신이 계속 쓸 만하고 중복 작업이 사라집니다. CPU가 감당할 만큼만 시작하고, 머신이 바쁘면 1개로 줄입니다.
속도를 더 원하면 `concurrency`를 올리세요. 숫자는 한 대의 노트북에서 한 시점에 잰 것이니 직접 측정해 보세요.

## tman 등과의 비교

szq가 이 문제를 처음 다룬 도구는 아닙니다. 특히 [tman](https://github.com/standardbeagle/tman)은 겹치는 부분이 많고
프로세스 감독에서는 더 성숙합니다. 각 프로젝트의 공개 README(2026년 10월) 기준 비교입니다.

| | szq | [tman](https://github.com/standardbeagle/tman) |
|---|---|---|
| 동시 실행 수가 제한된 머신 공용 큐 | 예 (CPU/4로 시작, CPU 여유에 따라 증가) | 이름 있는 큐는 코어·메모리 기준, 명령별 슬롯은 기본 2개 |
| 같은 요청 처리 | **기다렸다가 결과 공유**, 작업 트리 내용 기준 캐시 | 이름 기준으로(디렉터리별) 중복 실행 거부, 결과 재사용은 언급 없음 |
| 캐시 미스 이유 | `szq explain` | 언급 없음 |
| 에이전트용 출력 | `--digest`(머리·꼬리·오류를 인라인으로 + 전체 로그 경로) | 실행 로그와 실패 요약(파일) |
| 멈추거나 폭주하는 실행 | 타임아웃, 멈춤·메모리 한도(선택, POSIX) | 실행 시간, 멈춤(기본 30분), CPU·메모리 정리, Linux/Windows 커널 강제 한도 |
| 다른 이유로 머신이 바쁠 때 물러나기 | 예 (load average 기반) | 예, 이름 있는 큐의 입장 판정에 외부 부하 반영(0.7.10) |
| 사람 우선순위, `--exclusive` | 예, 예 | 배타 실행 언급 |
| 절감 리포트 | `szq stats` | 언급 없음 |
| 에이전트 연동 | 안내하며 거부: Claude Code, Codex, Cursor, Windsurf, Copilot CLI(+Gemini 실험적), PATH 심, 규칙 블록 | Claude Code·Codex·Gemini CLI·opencode·Cursor·Antigravity·Kimi Code CLI·Copilot CLI용 재작성/차단 훅, 그 외는 심 |
| 구현 | Node 18+, 의존성 없음, 약 3,300줄 | C# / .NET NativeAOT 단일 바이너리 |
| 플랫폼 | macOS/Linux 검증, Windows 베타 | Linux·macOS·Windows 바이너리 |

하드 리소스 한도나 멈춤 감지 같은 감독이 필요하거나 지금 더 넓은 에이전트 지원이 필요하면 tman을 고르세요. 문제가
**중복 작업과 컨텍스트 비용**(여러 에이전트가 같은 검사를 요청하고 출력이 긴 경우)이라면 szq가 맞습니다. 둘은 함께 쓸 수도
있습니다. 그 밖의 도구([tdd-cli](https://github.com/geuben/tdd-cli), `tsp`/`pueue`, `flock`, Turborepo/Nx 캐시)는
[docs/ALTERNATIVES.md](docs/ALTERNATIVES.md)를 보세요.

## 보안

상태는 사용자 전용입니다(모드 `0700`, 소유자 검사, 심볼릭 링크 거부). szq는 git이 저장소가 정의한 헬퍼를 실행하게
두지 않고(파일 목록만 받고 해시는 직접 계산), POSIX에서 셸을 쓰지 않으며, 확실히 식별되는 프로세스 그룹만 종료하고, 훅은
fail-open입니다. 캐시된 출력은 평문으로 저장되므로 **비밀을 출력하는 명령은 캐시를 거치지 마세요**(`--no-cache`).
코드는 공개 전에 독립적인 적대적 검토를 두 차례 거쳤고 발견 사항과 수정은 [CHANGELOG.md](CHANGELOG.md)에 있습니다. 전체 위협
모델과 취약점 신고 방법: [SECURITY.md](SECURITY.md).

## 기여

이슈와 PR을 환영합니다. 특히 더 많은 에이전트용 어댑터가 반갑습니다. [CONTRIBUTING.md](CONTRIBUTING.md)를 보세요.

## 라이선스

[MIT](LICENSE) © Kim Yejoon
