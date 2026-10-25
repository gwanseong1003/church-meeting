/**
 * AI 회의록 — Apps Script 중계 서버
 * 역할: 로그인 검증 · Claude 호출 · Firestore 읽기/쓰기 · 드라이브 업로드
 *
 * 스크립트 속성(프로젝트 설정 > 스크립트 속성)에 다음을 넣어야 합니다.
 *   APP_ID            공용 아이디 (예: GW)
 *   APP_PASSWORD      공용 비밀번호 (예: 1003)
 *   CLAUDE_API_KEY    Anthropic API 키
 *   CLAUDE_MODEL      (선택) 기본 claude-haiku-5-5. 품질 올릴 때 claude-sonnet-5-5
 *   FIREBASE_PROJECT  (선택) 기본 jeahwan-apps
 *   COLLECTION        (선택) 기본 meeting-minutes
 *   DRIVE_FOLDER_ID   (선택) 사진 보관 최상위 폴더 ID. 없으면 '회의록자료' 폴더를 자동 생성
 *
 * 배포: 웹 앱 > 실행 주체 '나' > 액세스 '모든 사용자'
 */

const PROPS = PropertiesService.getScriptProperties();
const CFG = {
  appId: PROPS.getProperty('APP_ID') || 'GW',
  appPassword: PROPS.getProperty('APP_PASSWORD') || '',
  claudeKey: PROPS.getProperty('CLAUDE_API_KEY') || '',
  claudeModel: PROPS.getProperty('CLAUDE_MODEL') || 'claude-haiku-5-5',
  project: PROPS.getProperty('FIREBASE_PROJECT') || 'jeahwan-apps',
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
      case 'save':    return json_({ ok: true, id: saveDoc_(body) });
      case 'update':  return json_({ ok: true, id: updateDoc_(body) });
      case 'delete':  deleteDoc_(body.id); return json_({ ok: true });
      case 'resolve': return json_({ ok: true, item: resolveFollowup_(body) });
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
    notices: arr(d.notices),
    discussions: arr(d.discussions),
    followups: arr(d.followups).map(f => typeof f === 'string'
      ? { text: f, resolved: false, resolvedBy: '' }
      : { text: String(f.text || ''), resolved: !!f.resolved, resolvedBy: String(f.resolvedBy || '') }),
    decisions: arr(d.decisions),
    etc: arr(d.etc),
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

function resolveFollowup_(body) {
  const doc = getDoc_(body.id);
  const f = doc.followups || [];
  const i = Number(body.index);
  if (!f[i]) throw new Error('해당 추후논의 항목이 없습니다');
  f[i] = { text: f[i].text, resolved: !!body.resolved, resolvedBy: String(body.resolvedBy || '') };
  patchDoc_(body.id, { followups: f, updatedAt: new Date() });
  return getDoc_(body.id);
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

function uploadImages_(date, docId, images) {
  const year = (date || '').slice(0, 4) || String(new Date().getFullYear());
  const folder = subFolder_(subFolder_(rootFolder_(), year), docId);
  return images.map((img, i) => {
    const bytes = Utilities.base64Decode(img.data);
    const name = img.name || ('image-' + (i + 1) + '.jpg');
    const file = folder.createFile(Utilities.newBlob(bytes, img.mime || 'image/jpeg', name));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return {
      driveFileId: file.getId(),
      name: name,
      type: img.type === 'handout' ? 'handout' : 'photo',
      extractedText: String(img.extractedText || ''),
      url: 'https://drive.google.com/file/d/' + file.getId() + '/view',
      thumb: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1200',
    };
  });
}

// ───────────────────────────── Claude ─────────────────────────────

const SYSTEM_PROMPT = [
  '당신은 한국어 회의록 정리 도우미입니다. 스마트폰 음성 변환으로 만든 회의 채록문을 받아 구조화된 회의록 JSON을 만듭니다.',
  '',
  '규칙:',
  '1. 채록문에 있는 내용만 쓰고 추측으로 채우지 않는다. 없는 항목은 빈 배열로 둔다.',
  '2. 발언자는 추정하지 않는다. 채록문에 화자 구분이 없다.',
  '3. 음성 변환 오타로 보이는 고유명사(사람·장소·단체 이름)는 뒤에 [?]를 붙인다.',
  '4. 한 항목이 여러 분류에 걸치면 결정 > 추후논의 > 토의사항 순으로 하나에만 넣는다.',
  '   - notices(공지): 전달·안내 사항. 논의 없이 알린 것.',
  '   - discussions(토의사항): 논의했지만 결정에 이르지 않은 내용. 쟁점과 의견을 한 항목에 묶어 쓴다.',
  '   - followups(추후논의): 다음에 다시 다루기로 한 것, 확인 후 결정하기로 한 것.',
  '   - decisions(결정): 확정된 사항. 담당자·기한이 있으면 포함.',
  '   - etc(기타): 위에 안 들어가는 것.',
  '5. 각 항목은 1~2문장, 평서문, 존대 없이 개조식으로 쓴다. 예: "11월 둘째 주 토요일 리허설 진행, 장소는 강당"',
  '6. 유인물 이미지가 있으면 본문 텍스트를 그대로 옮기고 표는 줄 단위로 정리해 handoutText에 넣는다. 유인물 내용이 회의 내용과 겹치면 회의록 항목에도 반영한다.',
  '7. summary는 회의 전체를 한 문장(60자 이내)으로. keywords는 핵심어 5~10개(단체명·행사명·안건명 위주).',
  '8. date·place·attendees는 채록문이나 유인물에서 확인되는 경우에만 채우고, 사용자가 준 값이 있으면 그 값을 우선한다.',
  '9. recentMeetings 목록이 주어지면, 이번 회의의 추후논의·결정과 이어지는 과거 회의만 relatedCandidates에 넣고 reason에 근거를 한 줄 적는다. 관련 없으면 빈 배열.',
  '10. 출력은 JSON 하나만. 설명·코드펜스 없이 JSON 객체만 출력한다.',
  '',
  '출력 스키마:',
  '{"date":"YYYY-MM-DD 또는 빈 문자열","place":"","attendees":[],"notices":[],"discussions":[],"followups":[],"decisions":[],"etc":[],"summary":"","keywords":[],"handoutText":[{"index":0,"text":""}],"relatedCandidates":[{"id":"","reason":""}]}',
].join('\n');

function analyze_(body) {
  if (!CFG.claudeKey) throw new Error('서버에 CLAUDE_API_KEY가 설정되지 않았습니다');
  const text = String(body.text || '').trim();
  if (!text && !(body.images || []).length) throw new Error('채록문이 비어 있습니다');

  const meta = body.meta || {};
  const recent = recentForMatch_();

  const userParts = [];
  const handouts = (body.images || []).filter(img => img.type === 'handout');
  handouts.forEach((img, i) => {
    userParts.push({ type: 'text', text: '[유인물 이미지 ' + i + ']' });
    userParts.push({ type: 'image', source: { type: 'base64', media_type: img.mime || 'image/jpeg', data: img.data } });
  });

  const userText = [
    '## 사용자가 입력한 회의 정보',
    JSON.stringify({ title: meta.title || '', date: meta.date || '', place: meta.place || '', attendees: meta.attendees || [], recorder: meta.recorder || '' }),
    '',
    '## recentMeetings (관련 회의록 후보)',
    JSON.stringify(recent),
    '',
    '## 채록문',
    text || '(채록문 없음 — 유인물만 정리)',
  ].join('\n');
  userParts.push({ type: 'text', text: userText });

  let parsed = null, lastErr = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const raw = callClaude_(userParts, attempt === 1);
    try { parsed = parseJson_(raw); } catch (e) { lastErr = e; }
  }
  if (!parsed) throw new Error('AI 응답을 해석하지 못했습니다: ' + (lastErr && lastErr.message));

  // 후보 ID 검증 (존재하는 회의록만)
  const ids = recent.map(r => r.id);
  parsed.relatedCandidates = (parsed.relatedCandidates || []).filter(c => c && ids.indexOf(c.id) >= 0)
    .map(c => Object.assign(c, recent.find(r => r.id === c.id)));
  parsed.model = CFG.claudeModel;
  return parsed;
}

function recentForMatch_() {
  try {
    return listDocs_(CFG.recentForMatch).map(d => ({
      id: d.id,
      date: d.date,
      title: d.title,
      summary: d.summary,
      keywords: d.keywords || [],
      openFollowups: (d.followups || []).filter(f => !f.resolved).map(f => f.text),
      decisions: (d.decisions || []).slice(0, 5),
    }));
  } catch (e) {
    return [];
  }
}

function callClaude_(userParts, strict) {
  const payload = {
    model: CFG.claudeModel,
    max_tokens: 8000,
    system: SYSTEM_PROMPT + (strict ? '\n\n중요: 반드시 유효한 JSON 객체 하나만 출력하라. 다른 문자는 절대 넣지 마라.' : ''),
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
  return (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
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
