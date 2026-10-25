/**
 * 높은뜻안성교회 회의록 — Apps Script 중계 서버
 * 역할: 로그인 검증 · Claude 호출 · Firestore 읽기/쓰기 · 드라이브 업로드
 *
 * 스크립트 속성(프로젝트 설정 > 스크립트 속성)에 다음을 넣어야 합니다.
 *   APP_ID            공용 아이디 (예: GW)
 *   APP_PASSWORD      공용 비밀번호 (예: 1003)
 *   CLAUDE_API_KEY    Anthropic API 키
 *   CLAUDE_MODEL      (선택) 기본 claude-sonnet-5-5. 비용을 줄일 때 claude-haiku-5-5
 *   FIREBASE_PROJECT  (선택) 기본 meeting-minutes-6ccd2
 *   COLLECTION        (선택) 기본 meeting-minutes
 *   DRIVE_FOLDER_ID   (선택) 사진·자료 보관 최상위 폴더 ID. 없으면 '회의록자료' 폴더를 자동 생성
 *
 * 배포: GitHub Actions(.github/workflows/apps-script.yml)가 저장소의 이 폴더를 push·기존 배포 갱신.
 *       실행 주체·액세스는 appsscript.json의 webapp 설정(나 / 모든 사용자)을 따른다.
 */

const PROPS = PropertiesService.getScriptProperties();
const CFG = {
  appId: PROPS.getProperty('APP_ID') || 'GW',
  appPassword: PROPS.getProperty('APP_PASSWORD') || '',
  claudeKey: PROPS.getProperty('CLAUDE_API_KEY') || '',
  claudeModel: PROPS.getProperty('CLAUDE_MODEL') || 'claude-sonnet-5-5',
  project: PROPS.getProperty('FIREBASE_PROJECT') || 'meeting-minutes-6ccd2',
  collection: PROPS.getProperty('COLLECTION') || 'meeting-minutes',
  driveFolderId: PROPS.getProperty('DRIVE_FOLDER_ID') || '',
  recentForMatch: 30,
};

