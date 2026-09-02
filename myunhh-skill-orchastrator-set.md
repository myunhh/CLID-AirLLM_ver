# myunhh Codex Skill & Orchestrator Set

이 문서는 현재 PC에 구성한 Codex 중심 개발 하네스를 다른 Windows PC 또는 새 Codex 환경에 동일하게 재현하기 위한 단일 소스 설치 명세다.

> 파일명 `orchastrator`는 요청한 이름을 그대로 사용했다. 구성요소의 정식 이름은 `budgeted-graph-orchestrator`다.

## 1. 목표

모든 비단순 작업을 다음 방식으로 수행한다.

1. Main Orchestrator가 작업을 S/M/L/XL로 분류한다.
2. 프로젝트 지식 그래프가 있으면 Graphify로 영향 범위를 조회한다.
3. Main Orchestrator가 인간에게 진행 단계를 제안하고 승인을 기다린다.
4. 승인된 단계를 비순환 실행 그래프(DAG)와 bounded Task Capsule로 분해한다.
5. cycle, 누락 dependency 및 병렬 writer 소유권 충돌을 실행 전에 거부한다.
6. dependency가 모두 끝난 ready node만 병렬 실행하고 명시적 join으로 다음 단계에 전달한다.
7. 각 task node는 실행 → 독립 검증 → 성공/제한 재시도/escalation의 bounded loop로 동작한다.
8. Main Orchestrator만 결과를 통합하고 작업하지 않은 독립 Judge가 결정론적 검증을 수행한다.
9. 실행 DAG는 Mermaid로 시각화하며 Graphify project graph에는 runtime event를 섞지 않는다.
10. 인간이 최종 수용 및 push/merge/publish 같은 외부 행동을 승인한다.

모델의 실제 context window 크기를 에이전트마다 줄이는 기능은 사용하지 않는다. 대신 전달 대화 최소화, Task Capsule, 도구 호출 예산, 재시도 제한, 파일 소유권, worktree 격리 및 강제 중단으로 컨텍스트 오염과 범위 이탈을 제어한다.

## 2. 기준 버전

현재 검증된 조합:

| 구성요소 | 버전 |
|---|---:|
| Codex CLI | `0.150.1` |
| LazyCodex/OmO | `4.19.4` |
| Graphify | `0.9.50` |
| Budgeted Graph Orchestrator | `0.1.0` |
| Python | `3.12` 권장 |
| Node.js | 유지보수 중인 LTS |

## 3. 설치되는 구성요소

- `grill-me`와 실제 동작 본체 `grilling`
- `graphify`
- LazyCodex/OmO
- 개인 플러그인 `budgeted-graph-orchestrator`
- 전역 에이전트 역할:
  - `budget_explorer`
  - `budget_worker`
  - `budget_integrator`
  - `budget_judge`
- 전역 `AGENTS.md` 오케스트레이션 정책

## 4. 보안 및 백업 원칙

다음 파일은 절대 백업 저장소나 이식 패키지에 포함하지 않는다.

- `auth.json`
- credentials 및 API key
- `.env`
- 세션·대화 기록
- 인증서와 `.pem` 개인키
- 로그와 SQLite 런타임 DB

설치 전 다음 파일을 백업한다.

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$codexHome = Join-Path $env:USERPROFILE '.codex'
Copy-Item "$codexHome\config.toml" "$codexHome\config.toml.pre-orchestrator-$stamp.bak"
Copy-Item "$codexHome\AGENTS.md" "$codexHome\AGENTS.md.pre-orchestrator-$stamp.bak"
```

## 5. 사전 요구사항

```powershell
codex --version
node --version
npm --version
py -3.12 --version
git --version
```

Codex에 로그인되어 있어야 한다. 설치 명령은 자율 권한을 활성화하지 않는다.

## 6. 필수 스킬 설치

### 6.1 grill-me 및 grilling

`grill-me`는 `grilling`을 호출하는 라우터이므로 두 개를 함께 설치한다.

```powershell
$codexHome = Join-Path $env:USERPROFILE '.codex'
$installer = Join-Path $codexHome 'skills\.system\skill-installer\scripts\install-skill-from-github.py'
$env:CODEX_HOME = $codexHome
py -3.12 $installer `
  --repo mattpocock/skills `
  --path skills/productivity/grill-me skills/productivity/grilling
```

검증:

```powershell
Test-Path "$env:USERPROFILE\.codex\skills\grill-me\SKILL.md"
Test-Path "$env:USERPROFILE\.codex\skills\grilling\SKILL.md"
```

### 6.2 Graphify

Graphify CLI와 Codex 스킬은 이 하네스가 전역으로 설치·복구하는 도구다. 반면 지식 그래프는 **대상 프로젝트마다** 그 프로젝트 루트의 `graphify-out/`에 생성·갱신한다. 전역 하네스에 하나의 공유 그래프를 만들거나 다른 프로젝트의 그래프를 재사용하지 않는다.

```powershell
py -3.12 -m pip install --user "graphifyy==0.9.50"

$graphifyScripts = Join-Path $env:APPDATA 'Python\Python312\Scripts'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($userPath -split ';' | Where-Object { $_ })
if ($parts -notcontains $graphifyScripts) {
  [Environment]::SetEnvironmentVariable('Path', (($parts + $graphifyScripts) -join ';'), 'User')
}
$env:Path = "$env:Path;$graphifyScripts"

py -3.12 -m graphify install --platform codex
```

그래프를 쓸 대상 프로젝트의 루트에서만 Graphify의 Codex 지침을 적용하려면:

```powershell
Set-Location <PROJECT_ROOT>
py -3.12 -m graphify codex install
```

이 명령은 **해당 프로젝트의** `AGENTS.md`와 `.codex/hooks.json`을 추가 또는 갱신할 수 있으므로 diff를 확인한다. 이후에도 그래프 조회와 `graphify update .`는 항상 그 프로젝트 루트에서 실행한다.

검증:

```powershell
& "$env:APPDATA\Python\Python312\Scripts\graphify.exe" --version
Test-Path "$env:USERPROFILE\.codex\skills\graphify\SKILL.md"
```

### 6.3 LazyCodex/OmO

먼저 실제 전달 명령을 확인한다.

```powershell
npx -y lazycodex-ai@4.19.4 --dry-run install --no-tui --no-codex-autonomous
```

설치:

```powershell
npx -y lazycodex-ai@4.19.4 install --no-tui --no-codex-autonomous
```

검증:

```powershell
codex plugin list | Select-String 'omo@sisyphuslabs'
```

Codex 재시작 시 OmO 훅 승인 화면이 표시되면 내용을 검토한 뒤 승인한다. `comment-checker` 같은 제3자 postinstall 스크립트는 자동 승인하지 말고 필요성과 코드를 먼저 검토한다.

### 6.4 기존 ECC 및 Superpowers 핵심 스킬 세트

현재 로컬 조사 기준:

- ECC 원본: `https://github.com/affaan-m/ECC.git`
- 조사한 ECC revision: `e4e4163101f162881e628f300a9ca4e6a940bcea`
- Superpowers 원본: `https://github.com/obra/superpowers`
- 로컬 임시 번들 버전: `5.1.3`
- Superpowers는 `%USERPROFILE%\.codex\.tmp\plugins\plugins\superpowers`에 캐시되어 있지만 현재 `codex plugin list`에는 활성 플러그인으로 등록되어 있지 않았다.
- 기존 `%USERPROFILE%\.agents\skills`의 ECC 항목 다수는 `%USERPROFILE%\.claude\plugins\marketplaces\ecc`를 가리키는 심볼릭 링크다. Claude 구성을 제거하면 깨지므로 다른 PC에서는 `--copy`로 Codex 독립 설치한다.

#### DAILY — 오케스트레이션과 현재 프로젝트에 상시 유용

