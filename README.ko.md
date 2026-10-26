# szq

**AI 코딩 에이전트가 계속 돌리는 무거운 명령(tsc·vitest·jest)을 위한 공용 큐, git 상태 기반 결과 캐시, 그리고 가드 훅.**

[![CI](https://github.com/kimyejoon/szq/actions/workflows/ci.yml/badge.svg)](https://github.com/kimyejoon/szq/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) · 한국어

---

<div align="center">

# szq

### AI 에이전트는 병렬로. 무거운 검사는 똑똑하게.

**Stop running the same check eight times.**

여러 AI 코딩 에이전트가 실행하는 `tsc`, `vitest`, `jest` 같은 검사를<br>
**하나의 머신 공용 큐에서 조율하고, 중복 실행을 합치고, 결과를 재사용하세요.**

[![CI](https://github.com/kimyejoon/szq/actions/workflows/ci.yml/badge.svg)](https://github.com/kimyejoon/szq/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](package.json)
[![Version](https://img.shields.io/badge/version-0.1.0-555.svg)](CHANGELOG.md)

[English](README.md) · **한국어**

[빠른 시작](#-빠른-시작) · [왜 szq인가요?](#-왜-szq인가요) · [벤치마크](#-벤치마크) · [명령어](#-명령어) · [기여하기](#-기여하기)

</div>

---

## ⚡ 문제는 에이전트가 많다는 게 아닙니다. 같은 일을 반복한다는 겁니다.

Claude Code, Codex, Cursor를 여러 세션에서 동시에 돌리는 개발 환경을 생각해 보세요.

서로 다른 에이전트들이 같은 저장소에서 `tsc --noEmit`을 실행하고, 같은 테스트를 돌리고, 수천 줄의 로그를 읽습니다. CPU가 몰리면 개발 서버는 느려지고, 결과를 기다리는 시간과 에이전트 컨텍스트까지 낭비됩니다.

```text
WITHOUT szq                          WITH szq

Agent A ── tsc ─────┐                Agent A ──┐
Agent B ── tsc ─────┤                Agent B ──┼── szq ── tsc (1회)
Agent C ── tsc ─────┼── CPU 경합      Agent C ──┘           │
Agent D ── tsc ─────┘                          └── 결과 공유 + 캐시

각자 실행하고 각자 출력 읽기         필요한 검사만 실행하고 짧게 전달
```

**szq는 AI 코딩 에이전트를 더 많이 실행하기 위한 도구가 아니라, 여러 에이전트가 한 머신의 자원을 더 효율적으로 공유하기 위한 도구입니다.**

## ✨ 무엇이 달라지나요?

| 기능 | szq의 접근 방식 |
|---|---|
| 🚦 **머신 공용 실행 큐** | 여러 프로젝트·에이전트에서 요청한 무거운 명령을 한곳에서 조율합니다. CPU 여유에 따라 동시 실행 수를 조절하고, 사람이 직접 실행한 작업을 우선합니다. |
| 🔁 **중복 실행 합치기** | 명령·디렉터리·Git 작업 트리 내용이 같다면 동시에 들어온 요청을 한 번만 실행하고 결과와 종료 코드를 공유합니다. |
| ⚡ **작업 트리 기반 캐시** | 코드가 바뀌지 않았다면 완료한 검사의 결과를 재사용합니다. `szq explain`으로 캐시 미스의 이유도 확인할 수 있습니다. |
| 🧠 **에이전트 친화적 로그** | `--digest`가 핵심 오류·출력 앞뒤만 보여 줍니다. 전체 로그는 파일로 보존합니다. |
| 🛡️ **에이전트 가드 훅** | 지원 에이전트가 직접 `tsc`·`vitest`·`jest`를 실행하려 하면 이유를 안내하고 `szq --digest` 사용을 유도합니다. |
| 🔍 **상태와 절감량 확인** | `szq status`, `szq stats`, `szq doctor`로 대기열·캐시·설치를 확인합니다. |

> **설계 철학:** 에이전트의 동작을 몰래 바꾸지 않습니다. 가드 훅은 직접 실행을 *안내와 함께 거부*하며, 보안 경계가 아닌 협조적 에이전트를 위한 안전장치입니다.

## 📊 숫자로 보는 szq

M1 Pro에서 측정한 공개 벤치마크 중 일부입니다. **모든 환경에서 같은 결과를 보장하지 않습니다.**

| 시나리오 | 비교 결과 |
|---|---:|
| 동일 TypeScript 검사 8건 동시 요청, tman 0.7.10 대비 | **5.01배 빠름** (22.32초 → 4.46초) |
| 준비 실행 후 동일 검사 8회 순차 반복, tman 대비 | **51.11배 빠름** (30.23초 → 0.59초) |
| 2,502줄 출력, 오류 1개인 사례 | **약 97% 적은 출력 토큰** (약 8,968 → 280) |
| 같은 명령 8건 동시 요청, 자체 실험 | **8회 실행 → 1회 실행** |

**트레이드오프도 있습니다.** 서로 다른 명령 8개는 큐 때문에 한꺼번에 실행할 때보다 더 오래 걸릴 수 있습니다. szq의 목표는 무조건 최단 완료 시간이 아니라 **중복 작업 감소와 개발 머신의 반응성**입니다.

측정 환경·방법·원자료: [tman 직접 비교](bench/TMAN.md) · [성능 분석](docs/PERFORMANCE.md) · [원시 결과](bench/RESULTS.md)

## 🚀 빠른 시작

### 1. 설치

Node.js **18 이상**이 필요합니다. `git` 없이도 큐는 동작하지만 작업 트리 기반 캐시는 사용할 수 없습니다. 런타임 외부 패키지 의존성은 없습니다.

```bash
# 현재는 소스에서 설치
git clone https://github.com/kimyejoon/szq.git
cd szq
npm link
```

> npm 패키지 배포 후에는 `npm install -g szq`로 설치할 수 있도록 준비되어 있습니다. 최초 배포 여부는 [npm 패키지 페이지](https://www.npmjs.com/package/szq)에서 확인하세요.

### 2. 사용하는 AI 에이전트에 연결

```bash
szq hook install claude-code
szq hook install codex
szq hook install cursor

szq doctor
```

Codex는 설치 후 Codex 내부에서 `/hooks`를 통해 훅을 한 번 신뢰해야 합니다. Windsurf, GitHub Copilot CLI, Gemini CLI(실험적) 및 그 밖의 연동 방식은 [에이전트 지원](#-에이전트-지원)을 참고하세요.

### 3. 평소처럼 명령 실행

```bash
szq --digest tsc --noEmit
szq --digest vitest run src/billing
szq jest --runInBand
szq pnpm --filter api test

szq status   # 지금 누가 실행 중이고 대기 중인지
szq stats    # 캐시와 공유 실행으로 얼마나 아꼈는지
```

설치된 훅을 통해 에이전트가 `tsc`를 직접 실행하려 하면, `szq --digest tsc --noEmit`로 다시 실행하라는 안내를 받습니다. 훅은 `szq hook uninstall <agent>`로 제거할 수 있습니다.

## 💻 실제 사용 모습

아래는 동작 방식을 보여 주는 **설명용 예시**입니다.

```console
$ szq --digest vitest run src/billing
[szq] 대기 2번째 (실행 중 2/2), 경과 14s
[szq] 차례가 왔습니다(대기 31s).
 FAIL  src/billing/invoice.test.ts > rounds totals
   AssertionError: expected 10.01 to be 10
 ...
[szq] digest: showing 58 of 1843 lines. Full output: ~/.local/state/szq/logs/...
[szq] 종료 코드 1 (실행 9s)

$ szq --digest vitest run src/billing
[szq] 캐시 적중 (이전 실패 결과 재사용, 종료 코드 1)

$ szq explain -- vitest run src/billing
마지막 실행과 다른 이유:
  - modified 1 file(s): src/billing/invoice.ts
```

**중요:** `--digest`는 출력만 요약합니다. 테스트 결과와 종료 코드를 성공으로 바꾸지 않으며, 원본 로그는 `szq logs`로 볼 수 있습니다. digest 사용 시 stdout·stderr는 하나로 합쳐집니다.

## 🧩 캐시는 언제 안전하게 재사용되나요?

szq는 **명령줄 + 저장소 내부 실행 디렉터리 + Git 작업 트리 내용**을 바탕으로 동일 요청을 판단합니다. 추적 파일, 무시되지 않은 미추적 파일, 초기화된 서브모듈, Node 버전 및 지정한 환경변수(`cache.env`)를 고려합니다.

기본 캐시 보관 시간은 **성공 24시간 / 실패 10분**입니다. 타임아웃, 비정상 종료, 실행 중 작업 트리가 바뀐 결과는 캐시하지 않습니다.

**캐시가 알 수 없는 것도 있습니다.** Git이 무시한 파일(예: `node_modules`), 저장소 밖의 파일, 선언하지 않은 환경변수는 기본 지문에 포함되지 않습니다. 이런 입력에 의존하는 명령은 `--no-cache`를 사용하거나 `cache.extraFiles` 및 `cache.env`로 명시해야 합니다.

```bash
szq --no-cache pnpm test            # 캐시 없이 큐만 사용
szq explain -- tsc --noEmit         # 왜 캐시가 적중/미스될지 확인
szq cache clear                     # 캐시 삭제
```

자세한 구현과 경계 조건은 [아키텍처 문서](docs/ARCHITECTURE.md)를 참고하세요.

## 🧰 명령어

| 명령 | 설명 |
|---|---|
| `szq [옵션] [--] <명령...>` | 큐에서 명령 실행 |
| `szq status [--json]` | 실행·대기·공유 중인 작업과 캐시 현황 |
| `szq stats [--days N] [--json]` | 실행·캐시·중복 제거 절감 통계 |
| `szq explain [--] <명령...>` | 캐시 판정과 변경 파일 설명 |
| `szq logs [show [N]\|path]` | 보관된 원본 출력 확인 |
| `szq cache clear` | 캐시 비우기 |
| `szq hook install\|uninstall\|status <agent>` | 에이전트 훅 설치·관리 |
| `szq shim install\|uninstall\|status` | PATH 기반 명령 런처 설치·관리 |
| `szq rules [--lang en\|ko]` | 에이전트 지침에 추가할 규칙 출력 |
| `szq config [show\|path\|set <키> <json>]` | 설정 조회·변경 |
| `szq doctor` | 설치 상태 진단 |

주요 실행 옵션: `--cap N`, `--timeout 초`, `--stall 초`, `--max-mem MB`(POSIX), `--max-wait 초`, `--exclusive`, `--priority high|normal|low`, `--digest`, `--no-digest`, `--no-cache`, `--changed[=REF]`(vitest/jest 전용).

명령 자체의 종료 코드를 유지하며, szq 오류 코드는 `64`(사용법), `70`(내부 오류), `75`(대기 초과), `124`(실행 초과), `125`(멈춤), `126`(메모리 한도), `127`(실행 실패)입니다. **대화형 stdin·watch 모드는 지원하지 않습니다.**

`--digest`는 stdout이 터미널이 아니면서 에이전트 환경(`CLAUDECODE`, `SZQ_AGENT`)이 감지될 때 기본 적용됩니다. 일반 파이프 출력은 변경하지 않습니다.

## 🤖 에이전트 지원

| 에이전트 | 연동 방식 | 검증 범위 |
|---|---|---|
| Claude Code | `PreToolUse` | 문서 규격 및 단위 테스트 |
| OpenAI Codex CLI | `PreToolUse` | 문서 규격 및 단위 테스트 |
| Cursor | `beforeShellExecution` | 문서 규격 및 단위 테스트 |
| Windsurf (Devin Desktop) | `pre_run_command` | 문서 규격 및 단위 테스트 |
| GitHub Copilot CLI | `preToolUse` | 문서 규격 및 단위 테스트 |
| Gemini CLI | `BeforeTool` | **실험적** |
| 기타 | `szq shim install` 또는 `szq rules` | 환경에 따라 구성 |
| 커스텀 에이전트 | [어댑터](docs/ADAPTERS.md) | 직접 구현 가능 |

여기서 ‘검증’은 각 에이전트의 공개 훅 프로토콜에 맞춰 구현하고 해당 규격을 테스트했다는 의미이며, 실제 모든 버전·환경에서의 동작을 보장하는 표현은 아닙니다. 훅은 **fail-open**이며 우회할 수 있으므로 보안 격리 수단으로 사용하지 마세요.

## ⚙️ 설정과 제어

```bash
szq config path
szq config show
szq config set concurrency 2
```

설정은 기본적으로 `~/.config/szq/config.json`(Windows: `%APPDATA%\szq\config.json`)에 저장됩니다. `concurrency: "auto"`는 CPU 코어 수의 약 1/4에서 시작해 여유가 있으면 늘리며, 외부 부하가 높으면 실효 동시 실행 수를 1로 줄입니다(Windows의 부하 적응 제외).

대표 설정으로 `concurrency`, `maxConcurrency`, `headroom`, `adaptive`, `timeoutSec`, `maxWaitSec`, `output.digest`, `cache.successTtlHours`, `cache.failureTtlMinutes`, `cache.env`, `cache.extraFiles`, `guard.commands`, `guard.scripts`가 있습니다.

환경변수: `SZQ_CONCURRENCY`, `SZQ_HOME`, `SZQ_CONFIG`, `SZQ_LANG`, `SZQ_CACHE_SALT`, `SZQ_AGENT=1`. 훅을 긴급 비활성화해야 한다면 상태 디렉터리에 빈 `DISABLE` 파일을 만들 수 있습니다.

## 🖥️ 플랫폼 지원

| 플랫폼 | 상태 |
|---|---|
| macOS | 작성자의 주 개발 환경에서 테스트 |
| Linux | `ubuntu-latest` CI 검증 |
| Windows | `windows-latest` CI 검증. **실제 Windows 장비 수동 확인은 아직 수행하지 않음** |

Windows는 `.cmd`·`.bat` 실행 및 프로세스 트리 종료를 구현했지만 POSIX용 메모리 상한과 부하 적응 기능은 없습니다. `.cmd` 래퍼에서 따옴표·`%` 인자에 제한이 있고, 비정상 종료 시 남은 자식 프로세스 정리에 제약이 있습니다. [원본 README의 플랫폼 설명](https://github.com/kimyejoon/szq/blob/main/README.ko.md)과 [보안 문서](SECURITY.md)에서 세부 조건을 확인하세요.

## 🔬 tman과 무엇이 다른가요?

[**tman**](https://github.com/standardbeagle/tman)은 프로세스 감독과 자원 제한 면에서 더 성숙한 대안입니다. szq는 특히 **동일 코드 검사 요청을 합쳐 결과를 재사용하고, 에이전트가 읽는 출력을 줄이는 경험**에 집중합니다.

| 선택 기준 | 고려할 도구 |
|---|---|
| 중복 검사 제거·Git 작업 트리 캐시·캐시 미스 설명·출력 요약 | **szq** |
| 더 폭넓은 프로세스 감독·강한 리소스 제한·폭넓은 에이전트 지원 | **tman** |

이 비교는 2026년 10월 공개 문서와 tman 0.7.10을 기준으로 합니다. 둘을 함께 사용할 수도 있습니다. 다른 대안과 자세한 비교: [docs/ALTERNATIVES.md](docs/ALTERNATIVES.md) · [bench/TMAN.md](bench/TMAN.md).

## 🔒 보안과 한계

szq는 상태 디렉터리의 소유권과 접근 권한을 확인하고, Git 작업 트리 해시를 계산할 때 저장소가 지정한 외부 diff 헬퍼를 실행하지 않습니다. POSIX에서는 명령 실행에 셸을 사용하지 않고, 확인 가능한 프로세스 그룹만 종료하도록 설계했습니다.

**캐시된 출력은 평문으로 저장됩니다.** 비밀정보를 출력하는 명령에는 `--no-cache`를 적용하세요. 훅은 보안 장벽이 아니며, 지원 플랫폼별 프로세스 제어에도 제약이 있습니다. 위협 모델과 취약점 신고 방법은 [SECURITY.md](SECURITY.md), 변경 이력은 [CHANGELOG.md](CHANGELOG.md)를 참고하세요.

## 🤝 기여하기

szq는 아직 **v0.1.0**입니다. 실제 여러 에이전트를 함께 쓰는 개발자의 경험과 피드백이 프로젝트를 발전시킵니다.

새로운 에이전트 어댑터, Windows 실기기 검증, 재현 가능한 벤치마크, 버그 리포트, 문서 개선을 환영합니다.

[이슈 열기](https://github.com/kimyejoon/szq/issues) · [기여 가이드](CONTRIBUTING.md) · [변경 이력](CHANGELOG.md)

이 프로젝트가 유용했다면 ⭐ Star로 알려 주세요. 어떤 부분을 개선하면 좋을지 Issue와 PR로 이야기해 주세요.

## 📄 라이선스

[MIT](LICENSE) © Kim Yejoon