// ───────────────────────────── 진입점 ─────────────────────────────

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents || '{}');
  } catch (err) {
    return json_({ ok: false, error: '잘못된 요청 형식' });
  }
  try {
    const action = body.action;
    if (action === 'login') return json_(login_(body));
    if (!checkToken_(body.token)) return json_({ ok: false, error: '로그인이 필요합니다', code: 'AUTH' });

    switch (action) {
      case 'list':    return json_({ ok: true, items: listDocs_(body.limit || 200) });
      case 'get':     return json_({ ok: true, item: getDoc_(body.id) });
      case 'analyze': return json_({ ok: true, result: analyze_(body) });
      case 'bulletize': return json_({ ok: true, speakers: bulletize_(body) });
      case 'reanalyze': return json_({ ok: true, item: reanalyze_(body) });
      case 'save':    return json_({ ok: true, id: saveDoc_(body) });
      case 'update':  return json_({ ok: true, id: updateDoc_(body) });
      case 'delete':  deleteDoc_(body.id); return json_({ ok: true });
      default:        return json_({ ok: false, error: '알 수 없는 요청: ' + action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return json_({ ok: true, service: 'meeting-minutes', model: CFG.claudeModel });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ───────────────────────────── 인증 ─────────────────────────────

function login_(body) {
  if (!CFG.appPassword) return { ok: false, error: '서버에 APP_PASSWORD가 설정되지 않았습니다' };
  if (String(body.id || '').trim() !== CFG.appId || String(body.pass || '') !== CFG.appPassword) {
    return { ok: false, error: '아이디 또는 비밀번호가 틀립니다' };
  }
  return { ok: true, token: makeToken_() };
}

function makeToken_() {
  const raw = Utilities.computeHmacSha256Signature(CFG.appId + '|' + CFG.appPassword, 'meeting-minutes-v1');
  return Utilities.base64EncodeWebSafe(raw);
}

function checkToken_(token) {
  return !!token && token === makeToken_();
}

// ───────────────────────────── Firestore ─────────────────────────────

function fsBase_() {
  return 'https://firestore.googleapis.com/v1/projects/' + CFG.project + '/databases/(default)/documents';
}

function fsFetch_(url, method, payload) {
  const res = UrlFetchApp.fetch(url, {
    method: method || 'get',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: payload ? JSON.stringify(payload) : undefined,
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 300) throw new Error('Firestore ' + code + ': ' + text.slice(0, 300));
  return text ? JSON.parse(text) : {};
}

// JS 값 → Firestore 값
function toFs_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs_) } };
  if (typeof v === 'object') {
    const fields = {};
    Object.keys(v).forEach(k => { fields[k] = toFs_(v[k]); });
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

// Firestore 값 → JS 값
function fromFs_(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs_);
  if ('mapValue' in v) {
    const out = {};
    const f = v.mapValue.fields || {};
    Object.keys(f).forEach(k => { out[k] = fromFs_(f[k]); });
    return out;
  }
  return null;
}

function docToObj_(d) {
  const obj = fromFs_({ mapValue: { fields: d.fields || {} } }) || {};
  obj.id = d.name.split('/').pop();
  return obj;
}

function listDocs_(limit) {
  const q = {
    structuredQuery: {
      from: [{ collectionId: CFG.collection }],
      orderBy: [{ field: { fieldPath: 'date' }, direction: 'DESCENDING' }],
      limit: limit,
    },
  };
  const rows = fsFetch_(fsBase_() + ':runQuery', 'post', q);
  return rows.filter(r => r.document).map(r => {
    const o = docToObj_(r.document);
    delete o.rawText; // 목록에서는 원문을 내려보내지 않음
    delete o.prevVersion;
    return o;
  });
}

function getDoc_(id) {
  if (!id) throw new Error('id가 없습니다');
  return docToObj_(fsFetch_(fsBase_() + '/' + CFG.collection + '/' + encodeURIComponent(id)));
}

function createDoc_(obj) {
  const res = fsFetch_(fsBase_() + '/' + CFG.collection, 'post', { fields: toFs_(obj).mapValue.fields });
  return res.name.split('/').pop();
}

function patchDoc_(id, partial) {
  const mask = Object.keys(partial).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const url = fsBase_() + '/' + CFG.collection + '/' + encodeURIComponent(id) + '?' + mask;
  return fsFetch_(url, 'patch', { fields: toFs_(partial).mapValue.fields });
}

function deleteDoc_(id) {
  if (!id) throw new Error('id가 없습니다');
  // 양방향 참조 정리
  const doc = getDoc_(id);
  (doc.related || []).forEach(rid => {
    try {
      const other = getDoc_(rid);
      patchDoc_(rid, { related: (other.related || []).filter(x => x !== id) });
    } catch (e) { /* 이미 삭제된 문서는 무시 */ }
  });
  fsFetch_(fsBase_() + '/' + CFG.collection + '/' + encodeURIComponent(id), 'delete');
}

// ───────────────────────────── 저장 / 수정 ─────────────────────────────

function normalizeDoc_(d) {
  const arr = v => Array.isArray(v) ? v.map(x => typeof x === 'string' ? x.trim() : x).filter(x => x !== '' && x !== null) : [];
  return {
    title: String(d.title || '').trim() || '제목 없음',
    date: String(d.date || '').slice(0, 10),
    place: String(d.place || '').trim(),
    attendees: arr(d.attendees),
    recorder: String(d.recorder || '').trim(),
    // 본문 4단 (샘플 양식): 개인별 발언 → 주제별 → 종합 제안 → 확인 필요
    speakers: arr(d.speakers).map(x => typeof x === 'string' ? { speaker: '', text: x } : { speaker: String(x.speaker || ''), text: String(x.text || '') }).filter(x => x.speaker || x.text),
    topics: arr(d.topics).map(x => typeof x === 'string' ? { title: x, items: [] } : { title: String(x.title || ''), items: arr(x.items).map(String) }).filter(x => x.title || x.items.length),
    proposals: arr(d.proposals).map(x => typeof x === 'string' ? { item: x, action: '' } : { item: String(x.item || ''), action: String(x.action || '') }).filter(x => x.item || x.action),
    checks: arr(d.checks).map(x => typeof x === 'string' ? x : String(x.text || '')).filter(Boolean),
    // v2.1: 첨부 자료(유인물·PDF·PPT 등) 내용 요약 — 회의록 5단
    materials: arr(d.materials).map(x => ({ title: String(x.title || ''), source: String(x.source || ''), items: arr(x.items).map(String) })).filter(x => x.title || x.items.length),
    summary: String(d.summary || '').trim(),
    keywords: arr(d.keywords),
    related: arr(d.related),
    attachments: Array.isArray(d.attachments) ? d.attachments : [],
    rawText: String(d.rawText || ''),
  };
}

function saveDoc_(body) {
  const doc = normalizeDoc_(body.doc || {});
  const now = new Date();
  doc.createdAt = now;
  doc.updatedAt = now;
  const id = createDoc_(doc);

  // 사진 업로드 (저장 뒤 문서 ID 폴더에)
  if (Array.isArray(body.images) && body.images.length) {
    const uploaded = uploadImages_(doc.date, id, body.images);
    const attachments = (doc.attachments || []).concat(uploaded);
    patchDoc_(id, { attachments });
  }

  // 관련 회의록 양방향 연결
  linkRelated_(id, doc.related, []);
  return id;
}

function updateDoc_(body) {
  const id = body.id;
  if (!id) throw new Error('id가 없습니다');
  const before = getDoc_(id);
  const doc = normalizeDoc_(Object.assign({}, before, body.doc || {}));
  doc.updatedAt = new Date();

  // v2.3: 수정 화면에서 뺀 첨부는 드라이브에서도 휴지통으로(30일 안에 드라이브에서 복구 가능)
  if (body.doc && Array.isArray(body.doc.attachments)) {
    const keep = body.doc.attachments.map(a => a && a.driveFileId).filter(Boolean);
    (before.attachments || []).forEach(a => {
      if (a && a.driveFileId && keep.indexOf(a.driveFileId) < 0) {
        try { DriveApp.getFileById(a.driveFileId).setTrashed(true); } catch (e) { /* 이미 지워진 파일은 무시 */ }
      }
    });
  }
  if (Array.isArray(body.images) && body.images.length) {
    doc.attachments = (doc.attachments || []).concat(uploadImages_(doc.date, id, body.images));
  }
  delete doc.createdAt;
  patchDoc_(id, doc);
  linkRelated_(id, doc.related, before.related || []);
  return id;
}

function linkRelated_(id, nowRelated, beforeRelated) {
  const added = nowRelated.filter(r => beforeRelated.indexOf(r) < 0);
  const removed = beforeRelated.filter(r => nowRelated.indexOf(r) < 0);
  added.forEach(rid => {
    try {
      const o = getDoc_(rid);
      const rel = o.related || [];
      if (rel.indexOf(id) < 0) patchDoc_(rid, { related: rel.concat([id]) });
    } catch (e) { /* 무시 */ }
  });
  removed.forEach(rid => {
    try {
      const o = getDoc_(rid);
      patchDoc_(rid, { related: (o.related || []).filter(x => x !== id) });
    } catch (e) { /* 무시 */ }
  });
}

// ───────────────────────────── 드라이브 ─────────────────────────────

function rootFolder_() {
  if (CFG.driveFolderId) return DriveApp.getFolderById(CFG.driveFolderId);
  const it = DriveApp.getFoldersByName('회의록자료');
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder('회의록자료');
  PROPS.setProperty('DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

function subFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

// v2.1: 사진뿐 아니라 PDF·PPTX·DOCX·HWPX 원본도 받는다(kind: image|pdf|doc).
// 원본이 너무 커서 프런트가 data를 비워 보낸 문서는 파일 없이 추출 텍스트만 남긴다.
// Firestore 문서 1MB 한도 때문에 추출 텍스트는 6만 자에서 자른다.
const MAX_EXTRACT = 60000;
function uploadImages_(date, docId, images) {
  const year = (date || '').slice(0, 4) || String(new Date().getFullYear());
  let folder = null;
  return images.map((img, i) => {
    const kind = img.kind === 'pdf' || img.kind === 'doc' ? img.kind : 'image';
    const name = img.name || ('file-' + (i + 1) + (kind === 'image' ? '.jpg' : ''));
    const out = {
      name: name,
      kind: kind,
      type: img.type === 'handout' ? 'handout' : 'photo',
      extractedText: String(img.extractedText || '').slice(0, MAX_EXTRACT),
    };
    if (img.data) {
      if (!folder) folder = subFolder_(subFolder_(rootFolder_(), year), docId);
      const bytes = Utilities.base64Decode(img.data);
      const file = folder.createFile(Utilities.newBlob(bytes, img.mime || 'application/octet-stream', name));
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      out.driveFileId = file.getId();
      out.url = 'https://drive.google.com/file/d/' + file.getId() + '/view';
      out.thumb = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1200';
    }
    return out;
  });
}

// ───────────────────────────── Claude ─────────────────────────────

const SYSTEM_PROMPT = [
  '당신은 한국어 회의록 정리 도우미입니다. 스마트폰 음성 변환으로 만든 회의 채록문을 받아, 아래 4단 구성의 회의록 JSON을 만듭니다.',
  '채록문은 "발화자 1 (00:36)" 같은 줄로 발화자가 구분되어 있습니다.',
  '',
  '공통 규칙:',
  '1. 채록문에 있는 내용만 쓰고 추측으로 채우지 않는다. 없는 항목은 빈 배열로 둔다.',
  '2. 발화자 이름은 추정하지 않는다. 채록문의 라벨("발화자 1", "발화자 2"…)을 그대로 쓴다. 자기소개가 있어도 이름으로 바꾸지 않는다.',
  '3. 음성 변환 오타로 보이는 고유명사(사람·장소·단체·프로그램 이름)는 가장 그럴듯한 표기로 쓰되 뒤에 [?]를 붙이고, checks에도 적는다.',
  '4. 문체: 평서문, 존대 없이 개조식. "~함", "~필요", "~제안" 식으로 끝맺는다. 같은 말 반복·추임새·잡담은 뺀다.',
  '5. 채록문에 나온 숫자·날짜·금액·인원·장소·대안·찬반 이유 같은 구체 내용은 빠뜨리지 않는다.',
  '',
  '구성:',
  'A. speakers (개인별 발언 정리): 발화자마다 한 항목. speaker는 라벨 그대로("발화자 3"), text에는 그 사람이 회의 전체에서 말한 내용을 개조식으로 요약한다.',
  '   - text는 한 줄에 한 내용인 개조식 줄들을 줄바꿈(\\n)으로 이어 붙인 문자열. 줄 앞에 •, -, 번호 같은 기호는 붙이지 않는다. 각 줄은 "~함", "~제안", "~필요"처럼 끝맺는다.',
  '   - 주장·제안·근거·구체 수치를 담고, 여러 주제를 말했으면 주제 순서대로 줄을 쓴다. 긴 발언자는 5~12줄, 짧은 발언자는 1~3줄.',
  '   - 진행자(보통 발화자 1)는 진행 멘트·순서 안내는 빼고 내용 있는 발언만 요약한다.',
  '   - 맞장구·대답("네", "아 그거구나")만 한 발화자는 넣지 않는다.',
  '   - 발화자 번호 순으로 정렬한다.',
  'B. topics (주제별 정리): 회의 내용을 주제로 묶어 4~10개. title은 "팀 편성·연령차"처럼 짧은 명사구.',
  '   - items는 한 줄짜리 문장 배열. 각 줄 끝에 출처를 "(발화자 3)" 형식으로 붙인다. 여럿이 같은 말을 했으면 "(발화자 1, 3)".',
  '   - 그 주제에서 결론·공통 제안이 나왔으면 마지막 줄을 "→ "로 시작해 적는다. 예: "→ 공통 제안: 저학년/고학년 분리 편성"',
  '   - 같은 사실을 speakers에 썼더라도 topics에 다시 쓴다(보는 목적이 다름).',
  'C. proposals (종합 제안): 회의에서 나온 결정·제안·다음 할 일을 표 형식으로. item은 짧은 명사구(예: "학년별 분리 편성"), action은 구체 실행 내용(담당·기한·수치가 있으면 포함). 보통 3~8개. 회의에서 안 나온 것을 지어내지 않는다.',
  'D. checks (확인이 필요한 사항): 음성 변환 판독이 불확실해 추정으로 적은 부분. 어느 발화자의 어떤 말인지 짚어서 한 줄씩. 예: "발화자 5의 \'다돌 돌봄센터\'가 맞는 명칭인지 확인 필요". 없으면 빈 배열.',
  '',
  'E. materials (첨부 자료 내용): 회의에 첨부된 자료([자료 N]으로 표시된 유인물 사진·PDF·발표 슬라이드·문서)마다 한 항목.',
  '   - index는 자료 번호 N, title은 자료 제목(자료 안의 제목, 없으면 내용을 나타내는 짧은 명사구).',
  '   - items는 자료의 핵심 내용을 한 줄씩 6~20줄. 일정·금액·인원·장소·담당·안건·결정 요청 사항 같은 숫자와 고유명사는 빠뜨리지 않는다. 표는 핵심 행을 "항목: 값" 형태로 옮긴다.',
  '   - 슬라이드 자료는 흐름 순서대로 정리하고, 필요하면 줄 앞에 "[슬라이드 3]"처럼 위치를 붙인다. 발표자 메모도 내용이 있으면 반영한다.',
  '   - 자료 내용이 회의 발언과 이어지면 topics·proposals에도 반영하고, 그 줄 끝 출처에 "(자료 N)"을 붙인다. 예: "(발화자 2, 자료 1)".',
  '   - 자료가 없으면 빈 배열.',
  '',
  '그 밖의 항목:',
  '6. 유인물 사진(이미지 자료)은 본문 텍스트를 그대로 옮기고 표는 줄 단위로 정리해 handoutText에 넣는다(index는 자료 번호). PDF·슬라이드·문서 자료는 handoutText에 넣지 않는다.',
  '7. summary는 회의 전체를 한 문장(60자 이내)으로. keywords는 핵심어 5~10개(단체명·행사명·안건명 위주).',
  '8. date·place·attendees는 채록문이나 유인물에서 확인되는 경우에만 채우고, 사용자가 준 값이 있으면 그 값을 우선한다.',
  '9. recentMeetings 목록이 주어지면, 이번 회의의 제안·주제와 이어지는 과거 회의만 relatedCandidates에 넣고 reason에 근거를 한 줄 적는다. 관련 없으면 빈 배열.',
  '10. 출력은 JSON 하나만. 설명·코드펜스 없이 JSON 객체만 출력한다.',
  '',
  '출력 스키마:',
  '{"date":"YYYY-MM-DD 또는 빈 문자열","place":"","attendees":[],"speakers":[{"speaker":"발화자 1","text":""}],"topics":[{"title":"","items":[""]}],"proposals":[{"item":"","action":""}],"checks":[""],"materials":[{"index":1,"title":"","items":[""]}],"summary":"","keywords":[],"handoutText":[{"index":1,"text":""}],"relatedCandidates":[{"id":"","reason":""}]}',
].join('\n');

function analyze_(body) {
  const text = String(body.text || '').trim();
  if (!text && !(body.images || []).length) throw new Error('채록문이 비어 있습니다');
  const handouts = (body.images || []).filter(img => img.type === 'handout');
  return analyzeCore_(text, body.meta || {}, handouts, recentForMatch_());
}

// v2.1: 자료 종류별로 Claude에 넘긴다 — 사진은 image, PDF는 document(그림·표까지 읽음),
//       PPTX·DOCX·HWPX는 브라우저에서 뽑은 텍스트(extractedText). 번호는 1부터, handouts 순서.
// v2.6: 새 회의록(analyze_)과 저장된 회의록 다시 정리(reanalyze_)가 함께 쓴다
function analyzeCore_(text, meta, handouts, recent) {
  if (!CFG.claudeKey) throw new Error('서버에 CLAUDE_API_KEY가 설정되지 않았습니다');
  const userParts = [];
  handouts.forEach((img, i) => {
    const label = '[자료 ' + (i + 1) + '] ' + (img.name || '');
    if (img.kind === 'pdf' && img.data) {
      userParts.push({ type: 'text', text: label + ' (PDF)' });
      userParts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: img.data }, title: img.name || ('자료 ' + (i + 1)) });
    } else if (img.kind === 'doc') {
      userParts.push({ type: 'text', text: label + ' (슬라이드·문서에서 뽑은 텍스트)\n' + String(img.extractedText || '(텍스트 없음)').slice(0, MAX_EXTRACT) });
    } else if (img.data) {
      userParts.push({ type: 'text', text: label + ' (유인물 사진)' });
      userParts.push({ type: 'image', source: { type: 'base64', media_type: img.mime || 'image/jpeg', data: img.data } });
    } else if (img.extractedText) {
      userParts.push({ type: 'text', text: label + ' (유인물 사진에서 읽은 글자)\n' + String(img.extractedText).slice(0, MAX_EXTRACT) });
    }
  });

  const userText = [
    '## 사용자가 입력한 회의 정보',
    JSON.stringify({ title: meta.title || '', date: meta.date || '', place: meta.place || '', attendees: meta.attendees || [], recorder: meta.recorder || '' }),
    '',
    '## recentMeetings (관련 회의록 후보)',
    JSON.stringify(recent || []),
    '',
    '## 채록문',
    text || '(채록문 없음 — 첨부 자료만 정리)',
  ].join('\n');
  userParts.push({ type: 'text', text: userText });

  let parsed = null, lastErr = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const r = callClaude_(userParts, attempt === 1);
    // 길이 한도에 걸려 잘린 응답은 다시 불러도 또 잘리므로 재시도하지 않는다
    if (r.stop === 'max_tokens') throw new Error('회의 내용이 길어 AI 응답이 중간에 잘렸습니다(출력 한도 ' + MAX_OUT + '토큰). 채록문을 나눠 정리해 주세요.');
    try { parsed = parseJson_(r.text); } catch (e) { lastErr = e; }
  }
  if (!parsed) throw new Error('AI 응답을 해석하지 못했습니다: ' + (lastErr && lastErr.message));

  // 후보 ID 검증 (존재하는 회의록만)
  const ids = (recent || []).map(r => r.id);
  parsed.relatedCandidates = (parsed.relatedCandidates || []).filter(c => c && ids.indexOf(c.id) >= 0)
    .map(c => Object.assign(c, recent.find(r => r.id === c.id)));
  // 자료 번호 → 파일 이름(source)을 붙여 둔다
  parsed.materials = (parsed.materials || []).map(m => {
    const src = handouts[Number(m.index) - 1];
    return { index: Number(m.index) || 0, title: String(m.title || ''), source: src ? (src.name || '') : '', items: (m.items || []).map(String) };
  });
  parsed.model = CFG.claudeModel;
  return parsed;
}