| 출처 | 스킬 | 유지 이유 |
|---|---|---|
| ECC | `agent-introspection-debugging` | 에이전트 실패 원인과 복구 분석 |
| ECC | `intent-driven-development` | 구현 전 수용 조건과 경계 명세 |
| ECC | `loop-design-check` | runaway loop와 Goodhart 방지 |
| ECC | `security-review` | 코드·권한·비밀정보 검토 |
| ECC | `verification-loop` | build/test/lint/typecheck 검증 |
| ECC | `eval-harness` | AI/모델 기능의 회귀 평가 |
| ECC | `e2e-testing` | React/Next/Vite UI 흐름 검증 |
| ECC | `frontend-patterns` | 현재 React/Next/Vite 프로젝트 근거 |
| ECC | `backend-patterns` | API 및 서비스 경계 구현 |
| ECC | `git-workflow` | worktree, 통합, diff 관리 |
| ECC | `developing-with-streamlit` | 현재 Streamlit 프로젝트 근거 |
| ECC | `context-budget` | 컨텍스트 및 MCP 과적재 점검 |
| ECC | `config-gc` | 주기적인 설정 정리와 soft-delete |
| Superpowers | `systematic-debugging` | 가설·관찰·재현 기반 디버깅 |
| Superpowers | `using-git-worktrees` | 병렬 Writer 격리와 직접 연결 |
| Superpowers | `verification-before-completion` | 완료 주장 전 증거 요구 |

TDD는 중복 설치를 피한다. 기본값은 현재 ECC `tdd-workflow`를 유지하고 Superpowers `test-driven-development`는 LIBRARY로 둔다. 팀이 Superpowers TDD를 표준으로 선택하면 둘을 동시에 활성화하지 말고 하나를 교체한다.

#### LIBRARY — 중요하지만 필요할 때만 활성화

| 그룹 | 스킬 |
|---|---|
| 설계·계획 | ECC `product-lens`, `architecture-decision-records`, `api-design`, `product-capability` |
| 코드베이스 이해 | ECC `repo-scan`, `codebase-onboarding`, `code-tour`, `graphify` |
| 데이터·저장소 | ECC `database-migrations`, `postgres-patterns`, `prisma-patterns`, `redis-patterns`, `mysql-patterns` |
| AI/ML | ECC `mle-workflow`, `ai-regression-testing`, `benchmark-methodology` |
| 리서치 | ECC `deep-research`, `exa-search`, `market-research` |
| 콘텐츠·투자 | ECC `article-writing`, `content-engine`, `investor-materials`, `investor-outreach` |
| 미디어 | ECC `frontend-slides`, `fal-ai-media`, `video-editing` |
| Superpowers 설계 | `brainstorming`, `writing-plans` |
| Superpowers 실행 | `executing-plans`, `finishing-a-development-branch` |
| Superpowers 리뷰 | `requesting-code-review`, `receiving-code-review` |
| Superpowers TDD | `test-driven-development` — ECC TDD를 대체할 때만 |
| 스킬 제작 | Superpowers `writing-skills` — Codex 기본 `skill-creator`로 부족할 때만 |

#### 오케스트레이터와 충돌하므로 기본 비활성

| 스킬 | 이유 |
|---|---|
| Superpowers `subagent-driven-development` | 자체 하위 에이전트 배정 흐름이 Budgeted Graph Orchestrator의 소유권·예산·인간 승인 게이트와 충돌할 수 있음 |
| Superpowers `dispatching-parallel-agents` | Main Orchestrator의 DAG와 동시성 제어를 우회할 수 있음 |
| Superpowers `using-superpowers` | 모든 작업을 Superpowers 메타 규칙으로 재라우팅하여 상위 오케스트레이터 우선순위를 흐릴 수 있음 |
| ECC `dmux-workflows` | Windows/Orca/Codex 기본 멀티에이전트 흐름과 중복 |
| ECC `council` | 독립 Judge 및 인간 최종 게이트와 역할 중복 |
| ECC `continuous-learning-v2` | 자동 메모리 축적이 컨텍스트 오염과 오래된 규칙 문제를 만들 수 있음 |

이 항목들은 삭제 대상이 아니라 라이브러리 보존 대상이다. 명시적으로 요청된 작업에만 일시 활성화한다.

#### ECC 핵심 세트 Codex 독립 설치

```powershell
npx -y skills add https://github.com/affaan-m/ECC `
  --full-depth --global --agent codex --copy --yes `
  --skill agent-introspection-debugging intent-driven-development loop-design-check `
          security-review verification-loop eval-harness e2e-testing `
          frontend-patterns backend-patterns git-workflow developing-with-streamlit `
          context-budget config-gc tdd-workflow
```

설치 CLI가 저장소의 `.agents/skills`를 발견하지 못하면 저장소를 임시 clone하고 각 스킬 디렉터리를 `%USERPROFILE%\.agents\skills`에 복사한다. 심볼릭 링크로 `%USERPROFILE%\.claude`를 다시 참조하지 않는다.

#### Superpowers 선별 설치

```powershell
npx -y skills add https://github.com/obra/superpowers `
  --global --agent codex --copy --yes `
  --skill systematic-debugging using-git-worktrees verification-before-completion
```

Superpowers 전체 플러그인을 설치하지 않는 이유는 오케스트레이션 메타 스킬이 현재의 Main Orchestrator 정책을 우회할 수 있기 때문이다. 필요한 세 스킬만 복사 설치하고, 나머지는 GitHub 원본에서 온디맨드로 가져온다.

#### 독립 설치 검증

```powershell
$required = @(
  'agent-introspection-debugging', 'intent-driven-development', 'loop-design-check',
  'security-review', 'verification-loop', 'eval-harness', 'e2e-testing',
  'frontend-patterns', 'backend-patterns', 'git-workflow',
  'developing-with-streamlit', 'context-budget', 'config-gc', 'tdd-workflow',
  'systematic-debugging', 'using-git-worktrees', 'verification-before-completion'
)

foreach ($name in $required) {
  $candidates = @(
    "$env:USERPROFILE\.codex\skills\$name\SKILL.md",
    "$env:USERPROFILE\.agents\skills\$name\SKILL.md"
  )
  $found = $candidates | Where-Object { Test-Path -LiteralPath $_ }
  [pscustomobject]@{ Skill = $name; Installed = [bool]$found; Path = $found -join ';' }
}

# Claude 종속 링크가 남았는지 확인
Get-ChildItem "$env:USERPROFILE\.agents\skills" -Directory -Force |
  Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
  Select-Object Name, LinkTarget
```

최종 명령의 `LinkTarget`이 `.claude`를 가리키면 Codex 독립화가 완료되지 않은 것이다.

### 6.5 그 밖의 전체 스킬 표면

2026-08-27 로컬 인벤토리 기준으로 다음 표면이 추가로 존재한다. 숫자는 중복 이름을 각 출처 안에서 한 번만 센 값이며 서로 다른 출처 사이의 중복은 포함한다.

| 출처 | 확인 수 | 관리 방식 |
|---|---:|---|
| `%USERPROFILE%\.codex\skills` | 60 | Codex 기본 및 사용자 전역 스킬 |
| `%USERPROFILE%\.agents\skills`의 독립 스킬 | 5 | Orca/Agent Skills 전역 표면 |
| LazyCodex/OmO `4.19.4` | 26 | 플러그인 번들로 관리; 개별 복사 금지 |
| Superpowers `5.1.3` 임시 캐시 | 14 | 핵심만 선별 복사; 캐시를 원본으로 취급하지 않음 |
| OpenAI Primary Runtime | 6 | Codex 런타임 플러그인으로 관리 |
| OpenAI Curated Remote | 25 | 원격 큐레이션/템플릿; 온디맨드 사용 |
| 개인 플러그인 | 1 | `budgeted-graph-orchestration` |
| `.claude`를 참조하는 ECC 링크 | 39 | Codex 독립 복사 후 링크 제거 대상 |

