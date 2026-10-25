# 높은뜻안성교회 회의록

폰에서 변환한 회의 채록문을 붙여넣으면 Claude가 날짜·장소·참석자와 공지·토의사항·추후논의·결정·기타로 정리해 저장하는 웹앱입니다.

- 프런트: `index.html` 단일 파일 (GitHub Pages)
- 중계 서버: `apps-script/Code.gs` (Google Apps Script 웹앱)
- 저장: Firebase `meeting-minutes-6ccd2`(교회 계정) Firestore 컬렉션 `meeting-minutes` + 구글드라이브 `회의록자료` 폴더

## 설치 순서 (처음 1회, 약 20분)

### 1. Apps Script 프로젝트 만들기
1. https://script.google.com → 새 프로젝트 → 이름 `meeting-minutes`
2. 왼쪽 톱니(프로젝트 설정) → **"appsscript.json" 매니페스트 파일 표시** 체크
3. 편집기에서 `Code.gs` 내용을 `apps-script/Code.gs`로 교체, `appsscript.json`을 `apps-script/appsscript.json`으로 교체

### 2. 스크립트 속성 넣기
프로젝트 설정 맨 아래 **스크립트 속성** → 속성 추가

| 속성 | 값 |
| --- | --- |
| `APP_ID` | `GW` |
| `APP_PASSWORD` | `1003` |
| `CLAUDE_API_KEY` | Anthropic 콘솔에서 발급한 키 (`sk-ant-...`) |
| `CLAUDE_MODEL` | (선택) 기본 `claude-haiku-5-5`. 품질 올리려면 `claude-sonnet-5-5` |
| `FIREBASE_PROJECT` | (선택) 기본 `meeting-minutes-6ccd2` |
| `COLLECTION` | (선택) 기본 `meeting-minutes` |

### 3. Firestore 권한 확인
Apps Script는 실행 계정(본인 구글 계정)의 권한으로 Firestore REST API를 호출합니다.
- Firebase 프로젝트 `meeting-minutes-6ccd2`의 소유자/편집자 계정(교회 구글 계정)과 **같은 구글 계정**으로 Apps Script를 만들어야 합니다.
- Google Cloud 콘솔 → 해당 프로젝트 → **API 및 서비스 → 사용 설정된 API**에 `Cloud Firestore API`가 켜져 있어야 합니다(Firebase 프로젝트면 보통 켜져 있음).
- Firestore 보안 규칙은 브라우저가 직접 접근하지 않으므로 전면 차단으로 둬도 됩니다.

### 4. 권한 승인 + 연결 테스트
1. 편집기 상단 함수 선택에서 `testConnection` 선택 → 실행
2. 권한 요청 창 → 계정 선택 → "고급" → "안전하지 않은 페이지로 이동" → 허용
3. 실행 로그에 `Firestore 연결 성공` 과 `드라이브 폴더: 회의록자료` 가 나오면 성공

### 5. 웹앱 배포
1. 오른쪽 위 **배포 → 새 배포** → 유형 **웹 앱**
2. 실행 주체 **나**, 액세스 권한 **모든 사용자** → 배포
3. 나온 웹앱 URL(`https://script.google.com/macros/s/.../exec`) 복사

### 6. index.html에 URL 넣기
`index.html` 87번째 줄 근처:
```js
const API_URL = 'PASTE_YOUR_APPS_SCRIPT_WEBAPP_URL_HERE';
```
→ 복사한 웹앱 URL로 교체 후 커밋.

### 7. GitHub Pages
레포 Settings → Pages → Source `Deploy from a branch`, Branch `main` / `/ (root)` → 저장.
1~2분 뒤 `https://gwanseong1003.github.io/church-meeting/` 에서 접속.

## 사용법
1. 로그인(GW / 1003)
2. **새 회의록** → 제목·날짜·장소·참석자·기록자 입력
3. 폰에서 변환한 채록 텍스트 붙여넣기(또는 .txt 올리기), 유인물·자료 사진 첨부
4. **AI로 정리하기** → 결과 확인·수정 → 저장
5. 상세 화면에서 추후논의 항목을 체크하면 '해결됨' 표시, **미결 추후논의** 메뉴에서 모아보기

## 코드 수정 뒤 반영
- `index.html` 수정 → GitHub 커밋만 하면 Pages에 자동 반영
- `Code.gs` 수정 → Apps Script 편집기에 붙여넣고 **배포 → 배포 관리 → 연필 → 버전: 새 버전 → 배포**. 새 배포를 만들면 URL이 바뀌니 반드시 기존 배포를 수정할 것.

## 비밀번호 변경
스크립트 속성 `APP_PASSWORD`만 바꾸면 됩니다. 기존 로그인은 모두 풀립니다.

## 비용
Claude API만 유료. 1시간 회의 1건당 Haiku 약 10~30원, Sonnet 약 100~200원.