// v2.6: 저장된 회의록을 채록문 + 저장된 첨부(AI 정리 대상)로 다시 정리해 본문 1~5단을 바꾼다.
//       제목·날짜·장소·참석자·기록자·관련 회의록은 그대로. 바꾸기 전 본문은 prevVersion에 한 벌 남긴다.
//       첨부 원본: PPT·문서는 저장된 extractedText, PDF·사진은 드라이브 원본을 다시 읽는다.
const MAX_REREAD = 20 * 1024 * 1024;
function reanalyze_(body) {
  const id = body.id;
  if (!id) throw new Error('id가 없습니다');
  const doc = getDoc_(id);
  const atts = doc.attachments || [];
  const handouts = [];
  atts.forEach((a, ai) => {
    if (!a || a.type !== 'handout') return;
    const h = { name: a.name || '', kind: a.kind || 'image', mime: '', data: '', extractedText: a.extractedText || '', _ai: ai };
    if (h.kind !== 'doc' && a.driveFileId) {
      try {
        const blob = DriveApp.getFileById(a.driveFileId).getBlob();
        if (blob.getBytes().length <= MAX_REREAD) {
          h.mime = h.kind === 'pdf' ? 'application/pdf' : (blob.getContentType() || 'image/jpeg');
          h.data = Utilities.base64Encode(blob.getBytes());
        }
      } catch (e) { /* 드라이브에서 지워진 파일은 extractedText만 */ }
    }
    if (h.kind === 'doc' && !h.extractedText) return;
    if (!h.data && !h.extractedText) return;
    handouts.push(h);
  });
  const text = String(doc.rawText || '').trim();
  if (!text && !handouts.length) throw new Error('다시 정리할 채록문·첨부 자료가 없습니다');

  const meta = { title: doc.title, date: doc.date, place: doc.place, attendees: doc.attendees || [], recorder: doc.recorder };
  const a = analyzeCore_(text, meta, handouts, []);

  // 유인물 사진의 인식 글자를 첨부에 붙여 둔다
  (a.handoutText || []).forEach(t => {
    const h = handouts[(Number(t.index) || 0) - 1];
    if (h && h.kind === 'image' && t.text) atts[h._ai].extractedText = String(t.text).slice(0, MAX_EXTRACT);
  });

  const norm = normalizeDoc_({ speakers: a.speakers, topics: a.topics, proposals: a.proposals, checks: a.checks, materials: a.materials, summary: a.summary, keywords: a.keywords });
  const prev = { savedAt: new Date() };
  ['speakers', 'topics', 'proposals', 'checks', 'materials', 'summary', 'keywords'].forEach(k => { prev[k] = doc[k] === undefined ? null : doc[k]; });
  patchDoc_(id, {
    speakers: norm.speakers, topics: norm.topics, proposals: norm.proposals, checks: norm.checks,
    materials: norm.materials.map(m => ({ title: m.title, source: m.source, items: m.items })),
    summary: norm.summary || doc.summary || '', keywords: norm.keywords.length ? norm.keywords : (doc.keywords || []),
    attachments: atts, prevVersion: prev, reanalyzedAt: new Date(), updatedAt: new Date(),
  });
  return getDoc_(id);
}