#### Codex 기본 시스템 스킬 — 항상 보존

다음은 Codex 자체 기능과 설치·확장 관리에 사용되므로 정리 작업에서 삭제하지 않는다.

- `imagegen`
- `openai-docs`
- `plugin-creator`
- `skill-creator`
- `skill-installer`
- `review-agent`

이들은 보통 `%USERPROFILE%\.codex\skills\.system` 또는 Codex 런타임이 관리한다. 직접 수정하거나 다른 저장소 백업본으로 덮어쓰지 않는다.

#### Orca/Agent Skills — 현재 환경에서 핵심 유지

| 스킬 | 분류 | 이유 |
|---|---|---|
| `computer-use` | DAILY | Windows 데스크톱 앱과 브라우저 UI 제어 |
| `orca-cli` | DAILY | Orca worktree·터미널·브라우저 운영 |
| `orchestration` | DAILY | Orca 기반 구조화된 다중 에이전트 통신 |
| `find-skills` | DAILY | 신규 스킬 검색 및 출처 검증 |
| `developing-with-streamlit` | DAILY | 현재 Streamlit 앱 작업 근거 |

이 다섯 개는 현재 독립 디렉터리이며 `.claude` 링크가 아니다. 다른 PC에 Orca가 없으면 `computer-use`, `orca-cli`, `orchestration`은 설치하지 않고 Codex 기본 도구로 대체한다.

#### LazyCodex/OmO 번들 — 플러그인으로만 관리

확인된 스킬:

```text
ast-grep
coding-agent-sessions
comment-checker
data-scientist
debugging
frontend
git-master
init-deep
lcx-contribute-bug-fix
lcx-doctor
lcx-report-bug
lsp
lsp-setup
programming
refactor
remove-ai-slops
review-work
rules
start-work
teammode
ultimate-browsing
ultrawork
ulw-loop
ulw-plan
ulw-research
visual-qa
```

관리 원칙:

- `omo@sisyphuslabs` 플러그인의 버전과 함께 갱신한다.
- 이 스킬들을 `%USERPROFILE%\.codex\skills`로 따로 복사하지 않는다.
- `ultrawork`, `ulw-loop`, `teammode`, `start-work` 같은 자체 오케스트레이션은 명시적으로 호출됐을 때만 사용한다.
- 일반 작업에서는 `budgeted-graph-orchestration`의 인간 승인·소유권·예산 게이트가 우선한다.
- `debugging`, `lsp`, `ast-grep`, `visual-qa` 같은 실행 기술은 하위 도구로 활용할 수 있다.

#### OpenAI Primary Runtime — 온디맨드 유지

확인된 스킬 및 플러그인:

| 스킬 | 권장 상태 |
|---|---|
| `documents` | 유지 — DOCX/문서 생성 요청 시 |
| `pdf` | 유지 — PDF 생성·검사 시 |
| `Presentations` | 유지 — PPTX/슬라이드 요청 시 |
| `Spreadsheets` | 온디맨드 — 현재 설치본은 비활성 상태였음 |
| `excel-live-control` | 온디맨드 — 실제 Excel 제어가 필요할 때만 |
| `template-creator` | 유지 — 새로운 artifact template 제작 시 |

이 묶음은 OpenAI 런타임 캐시가 관리한다. 로컬 plugin cache 경로를 백업하거나 수동 복사하지 않는다.

#### OpenAI Curated Remote — 템플릿 라이브러리

다음은 일반 코딩 세션에 상시 필요한 스킬이 아니라 특정 산출물을 만들 때 로드하는 템플릿이다.

```text
artifact-template-analytics-dashboard
artifact-template-business-review
artifact-template-design-report
artifact-template-experiment-analysis
artifact-template-financial-budget
artifact-template-investment-committee-memo
artifact-template-legal-memorandum
artifact-template-market-trends-report
artifact-template-minimal-letterhead
artifact-template-operating-calendar
artifact-template-operating-review
artifact-template-project-kickoff
artifact-template-project-tracker
artifact-template-sales-pipeline
artifact-template-simple-dark-mode
artifact-template-simple-light-mode
artifact-template-strategy-memorandum
artifact-template-system-design
artifact-template-team-alignment
artifact-template-three-statement-forecast
notion-knowledge-capture
notion-meeting-intelligence
notion-research-documentation
notion-spec-to-implementation
plugin-management
```

관리 원칙:

- artifact/notion 요청에만 온디맨드로 사용한다.
- 전역 DAILY 세트에 복사하지 않는다.
- Notion 연결이 없으면 Notion 스킬을 삭제하지 말고 비활성 라이브러리로 둔다.
- 원격 캐시는 재다운로드 가능하므로 GitHub 개인 백업에 포함하지 않는다.

#### 나머지 Codex 사용자 스킬 분류

아래는 이미 `%USERPROFILE%\.codex\skills`에 있지만 DAILY 핵심 목록에 포함되지 않은 주요 스킬이다.

| 분류 | 스킬 |
|---|---|
| 설정·감사 | `agent-self-evaluation`, `agent-sort`, `configure-ecc`, `ecc-guide`, `skill-scout`, `skill-stocktake`, `strategic-compact` |
| 코드 탐색·QA | `browser-qa`, `click-path-audit`, `code-tour`, `codebase-onboarding`, `repo-scan`, `production-audit`, `delivery-gate` |
| 데이터베이스 | `clickhouse-io`, `database-migrations`, `jpa-patterns`, `mysql-patterns`, `postgres-patterns`, `prisma-patterns`, `redis-patterns` |
| 설계·제품 | `architecture-decision-records`, `product-lens`, `plan-canvas`, `rules-distill` |
| 에이전트·메모리 | `continuous-learning`, `continuous-learning-v2`, `iterative-retrieval`, `unified-memory`, `growth-log` |
| 특수 워크플로 | `ck`, `council`, `santa-method`, `plankton-code-quality`, `inherit-legacy-style`, `hookify-rules` |
| 기술·품질 | `ai-regression-testing`, `error-handling`, `tdd-workflow`, `windows-desktop-e2e` |

추천 처리:

- 설정·감사 스킬은 LIBRARY로 보존하고 정리 작업 때만 사용한다.
- 데이터베이스 스킬은 프로젝트의 실제 DB가 일치할 때만 활성화한다.
- `continuous-learning`과 `continuous-learning-v2`는 중복 평가 후 하나만 남긴다.
- `council`, `santa-method` 등 자체 실행 루프는 상위 오케스트레이터와 충돌할 수 있으므로 기본 비활성으로 둔다.
- `clickhouse-io`, `jpa-patterns`처럼 현재 Python/React 프로젝트 스택과 맞지 않는 스킬은 삭제하지 않고 라이브러리로 이동한다.
- `windows-desktop-e2e`는 Windows 데스크톱 앱을 실제 테스트할 때만 사용한다.

#### 출처별 중복 해소 우선순위

같은 기능이 여러 출처에 있을 때 다음 우선순위를 사용한다.

1. Codex 시스템 스킬 — 제품 기능과 직접 연결된 경우
2. `budgeted-graph-orchestration` — 전체 작업 통제와 인간 승인
3. 프로젝트 스택에 맞는 ECC 선별 스킬
4. Superpowers의 독특한 방법론 스킬
5. LazyCodex 실행 기술 — LSP, AST, visual QA 등
6. OpenAI artifact/template 스킬 — 산출물 요청 시

대표 중복 결정:

| 기능 | 기본 선택 | 다른 항목 처리 |
|---|---|---|
| 상위 오케스트레이션 | `budgeted-graph-orchestration` | `subagent-driven-development`, `teammode`, `council`은 명시 호출 전 비활성 |
| 계획 압박 질문 | `grilling` | `brainstorming`, `product-lens`는 상황별 보조 |
| TDD | ECC `tdd-workflow` | Superpowers TDD는 대체 선택지 |
| 완료 검증 | 독립 `budget_judge` + `verification-loop` | `verification-before-completion`은 Worker 체크리스트로 보조 |
| 디버깅 | Superpowers `systematic-debugging` | LazyCodex `debugging`은 runtime 도구가 필요할 때 보조 |
| 병렬 격리 | Superpowers `using-git-worktrees` | Orca worktree 기능이 있으면 `orca-cli`로 실행 |
| 문서/슬라이드/PDF | OpenAI Primary Runtime | ECC 문서·슬라이드 스킬은 특수 스타일이 필요할 때만 |

#### 다른 PC로 옮길 것과 옮기지 않을 것

직접 백업:

- 개인 플러그인 `budgeted-graph-orchestrator`
- 직접 만든 사용자 스킬
- 네 개의 `budget-*.toml`
- 비밀정보를 제거한 `AGENTS.md`와 `config.toml` 템플릿
- DAILY/LIBRARY manifest와 pinned source revision

재설치로 복구:

- ECC 선별 스킬
- Superpowers 선별 스킬
- LazyCodex/OmO
- Graphify
- OpenAI Primary/Curated 플러그인
- Codex 시스템 스킬

백업하지 않음:

- `.tmp`, plugin cache, package cache
- Orca runtime 복제본
- 세션, 로그, SQLite DB
- `.claude` 심볼릭 링크
- 인증 및 비밀정보

### 6.6 “전체 500개 / 활성 60개”의 정확한 의미

전수 조사 결과 사용자의 기억은 맞다. 다만 두 숫자는 서로 다른 레이어를 센 것이다.

| 지표 | 조사값 | 의미 |
|---|---:|---|
| Codex 직접 전역 스킬 | **60** | `%USERPROFILE%\.codex\skills`에서 현재 직접 관리되는 이름 기준 스킬 |
| Codex marketplace 후보 | **608** | `%USERPROFILE%\.codex\.tmp\plugins\plugins`에 내려받은 플러그인 후보의 `SKILL.md` |
| `.codex` 전체 물리 스킬 파일 | 751 | 직접 스킬, 임시 marketplace, 플러그인 cache, 복제본 포함 |
| `.claude` 전체 물리 스킬 파일 | 1,819 | ECC 원본, docs 복제, plugin cache 포함 |
| Orca runtime 물리 스킬 파일 | 104 | Orca 플러그인 cache와 marketplace 복제본 포함 |
| 모든 관련 경로 물리 파일 합계 | **2,689** | 같은 스킬의 여러 버전과 복제본을 모두 포함 |
| 모든 관련 경로 고유 `name` | **987** | 출처와 버전이 다른 동명 항목을 이름 기준 dedupe한 값 |

따라서 “987개를 모두 활성화”한 상태가 아니다. 현재 직접 전역으로 관리되는 핵심 표면이 약 60개이고, 수백 개는 검색·설치 가능한 marketplace 라이브러리 또는 캐시다.

#### Codex marketplace에서 확인된 대형 플러그인 묶음

다음 숫자는 `%USERPROFILE%\.codex\.tmp\plugins\plugins` 안의 물리 `SKILL.md` 수다. 설치·활성 수가 아니다.

| 플러그인 | 스킬 수 | 기본 분류 |
|---|---:|---|
| `twilio-developer-kit` | 55 | LIBRARY — Twilio 작업 시 |
| `zoom` | 53 | LIBRARY — Zoom 연동 시 |
| `life-science-research` | 50 | LIBRARY — 생명과학 리서치 시 |
| `vercel` | 47 | LIBRARY/프로젝트별 — Vercel 배포 시 |
| `daloopa` | 21 | LIBRARY — 금융 데이터 작업 시 |
| `render` | 21 | LIBRARY — Render 배포 시 |
| `shopify` | 20 | LIBRARY — Shopify 작업 시 |
| `build-web-data-visualization` | 18 | LIBRARY — 데이터 시각화 시 |
| `ngs-analysis` | 18 | LIBRARY — NGS 분석 시 |
| `superpowers` | 14 | 선별 사용 |
| `expo` | 13 | LIBRARY — Expo/React Native 시 |
| `figma` | 12 | LIBRARY — Figma 연동 시 |
| `netlify` | 12 | LIBRARY — Netlify 배포 시 |
| `codex-security` | 12 | 보안 점검 시 온디맨드 |
| `nvidia` | 11 | LIBRARY — NVIDIA/CUDA 작업 시 |
| `build-macos-apps` | 11 | 현재 Windows 환경에서는 LIBRARY |
| `hugging-face` | 11 | AI/ML 프로젝트에서 선택 활성 |
| `cloudflare` | 9 | Cloudflare Workers 프로젝트에서 선택 활성 |
| `game-studio` | 9 | 게임 개발 시 |
| `build-ios-apps` | 9 | 현재 Windows 환경에서는 LIBRARY |
| `boltz-api-cli` | 8 | 생명과학/구조 예측 시 |
| `datasite` | 8 | Datasite 작업 시 |
| `teams` | 7 | Microsoft Teams 연동 시 |
| `sharepoint` | 7 | SharePoint 연동 시 |
| `slack` | 6 | Slack 연동 시 |
| `build-web-apps` | 6 | 웹 앱 산출물 작업 시 |
| `outlook-calendar` | 6 | Outlook 연결 시 |
| `outlook-email` | 6 | Outlook 연결 시 |
| `superhuman` | 6 | Superhuman 연결 시 |
| `google-calendar` | 5 | Google 연결 시 |
| `google-drive` | 5 | Google 연결 시 |
| `openai-developers` | 5 | OpenAI API 작업 시 |
| `deepnote` | 5 | Deepnote 작업 시 |
| `atlassian-rovo` | 5 | Atlassian/Rovo 작업 시 |
| `notion` | 4 | Notion 연결 시 |
| `github` | 4 | GitHub 작업 시 |
| `circleci` | 4 | CircleCI 작업 시 |
| `hubspot` | 4 | HubSpot 작업 시 |
| `wix` | 4 | Wix 작업 시 |
| `airtable` | 3 | Airtable 연결 시 |
| `canva` | 3 | Canva 연결 시 |
| `morningstar` | 3 | 금융 리서치 시 |
| `gmail` | 2 | Gmail 연결 시 |
| `neon-postgres` | 2 | Neon DB 사용 시 |
| `supabase` | 2 | Supabase 사용 시 |
| `stripe` | 2 | 결제 연동 시 |
| `replayio` | 2 | Replay 디버깅 시 |

그 밖에도 작은 플러그인과 fixture가 있어 전체 합계가 608개다. 이 marketplace 전체를 DAILY로 설치하면 컨텍스트·도구 선택 노이즈와 플러그인 권한 면적이 크게 증가한다.

#### ECC 내부에서 숫자가 더 커지는 이유

ECC repository 자체에는 canonical `skills` 281개가 있다. 같은 내용이 여러 호환 표면에 복제되어 있다.

| ECC 표면 | 물리 파일 수 |
|---|---:|
| `ecc/skills` | 281 |
| `ecc/docs` 내부 예제·카탈로그 | 519 |
| `ecc/.kiro` | 43 |
| `ecc/.agents` | 39 |
| `ecc/.cursor` | 11 |
| 설치 cache `ecc/ecc/2.1.0` | 894 |

이 숫자들을 단순 합산하면 같은 워크플로가 여러 번 세어진다. ECC의 source of truth는 `skills/`이며, Codex에서는 선별된 `.agents/skills` 또는 독립 복사본만 활성 표면으로 취급한다.

#### 활성 상태를 판단하는 규칙