function recentForMatch_() {
  try {
    return listDocs_(CFG.recentForMatch).map(d => ({
      id: d.id,
      date: d.date,
      title: d.title,
      summary: d.summary,
      keywords: d.keywords || [],
      proposals: (d.proposals || []).slice(0, 8).map(p => p.item),
      topics: (d.topics || []).map(t => t.title),
    }));
  } catch (e) {
    return [];
  }
}

// 토의사항을 자세히 쓰게 한 뒤(v1.2) 긴 회의(채록문 4만 자대)는 8000토큰에서 잘렸다 → 넉넉히
const MAX_OUT = 20000;

function callClaude_(userParts, strict, system) {
  const payload = {
    model: CFG.claudeModel,
    max_tokens: MAX_OUT,
    system: (system || SYSTEM_PROMPT) + (strict ? '\n\n중요: 반드시 유효한 JSON 객체 하나만 출력하라. 다른 문자는 절대 넣지 마라.' : ''),
    messages: [{ role: 'user', content: userParts }],
  };
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': CFG.claudeKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const data = JSON.parse(res.getContentText() || '{}');
  if (code >= 300) throw new Error('Claude ' + code + ': ' + (data.error && data.error.message || res.getContentText().slice(0, 300)));
  return { text: (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'), stop: data.stop_reason };
}

// v2.2: 이미 저장된 회의록(서술형 발언 정리)을 개조식으로 바꾼다. 채록문은 다시 보내지 않음(비용↓)
const BULLET_PROMPT = [
  '당신은 한국어 회의록 편집자입니다. 발화자별 발언 요약(서술형 문장)을 개조식으로 바꿉니다.',
  '규칙: 1) 내용을 더하거나 빼지 않는다. 숫자·날짜·금액·고유명사·[?] 표시는 그대로 둔다. 2) 한 줄에 한 내용. 3) 평서문, 존대 없이 "~함", "~제안", "~필요"로 끝맺는다. 4) 줄 앞에 기호를 붙이지 않는다. 5) 발화자 라벨은 그대로.',
  '출력은 JSON 하나만: {"speakers":[{"speaker":"발화자 1","lines":["",""]}]}',
].join('\n');
function bulletize_(body) {
  if (!CFG.claudeKey) throw new Error('서버에 CLAUDE_API_KEY가 설정되지 않았습니다');
  const sp = (body.speakers || []).map(x => ({ speaker: String(x.speaker || ''), text: String(x.text || '') })).filter(x => x.text);
  if (!sp.length) throw new Error('바꿀 발언 정리가 없습니다');
  let parsed = null, lastErr = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const r = callClaude_([{ type: 'text', text: JSON.stringify({ speakers: sp }) }], attempt === 1, BULLET_PROMPT);
    if (r.stop === 'max_tokens') throw new Error('발언 정리가 길어 응답이 잘렸습니다');
    try { parsed = parseJson_(r.text); } catch (e) { lastErr = e; }
  }
  if (!parsed) throw new Error('AI 응답을 해석하지 못했습니다: ' + (lastErr && lastErr.message));
  return (parsed.speakers || []).map(x => ({ speaker: String(x.speaker || ''), text: (x.lines || []).map(l => String(l).replace(/^\s*[•\-·]\s*/, '').trim()).filter(Boolean).join('\n') }));
}

function parseJson_(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('JSON 객체를 찾지 못함');
  return JSON.parse(s.slice(a, b + 1));
}

// ───────────────────────────── 점검용 ─────────────────────────────

/** 편집기에서 한 번 실행해 권한 승인 + Firestore 연결 확인 */
function testConnection() {
  Logger.log('모델: ' + CFG.claudeModel + ', 프로젝트: ' + CFG.project + ', 컬렉션: ' + CFG.collection);
  const items = listDocs_(3);
  Logger.log('Firestore 연결 성공. 회의록 ' + items.length + '건 조회');
  Logger.log('드라이브 폴더: ' + rootFolder_().getName());
}