다음 네 상태를 구분한다.

1. **Direct active**: `%USERPROFILE%\.codex\skills` 또는 실제 로드되는 `%USERPROFILE%\.agents\skills`에 존재.
2. **Plugin active**: `codex plugin list`에서 `installed, enabled`로 표시.
3. **Available**: marketplace에 있지만 `not installed` 또는 disabled.
4. **Cache only**: `.tmp`, `plugins/cache`, runtime cache에만 존재.

파일이 디스크에 있다는 이유만으로 active라고 기록하지 않는다.

#### 현재 발견된 상태 드리프트

`budgeted-graph-orchestrator`는 이전 Orca runtime에서 `installed, enabled`로 확인됐지만, 최신 직접 `codex plugin list`에서는 personal marketplace의 `not installed`로 보였다. 이는 Codex App/Orca runtime과 독립 Codex CLI가 서로 다른 runtime home/cache 상태를 볼 수 있음을 뜻한다.

각 표면에서 별도로 검증한다.

```powershell
codex plugin list | Select-String 'budgeted-graph-orchestrator|omo@sisyphuslabs'
```

현재 사용하는 Codex 표면에서 `not installed`라면 다음을 다시 실행하고 새 세션을 연다.

```powershell
codex plugin add budgeted-graph-orchestrator@personal
```

설치 성공을 다른 runtime의 cache 디렉터리 존재만으로 판정하지 않는다.

## 7. 개인 오케스트레이터 플러그인 생성

Codex 기본 `plugin-creator`로 scaffold와 개인 marketplace 항목을 만든다.

```powershell
$creator = "$env:USERPROFILE\.codex\skills\.system\plugin-creator\scripts\create_basic_plugin.py"
py -3.12 $creator budgeted-graph-orchestrator `
  --with-skills --with-hooks --with-scripts --with-assets --with-marketplace
```

플러그인 루트는 다음이다.

```text
%USERPROFILE%\plugins\budgeted-graph-orchestrator\
├─ .codex-plugin\plugin.json
├─ assets\execution-graph.schema.json
├─ assets\task-capsule.json
├─ hooks\session-start.json
├─ scripts\orchestrator-graph.mjs
├─ scripts\orchestrator-graph.test.mjs
├─ scripts\session-reminder.ps1
└─ skills\budgeted-graph-orchestration\
   ├─ SKILL.md
   └─ references\
      ├─ execution-graph.md
      ├─ protocol.md
      ├─ task-capsule.md
      └─ human-gate.md
```

### 7.1 `.codex-plugin/plugin.json`

```json
{
  "name": "budgeted-graph-orchestrator",
  "version": "0.1.0",
  "description": "Human-gated, graph-informed multi-agent orchestration with bounded task capsules.",
  "author": { "name": "Local developer" },
  "skills": "./skills/",
  "interface": {
    "displayName": "Budgeted Graph Orchestrator",
    "shortDescription": "Graph-first orchestration with bounded workers.",
    "longDescription": "Classifies work, asks the human which stages to run, builds graph-informed task capsules, delegates bounded work, integrates centrally, and verifies independently.",
    "developerName": "Local developer",
    "category": "Productivity",
    "capabilities": ["Workflow", "Multi-agent orchestration", "Context budgeting", "Verification"],
    "defaultPrompt": "Classify this task and propose a human-approved, graph-informed execution pipeline before making changes."
  }
}
```

현재 로컬 plugin validator는 개인 플러그인의 `hooks` manifest 필드를 거부한다. 따라서 훅 파일은 보존하되 manifest에 연결하지 않고, 전역 `AGENTS.md`와 스킬 자동 트리거를 강제 계층으로 사용한다.

### 7.2 `skills/budgeted-graph-orchestration/SKILL.md`

```markdown
---
name: budgeted-graph-orchestration
description: Use for every non-trivial task that may require repository exploration, planning, code changes, multiple files, dependencies, or verification. The main orchestrator must classify the task, consult the project graph when available, propose execution stages to the human, wait for approval, then execute an acyclic task graph with bounded task capsules, centralized integration, and independent verification. Skip delegation for trivial one-step work, but still classify and verify it.
---

# Budgeted Graph Orchestration

The main thread owns intent, decisions, stage approval, integration, and the final report. Subagents own bounded evidence or implementation tasks only.

## Choose the execution shape

Use one bounded task capsule for one independent task. Use an execution DAG when work has real dependencies, parallel branches, joins, or human gates.

The layers have separate jobs: Graphify provides source and impact evidence; the DAG schedules approved work; a node-local loop bounds execution and retry; an independent Judge records verification verdicts; the human retains final authority. Read `references/execution-graph.md` only when the approved work needs a DAG.

## Mandatory gate

Before mutating files on a non-trivial task:

1. Classify the task as S, M, L, or XL using `references/protocol.md`.
2. If `graphify-out/graph.json` exists, query it for the requested behavior and affected areas. If it does not exist and the task is M or larger, propose graph initialization as a stage.
3. Produce a stage proposal with scope, agents, files or communities, acceptance commands, and estimated budget.
4. Ask the human which stages to run. Recommend the smallest safe pipeline.
5. Wait for approval. Approval of a plan does not authorize push, merge, publish, credential changes, or other external actions.

S tasks may use a compact approval question. Pure answers and read-only inspection do not require a mutation gate.

## Execution pipeline

After approval:

1. Create `.orchestrator/tasks/<task-id>/` with the files described in `references/task-capsule.md`.
2. Give each subagent only its task packet. Use no inherited conversation, or the smallest supported recent-turn fork.
3. Assign explicit ownership. A worker must not modify files outside its ownership list or alter acceptance criteria.
4. Use separate worktrees for parallel writers when practical. Read-only explorers may share the main worktree.
5. Require every worker to return `RESULT.md` data: status, files changed, commands run, evidence, remaining risk, and budget use.
6. The main orchestrator integrates results and resolves conflicts. Workers never merge or push.
7. An independent read-only judge runs deterministic acceptance checks and inspects the diff. The builder cannot judge its own work.
8. After code changes, run `graphify update .` when a project graph exists, then query affected nodes or paths.
9. Present the human with the outcome and any next external action requiring approval.

When approved work requires an execution DAG, use the deterministic controller described in `references/execution-graph.md`. Store runtime artifacts under `.orchestrator/runs/<run-id>/`; never write execution events into `graphify-out/graph.json`. A controller may establish machine-verifiable evidence, but only the human advances explicit human gates or grants external-action authority.

## Hard stops

Stop and return control to the main orchestrator when any of these occurs:

- budget exhausted;
- ownership boundary would be crossed;
- acceptance criteria appear wrong or need editing;
- two failed implementation retries for M/L work;
- graph evidence conflicts with direct source evidence;
- security, data loss, credential, publication, merge, or payment authority is needed.

Do not convert a hard stop into an improvised workaround.

## Context discipline

- Task packets contain objective facts and exact file references, not the full chat transcript.
- Explorers return summaries with file and symbol citations, not raw logs.
- Workers receive only prerequisites that are already settled.
- The main orchestrator may interrupt a worker that exceeds its task boundary or repeats an unproductive action.
- Human judgment owns the final switch. Machine verification establishes evidence, not product acceptance.

## References

- Classification and budgets: `references/protocol.md`
- Capsule schema: `references/task-capsule.md`
- Execution DAG runtime: `references/execution-graph.md`
- Human stage prompt: `references/human-gate.md`
```

### 7.3 `references/protocol.md`

```markdown
# Classification and budgets

## S — bounded local change
- Scope: one or two files, one obvious behavior.
- Context: task, ownership, acceptance, and at most one recent parent turn.
- Tool budget: 10 calls. Retry budget: one.
- Pipeline: orchestrator -> executor -> deterministic verification.

## M — multi-file feature or defect
- Scope: three to eight files or one graph community.
- Context: task, graph query, selected excerpts, ownership, acceptance, and at most two recent parent turns.
- Tool budget: 25 calls per worker. Retry budget: two.
- Pipeline: graph/explorer -> planner -> workers -> integrator -> independent judge.

## L — cross-module change
- Scope: more than eight files, multiple graph communities, migration, or integration boundary.
- Context: one capsule per subtask and at most three recent parent turns when unavoidable.
- Tool budget: 40 calls per worker. Retry budget: two, then human escalation.
- Pipeline: graph mapping -> DAG -> human gate -> isolated workers -> integrator -> independent judges -> graph impact check.

## XL — architecture, security, destructive, or externally consequential
- No automatic execution.
- Produce evidence, alternatives, boundaries, rollback, and staged acceptance criteria.
- Require human approval at every consequential stage.

Budgets are controller limits, not model context-window settings.

## Execution graph sizing

Use an execution graph only when approved stages contain a real dependency, join, parallel ownership boundary, or human gate. Do not manufacture nodes for one-step work. Each task node has one bounded capsule, explicit write ownership, immutable acceptance criteria, and a non-negative retry cap.

The outer graph remains acyclic. Retry behavior belongs inside a node-local state machine and cannot add an outward back-edge. Ready nodes may run in parallel only when neither depends on the other and their normalized `writeFiles` do not overlap. Converging work uses an explicit join node. Retry exhaustion transitions the node to `ESCALATED` and returns judgment to the human or Main Orchestrator.
```

### 7.4 `references/task-capsule.md`

```markdown
# Task capsule schema

Create `.orchestrator/tasks/<task-id>/` containing:

- `TASK.md`: objective, class, parent task, dependencies, and non-goals.
- `CONTEXT.md`: graph evidence, source references, and settled decisions; never a raw chat dump.
- `OWNERSHIP.json`: allowed read roots, allowed write files, forbidden paths, and worktree.
- `ACCEPTANCE.md`: deterministic commands, expected exit codes, invariants, and anti-Goodhart boundaries.
- `BUDGET.json`: tool-call limit, retry limit, time guidance, context-fork limit, and escalation.
- `RESULT.md`: status, files, commands, exit codes, evidence, risks, budget used, and handoff.

Statuses: `READY`, `RUNNING`, `BLOCKED`, `BUDGET_EXHAUSTED`, `AWAITING_JUDGE`, `VERIFIED`.
Only the Main Orchestrator advances a capsule to `VERIFIED`.

## Execution graph linkage

For a task represented by an execution node, copy the capsule's exact `writeFiles`, deterministic acceptance statements, and retry ceiling into the node before `init`. Link Graphify IDs or source locations only through `node.evidence`. After initialization the definition and acceptance digests are immutable. Runtime node state never promotes the capsule itself to `VERIFIED`.
```

### 7.5 `references/human-gate.md`

```markdown
# Human stage gate

Before mutation, present:

1. Task class and reason.
2. Graph evidence and affected communities/files.
3. Proposed stages and verification.
4. Agent ownership boundaries.
5. Budget and hard stops.
6. Recommended selection.

Ask: `어느 단계까지 진행할까요?`

- `A. 조사·계획만`
- `B. 구현과 로컬 검증까지 (추천)`
- `C. 통합 검증 및 전달물까지`

Push, merge, publish, paid actions, credential changes, and third-party mutations require separate approval.
```

### 7.6 실행 그래프 runtime

먼저 실행 형태를 고른다.

- 서로 독립적인 한 작업이면 bounded Task Capsule 하나만 사용한다.
- 실제 dependency, 병렬 branch, join 또는 human gate가 있으면 execution DAG를 사용한다.

그다음 다음 다섯 책임을 섞지 않는다.

| 책임 | 담당 | 역할 |
|---|---|---|
| 코드·영향 근거 | Graphify | 대상 코드와 관계를 설명한다. |
| 실행 순서 | Execution DAG | dependency, ready set, join, ownership, gate를 관리한다. |
| 제한된 반복 | Task node | 정해진 retry cap 안에서 실행·검증·재시도를 반복한다. |
| 검증 판정 | Independent Judge | `SUCCEEDED` 또는 `RETRYING`을 판정한다. |
| 최종 권한 | Human | human gate와 모든 외부·중요 행동을 승인한다. |

최초 실행은 정의 검증부터 시작한다.

```powershell
$pluginRoot = "$env:USERPROFILE\plugins\budgeted-graph-orchestrator"
Set-Location $pluginRoot

node scripts/orchestrator-graph.mjs validate <definition.json>
node scripts/orchestrator-graph.mjs init <definition.json> <run-directory>
node scripts/orchestrator-graph.mjs render <run-directory> --output graph.mmd
node scripts/orchestrator-graph.mjs ready <run-directory>
node scripts/orchestrator-graph.mjs transition <run-directory> <node-id> RUNNING --actor-role worker
node scripts/orchestrator-graph.mjs transition <run-directory> <node-id> VERIFYING --actor-role worker
node scripts/orchestrator-graph.mjs transition <run-directory> <node-id> SUCCEEDED --actor-role judge
node scripts/orchestrator-graph.mjs status <run-directory>
```

`validate <run-directory>`로 초기화된 run도 다시 검사할 수 있다. human gate는 모든 dependency가 성공한 뒤에만 인간이 `SUCCEEDED --actor-role human`으로 통과시킨다.

`init`은 `.orchestrator/runs/<run-id>/` 아래에 immutable `graph.json`, append-only `events.jsonl`, 복구 가능한 `checkpoint.json`을 만든다. `render --output graph.mmd`는 Mermaid 시각화를 저장한다. 상태 전이는 task의 `PENDING → RUNNING → VERIFYING → SUCCEEDED` 경로와 bounded `VERIFYING → RETRYING → RUNNING` 경로만 허용한다. retry cap을 초과하면 `ESCALATED`로 감쇠한다. 한 run에는 controller process 하나만 사용하며 runtime event는 Graphify project graph에 기록하지 않는다.

`assets/execution-graph.schema.json`은 `version`, `runId`, task/human-gate node, `dependsOn`, `ownership.writeFiles`, immutable `acceptance`, `maxRetries`, capsule 및 Graphify evidence link를 정의한다. 자세한 명령과 복구 규칙은 `references/execution-graph.md`를 따른다.

### 7.7 `assets/task-capsule.json`

```json
{
  "taskClass": "S|M|L|XL",
  "status": "READY",
  "ownership": {
    "readRoots": [],
    "writeFiles": [],
    "forbiddenPaths": []
  },
  "budget": {
    "toolCalls": 10,
    "retries": 1,
    "forkTurns": 1
  },
  "acceptance": [],
  "hardStops": ["budget_exhausted", "ownership_crossing", "acceptance_change_required"]
}
```

## 8. 모델 라우팅과 에이전트 역할

Main Orchestrator의 기본 모델은 `gpt-5.6-sol`이며, 계획·통합·최종 의사결정에 우선 사용한다. 하위 에이전트는 모든 역할을 같은 모델에 고정하지 않고, capsule의 작업량과 위험에 따라 아래 기본값에서 선택한다. 모델 선택은 비용이나 편의 때문에 독립 Judge를 생략하게 해서는 안 된다.

| 작업 | 기본 모델/effort | 라우팅 기준 |
|---|---|---|
| Main Orchestrator | `gpt-5.6-sol` / `high` | 분류, 인간 단계 게이트, 통합 결정 |
| 좁은 읽기 전용 탐색 | `gpt-5.6-luna` / `medium` | Graphify·소스 근거 수집처럼 짧고 병렬화 가능한 조사 |
| 표준 구현 작업 | `gpt-5.6-terra` / `medium` | 명확한 소유권과 결정적 acceptance가 있는 변경 |
| 다중 모듈 통합 또는 고위험 구현 | `gpt-5.6-sol` / `high` | 여러 결과의 충돌 해소, 보안·마이그레이션 경계 |
| 독립 Judge | `gpt-5.6-sol` / `high` | 구현자와 분리된 결정적 검증과 고영향 판정 |

Task Capsule에는 선택한 모델과 이유를 기록한다. 역할 TOML의 값은 안전한 기본값일 뿐이며, Main Orchestrator는 capsule 범위 안에서만 하위 모델을 라우팅하거나 승격한다. 전역 `config.toml`의 모델을 이 문서의 예시대로 무단 덮어쓰지 않는다.

다음 파일을 `%USERPROFILE%\.codex\agents\`에 둔다.

### `budget-explorer.toml`

```toml
model = "gpt-5.6-luna"
model_reasoning_effort = "medium"
sandbox_mode = "read-only"

developer_instructions = """
You are a bounded evidence collector. Read only the task capsule and its allowed roots. Use Graphify first when a current graph exists, then confirm important claims against source. Return a concise evidence packet with file and symbol citations. Do not propose or make edits. Stop on budget exhaustion or boundary ambiguity.
"""
```

### `budget-worker.toml`

```toml
model = "gpt-5.6-terra"
model_reasoning_effort = "medium"
sandbox_mode = "workspace-write"

developer_instructions = """
You are a bounded implementation worker. Work only on the explicit objective and write-owned files in the task capsule. Never edit acceptance criteria, tests solely to weaken them, unrelated files, credentials, or external resources. Record changed files, commands, exit codes, evidence, remaining risk, and budget use. Stop with BUDGET_EXHAUSTED or BLOCKED instead of improvising beyond the capsule.
"""
```

### `budget-integrator.toml`

```toml
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"

developer_instructions = """
You are a bounded integrator acting only on an orchestrator-approved integration capsule. Reconcile worker results and conflicts without expanding scope or changing acceptance criteria. Inspect the combined diff and run integration checks. Do not push, merge, publish, or change credentials. Return the integrated diff summary and evidence for an independent judge.
"""
```

### `budget-judge.toml`

```toml
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
sandbox_mode = "read-only"

developer_instructions = """
You are the independent deterministic judge. You did not build the change. Run or inspect the exact acceptance checks, verify boundaries and ownership, look for weakened tests and missing graph impacts, and report PASS or FAIL with evidence. Never repair the implementation or modify acceptance criteria. Human judgment remains the final acceptance gate.
"""
```

## 9. `config.toml` 역할 등록

기존 `%USERPROFILE%\.codex\config.toml`의 `[agents]` 영역에 다음을 추가한다. 기존 설정과 비밀정보는 보존한다.

```toml
[agents.budget_explorer]
description = "Read-only graph-first explorer operating from a bounded task capsule."
config_file = "agents/budget-explorer.toml"

[agents.budget_worker]
description = "Implementation worker restricted to capsule ownership, budget, and acceptance boundaries."
config_file = "agents/budget-worker.toml"

[agents.budget_integrator]
description = "Central integrator for orchestrator-approved worker results; never pushes or merges."
config_file = "agents/budget-integrator.toml"

[agents.budget_judge]
description = "Independent read-only judge for deterministic acceptance and boundary verification."
config_file = "agents/budget-judge.toml"
```

전역 에이전트 설정 권장값:

```toml
[agents]
max_concurrent_threads_per_session = 6
max_depth = 1
```

`max_depth = 1`은 하위 에이전트가 다시 무제한으로 에이전트를 생성하는 것을 막는다.

### 9.1 Lean MCP baseline

MCP는 설치 명세의 예시일 뿐이다. 기존 `%USERPROFILE%\.codex\config.toml`을 통째로 교체하지 말고, 현재 사용 중인 프로젝트·권한·자격 증명과 충돌하지 않는 항목만 add-only로 병합한다. 이 문서는 live config를 직접 수정하는 절차를 실행하지 않는다.

기본 활성 세트는 Node REPL과 필요한 일반 개발·조사 서버만으로 유지한다.

| 상태 | MCP 서버 | 용도 |
|---|---|---|
| 기본 | `node_repl` | Codex App/브라우저 연동 런타임 |
| 기본 | `github`, `context7`, `exa`, `memory`, `playwright`, `sequential-thinking` | 코드·문서 조회, 브라우저 검증, 제한된 기억과 추론 보조 |
| 온디맨드 | `supabase` | 실제 Supabase 프로젝트를 읽기 전용으로 조사해야 할 때만 추가 |

`supabase`는 기본 전역 세트에 넣지 않는다. 대상 프로젝트가 Supabase를 사용하고 사용자가 연결 범위와 권한을 승인한 경우에만 read-only 우선 설정으로 추가한다. Firecrawl, fal.ai, Cloudflare 등도 같은 원칙으로 작업에 필요할 때만 활성화한다.

권장 최소 형태는 다음과 같다. 경로·환경 변수·토큰·기존 사용자 정의 서버는 예시에 복사하거나 덮어쓰지 않는다.

```toml
# Main Orchestrator 기본값 — 하위 역할은 capsule에 따라 별도 모델을 사용한다.
model = "gpt-5.6-sol"
model_reasoning_effort = "high"

# 기본 MCP: node_repl, github, context7, exa, memory, playwright,
# sequential-thinking

# [mcp_servers.supabase]  # 필요하고 승인된 프로젝트에서만 추가
# command = "npx"
# args = ["-y", "supabase-mcp-server@latest", "--read-only"]
```

## 10. 전역 `AGENTS.md` 정책

`%USERPROFILE%\.codex\AGENTS.md` 상단에 다음을 추가한다.

```markdown
## Budgeted Graph Orchestration

For every non-trivial task, the main thread is the orchestrator. Before mutation it must classify the task as S/M/L/XL, consult Graphify when a project graph exists, propose an execution stage sequence, and ask the human which stages to run. It must wait for that approval.

After approval, delegate only bounded task capsules with explicit file ownership, deterministic acceptance conditions, tool/retry budgets, and minimal inherited conversation. Parallel writers use separate worktrees when practical. Workers do not merge, push, publish, alter acceptance criteria, or cross ownership boundaries. The main orchestrator integrates; an independent read-only judge verifies; the human owns final acceptance and every external action.

Use the `budgeted-graph-orchestration` skill for the full protocol. Trivial one-step work may stay single-agent but still requires proportionate verification.
```

## 11. 플러그인 검증 및 설치

```powershell
$pluginRoot = "$env:USERPROFILE\plugins\budgeted-graph-orchestrator"
$pluginCreator = "$env:USERPROFILE\.codex\skills\.system\plugin-creator"
$skillCreator = "$env:USERPROFILE\.codex\skills\.system\skill-creator"

py -3.12 "$skillCreator\scripts\quick_validate.py" `
  "$pluginRoot\skills\budgeted-graph-orchestration"

py -3.12 "$pluginCreator\scripts\validate_plugin.py" $pluginRoot

codex plugin add budgeted-graph-orchestrator@personal
codex plugin list | Select-String 'budgeted-graph-orchestrator'
```

정상 상태:

```text
budgeted-graph-orchestrator@personal  installed, enabled  0.1.0
```

## 12. 설치 후 smoke test

Codex를 완전히 재시작한 뒤 새 세션에서 다음을 입력한다.

```text
이 저장소에 로그인 기능을 추가하려고 해. 아직 파일은 수정하지 말고 작업을 분류하고 진행 단계를 제안해줘.
```

통과 조건:

- Main Orchestrator가 S/M/L/XL 중 하나로 분류한다.
- Graphify 그래프 존재 여부를 확인한다.
- 인간에게 A/B/C 단계 선택을 요청한다.
- 승인 전 파일을 수정하지 않는다.
- 승인 후 Task Capsule과 소유권을 정의한다.
- Worker와 Judge가 분리된다.
- dependency가 있는 작업은 outer DAG로 표현하고 cycle과 병렬 write 충돌을 거부한다.
- 각 node의 retry가 bounded이며 검증 결과는 Judge 역할만 확정한다.
- human gate는 인간 역할만 통과시킬 수 있다.
- Mermaid 실행 그래프를 생성하고 Graphify project graph에는 runtime event를 쓰지 않는다.

Execution graph runtime smoke test:

```powershell
$pluginRoot = "$env:USERPROFILE\plugins\budgeted-graph-orchestrator"
Set-Location $pluginRoot
node --check scripts/orchestrator-graph.mjs
node scripts/orchestrator-graph.test.mjs
```

테스트는 valid DAG, cycle/missing dependency, 병렬 ownership 충돌, ready set/join, 상태 전이, retry escalation, human gate, 독립 Judge 강제, immutable acceptance, checkpoint/event audit 및 deterministic Mermaid 출력을 포함해야 한다.

Graphify smoke test:

```powershell
Set-Location <PROJECT_ROOT>
py -3.12 -m graphify extract . --code-only --no-cluster
```

프로젝트의 Graphify 스킬 전체 파이프라인을 사용하는 경우 해당 스킬 지침에 따라 `graphify-out/graph.json`, `GRAPH_REPORT.md`, HTML 출력을 생성한다.

## 13. 일상 사용법

비단순 작업 요청 후 Main Orchestrator가 다음 선택지를 제시해야 한다.

```text
A. 조사·계획만
B. 구현과 로컬 검증까지 (추천)
C. 통합 검증 및 전달물까지
```

권장 기본값:

- 질문·설명·읽기 전용 조사: 단계 승인 없이 진행 가능
- 작은 변경: B
- 복합 변경: 먼저 A, 계획 확인 후 B 또는 C
- XL·보안·파괴적 변경: 단계별 인간 승인
- push/merge/publish: 항상 별도 승인

## 14. 현재 알려진 제한

1. 에이전트별 실제 context-window 크기는 하드 제한되지 않는다.
2. 도구 호출 예산은 현재 오케스트레이터 규약이며 별도 runtime counter는 아직 없다.
3. 개인 플러그인 manifest validator가 `hooks` 필드를 거부해 세션 훅은 연결하지 않았다.
4. controller는 선언된 exact `writeFiles` 충돌을 검증하지만 실제 filesystem write를 intercept하지는 않는다.
5. 한 run의 동시 controller process는 지원하지 않는다. 병렬 worker의 전이는 Main Orchestrator 하나를 통해 기록한다.
6. event hash chain은 변조 탐지 근거이며 서명된 authenticity proof는 아니다.
7. plugin cachebuster·재설치 전에는 실행 중인 기존 Codex thread가 갱신된 스킬을 자동 재로딩하지 않는다.
8. Graphify CLI PATH 변경은 이미 실행 중인 Codex 프로세스에 반영되지 않으므로 재시작이 필요하다.

현재 구성은 실행 DAG와 bounded loop를 결정론적으로 제어하지만, 도구 호출과 실제 filesystem 권한까지 가로채는 완전한 sandbox controller는 아니다.

## 15. 다음 완결성 단계

완전한 실행 제어기로 발전시키려면 다음 순서로 구현한다.

1. 도구 호출 Budget Controller와 강제 counter
2. 실제 filesystem ownership interceptor
3. Writer별 자동 worktree 생성·정리
4. agent dispatcher와 독립 Judge runner의 runtime 연결
5. Graphify freshness 및 impact gate 자동화
6. 다중 controller lock 또는 transaction protocol
7. 서명된 audit log, checkpoint snapshot 및 rollback
8. 실제 Codex multi-agent 통합 smoke test

## 16. 제거 및 복구

플러그인 제거:

```powershell
codex plugin remove budgeted-graph-orchestrator@personal
```

이후 다음 항목을 `_gc_trash` 같은 복구 가능한 위치로 이동한다.

```text
%USERPROFILE%\plugins\budgeted-graph-orchestrator
%USERPROFILE%\.codex\agents\budget-explorer.toml
%USERPROFILE%\.codex\agents\budget-worker.toml
%USERPROFILE%\.codex\agents\budget-integrator.toml
%USERPROFILE%\.codex\agents\budget-judge.toml
```

`config.toml`의 `[agents.budget_*]` 네 블록과 `AGENTS.md`의 `Budgeted Graph Orchestration` 절을 제거하거나 설치 전 백업으로 복원한다. hard delete 전에 새 Codex 세션이 정상 시작하는지 확인한다.

LazyCodex 제거:

```powershell
npx -y lazycodex-ai@4.19.4 uninstall
```

Graphify 제거:

```powershell
py -3.12 -m graphify codex uninstall
py -3.12 -m pip uninstall graphifyy
```

## 17. 최종 검증 체크리스트

- [ ] Codex가 정상 시작한다.
- [ ] OmO가 installed/enabled 상태다.
- [ ] Budgeted Graph Orchestrator가 installed/enabled 상태다.
- [ ] grill-me, grilling, graphify가 다음 새 세션에서 보인다.
- [ ] ECC DAILY 핵심 스킬이 `.claude` 심볼릭 링크가 아닌 Codex 독립 복사본이다.
- [ ] Superpowers는 선별한 세 스킬만 기본 활성화되어 있다.
- [ ] `subagent-driven-development`, `dispatching-parallel-agents`, `using-superpowers`가 상위 오케스트레이터를 우회하지 않는다.
- [ ] LazyCodex 26개 스킬은 개별 복사본이 아니라 OmO 플러그인에서 제공된다.
- [ ] OpenAI Primary 및 Curated 스킬은 캐시 복사 없이 런타임이 관리한다.
- [ ] Orca가 없는 환경에서는 Orca 전용 스킬을 필수 설치로 취급하지 않는다.
- [ ] DAILY/LIBRARY/충돌 비활성 분류가 새 PC에서도 유지된다.
- [ ] 직접 활성, 플러그인 활성, available, cache-only 숫자를 혼동하지 않는다.
- [ ] “전체 500개 이상” marketplace를 일괄 활성화하지 않는다.
- [ ] 사용하는 Codex App/Orca/CLI 각각에서 개인 플러그인 상태를 확인한다.
- [ ] 네 에이전트 TOML이 파싱된다.
- [ ] `config.toml`에 네 역할이 등록되어 있다.
- [ ] 비단순 작업에서 인간 단계 게이트가 작동한다.
- [ ] 승인 전 mutation이 없다.
- [ ] Worker와 Judge가 분리된다.
- [ ] 실행 DAG가 cycle과 missing dependency를 거부한다.
- [ ] 병렬 가능한 node의 write ownership 충돌을 거부하고 join은 모든 predecessor 성공을 기다린다.
- [ ] node-local retry cap 초과가 `ESCALATED`로 전이된다.
- [ ] `VERIFYING → SUCCEEDED/RETRYING`은 독립 Judge 역할만 수행한다.
- [ ] human gate는 명시적 인간 역할만 통과시킨다.
- [ ] acceptance와 dependency가 init 이후 immutable이며 event/checkpoint가 감사 가능하다.
- [ ] Mermaid 실행 그래프가 deterministic하게 생성되고 Graphify project graph와 분리된다.
- [ ] 외부 행동은 별도 승인을 요구한다.
- [ ] 인증정보와 개인키가 백업·Git에 포함되지 않았다.

---

이 문서를 변경할 때는 버전 표, 설치 명령, 실제 파일 본문, 알려진 제한 및 제거 절차를 함께 갱신한다. 문서와 설치 상태가 다르면 실제 검증된 설치 상태를 우선하고 차이를 기록한다.
