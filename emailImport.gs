// ============================================================
// emailImport.gs  ─ OTA予約メール自動取り込み
// ============================================================
// 【GASへの追加手順】
//   1. GASエディタで「＋」→「スクリプト」→ファイル名「emailImport」
//   2. このファイルの内容を全部ペースト（CONFIG は不要・コード.gs に既存）
//   3. トリガー設定：processReservationEmails → 時間ベース → 1時間ごと
//
// 【重複エラーが出た場合】
//   addToCalendar / getAvailableCalId / updateRoomType が
//   コード.gs にすでに定義されている場合は、このファイルの
//   同名関数（末尾付近）を削除してください。
// ============================================================

// CONFIG fallback（コード.gsがないプロジェクトでも動作するよう）
if (typeof CONFIG === 'undefined') {
  var CONFIG = {
    SUPABASE_URL: 'https://mtsdhheqddrckksiqlim.supabase.co',
    SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im10c2RoaGVxZGRyY2trc2lxbGltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1OTc5NDgsImV4cCI6MjA4ODE3Mzk0OH0.c18ExSxNHBOani7CN4QAqaerhvpr5ZCYA0GGkUg0mlc'
  };
}

// ============================================================
// メイン：予約メール処理（自動実行用）
// ============================================================
function processReservationEmails() {
  var _startTime = new Date().getTime();
  var _timeLimit = 5 * 60 * 1000; // 5分
  var newQueries = [
    'subject:公式HP予約システム newer_than:3d',
    'subject:楽天トラベル newer_than:3d',
    'subject:じゃらん newer_than:3d',
    'subject:Booking.com newer_than:3d',
    'subject:Agoda newer_than:3d',
    'subject:Yahoo newer_than:3d',
    'subject:一休 newer_than:3d',
    'from:info@489ban.net newer_than:3d',        // 旧公式HP（489ban）
    'from:jalan-yoyakutsutsi@jalan.net newer_than:3d', // じゃらんnet自社サイト予約
    'subject:R-WITH newer_than:3d'  // 旧公式HP（R-WITH）
  ];
  var cancelQueries = [
    'subject:予約キャンセル確認 newer_than:3d',
    'subject:予約取消 newer_than:3d',
    'subject:キャンセル通知 newer_than:3d',
    'subject:CANCELLED newer_than:3d',
    'subject:Cancelled newer_than:3d',
    'subject:cancellation newer_than:3d',
    'subject:予約キャンセル通知 newer_than:3d',
    'subject:ＣＸＬ newer_than:3d',
    'subject:CXL newer_than:3d'
  ];
  for (var q = 0; q < newQueries.length; q++) {
    if (new Date().getTime() - _startTime > _timeLimit) { Logger.log('クエリループ：時間制限に達したため中断'); return; }
    try {
      var threads = GmailApp.search(newQueries[q], 0, 10);
      for (var i = 0; i < threads.length; i++) {
        try {
          var msgs = threads[i].getMessages();
          for (var j = 0; j < msgs.length; j++) {
            try {
              if (new Date().getTime() - _startTime > _timeLimit) { Logger.log('時間制限に達したため処理を中断'); return; }
              var msg = msgs[j];
              var subject = msg.getSubject();
              var fromAddr = msg.getFrom();
              // ── ループ防止：自分（wassa-okinawa.com）からの通知メールはスキップ ──
              if (fromAddr.indexOf('wassa-okinawa.com') !== -1 || subject.indexOf('【要確認】') !== -1) {
                msg.markRead(); continue;
              }
              var body = msg.getPlainBody();
              if (isCancelEmail(subject, body)) { processCancelEmail(subject, body); msg.markRead(); continue; }
              var src = detectSource(subject, body);
              if (src) {
                var data = parseEmail(src, body);
                if (!data.guest_name) {
                  // ── 通知は1メッセージにつき1回のみ ──
                  var _props = PropertiesService.getScriptProperties();
                  var _msgKey = 'notified_' + msg.getId();
                  if (!_props.getProperty(_msgKey)) {
                    GmailApp.sendEmail(
                      'wassa@wassa-okinawa.com',
                      '【要確認】予約メールの取り込み失敗: ' + subject,
                      '以下のメールから予約情報を抽出できませんでした。手動で確認してください。\n\n' +
                      '件名: ' + subject + '\n\n' + body.slice(0, 500)
                    );
                    _props.setProperty(_msgKey, '1');
                  }
                  msg.markRead();
                  continue;
                }
                if (isDuplicate(data.reservation_no, data.check_in, data.guest_name)) { msg.markRead(); continue; }
                if (data.check_in && data.check_out) {
                  if (data.room_type && data.room_type.indexOf('デラックス') !== -1) {
                    data.room_type = 'デラックスツイン';
                  } else {
                    var _calId = getAvailableCalId(data.check_in, data.check_out);
                    data.room_type = (_calId === CONFIG.CAL1) ? 'スーペリアツイン01' : 'スーペリアツイン02';
                  }
                }
                saveToSupabase(data);
                // addToCalendar(data); // カレンダー連携を停止
              }
              msg.markRead();
            } catch(msgErr) { Logger.log('メッセージ処理エラー [' + newQueries[q] + ']: ' + msgErr); }
          }
        } catch(threadErr) { Logger.log('スレッド処理エラー [' + newQueries[q] + ']: ' + threadErr); }
      }
    } catch(queryErr) { Logger.log('クエリエラー [' + newQueries[q] + ']: ' + queryErr); }
  }
  for (var q2 = 0; q2 < cancelQueries.length; q2++) {
    if (new Date().getTime() - _startTime > _timeLimit) { Logger.log('キャンセルループ：時間制限に達したため中断'); return; }
    try {
      var cThreads = GmailApp.search(cancelQueries[q2], 0, 10);
      for (var i2 = 0; i2 < cThreads.length; i2++) {
        try {
          var cMsgs = cThreads[i2].getMessages();
          for (var j2 = 0; j2 < cMsgs.length; j2++) {
            try {
              var _cFrom = cMsgs[j2].getFrom();
              var _cSubj = cMsgs[j2].getSubject();
              if (_cFrom.indexOf('wassa-okinawa.com') !== -1 || _cSubj.indexOf('【要確認】') !== -1) {
                cMsgs[j2].markRead(); continue;
              }
              processCancelEmail(_cSubj, cMsgs[j2].getPlainBody());
              cMsgs[j2].markRead();
            } catch(e) { Logger.log('キャンセルメッセージエラー [' + cancelQueries[q2] + ']: ' + e); }
          }
        } catch(e) { Logger.log('キャンセルスレッドエラー: ' + e); }
      }
    } catch(e) { Logger.log('キャンセルクエリエラー [' + cancelQueries[q2] + ']: ' + e); }
  }
}

// ============================================================
// 過去メール一括取り込み（手動実行用）
// ============================================================
function importPastEmails() {
  var today = new Date(); today.setHours(0,0,0,0);
  var yearEnd = new Date('2026-12-31');
  var queries = ['subject:公式HP予約システム','subject:楽天トラベル','subject:じゃらん',
                 'subject:Booking.com','subject:Agoda','subject:Yahoo','subject:一休'];
  var imported = 0, skipped = 0, noDate = 0;
  for (var q = 0; q < queries.length; q++) {
    var threads = GmailApp.search(queries[q], 0, 100);
    Logger.log(queries[q] + ': ' + threads.length + ' スレッド');
    for (var i = 0; i < threads.length; i++) {
      var msgs = threads[i].getMessages();
      for (var j = 0; j < msgs.length; j++) {
        var subject = msgs[j].getSubject();
        var body = msgs[j].getPlainBody();
        if (isCancelEmail(subject, body)) continue;
        var src = detectSource(subject);
        if (!src) continue;
        var data = parseEmail(src, body);
        if (!data.guest_name) { skipped++; continue; }
        if (!data.check_in) { noDate++; continue; }
        var ciDate = new Date(data.check_in); ciDate.setHours(0,0,0,0);
        if (ciDate < today || ciDate > yearEnd) { skipped++; continue; }
        if (isDuplicate(data.reservation_no, data.check_in, data.guest_name)) { skipped++; continue; }
        Logger.log('IMPORT: ' + data.guest_name + ' CI:' + data.check_in);
        if (data.check_in && data.check_out) {
          if (data.room_type && data.room_type.indexOf('デラックス') !== -1) {
            data.room_type = 'デラックスツイン';
          } else {
            var _calId2 = getAvailableCalId(data.check_in, data.check_out);
            data.room_type = (_calId2 === CONFIG.CAL1) ? 'スーペリアツイン01' : 'スーペリアツイン02';
          }
        }
        saveToSupabase(data);
        // addToCalendar(data); // カレンダー連携を停止
        imported++;
        Utilities.sleep(500);
      }
    }
  }
  Logger.log('完了: 登録' + imported + '件 / スキップ' + skipped + '件 / CI日なし' + noDate + '件');
}

// ============================================================
// 重複チェック
// ============================================================
function isDuplicate(reservationNo, checkIn, guestName) {
  try {
    var url = reservationNo
      ? CONFIG.SUPABASE_URL + '/rest/v1/reservations?reservation_no=eq.' + encodeURIComponent(reservationNo) + '&select=id'
      : (checkIn && guestName
          ? CONFIG.SUPABASE_URL + '/rest/v1/reservations?check_in=eq.' + checkIn + '&guest_name=eq.' + encodeURIComponent(guestName) + '&select=id'
          : null);
    if (!url) return false;
    var r = UrlFetchApp.fetch(url, {headers:{'apikey':CONFIG.SUPABASE_KEY,'Authorization':'Bearer '+CONFIG.SUPABASE_KEY}, muteHttpExceptions:true});
    if (r.getResponseCode() !== 200) return false;
    return JSON.parse(r.getContentText()).length > 0;
  } catch(e) { return false; }
}

// ============================================================
// キャンセル処理
// ============================================================
function isCancelEmail(subject, body) {
  var sl = subject.toLowerCase();
  return subject.indexOf('キャンセル') !== -1 || subject.indexOf('取消') !== -1 ||
         subject.indexOf('ＣＸＬ') !== -1 || subject.indexOf('CXL') !== -1 ||
         sl.indexOf('cancel') !== -1 || sl.indexOf('cancelled') !== -1 ||
         body.indexOf('予約キャンセル') !== -1;
}

function processCancelEmail(subject, body) {
  var reservationNo = ex(body, '予約番号[\\s\\u3000]*[：:]+[\\s\\u3000]*([^\\n\\s\\u3000]+)');
  if (!reservationNo) reservationNo = ex(body, '予約番号[\\s\\u3000]*：?[\\s\\u3000]*([A-Za-z0-9][A-Za-z0-9\\-]+)');
  if (!reservationNo) reservationNo = ex(subject, '([A-Z]{2}\\d{8,})');
  if (!reservationNo) reservationNo = ex(body, '予約[Nn][Oo][.．]?[\\s\\u3000]*([A-Za-z0-9][A-Za-z0-9\\-]+)');
  if (!reservationNo) reservationNo = ex(body, 'Booking(?:\\.com)? [Nn]umber[:\\s]+([0-9]+)');
  if (!reservationNo) reservationNo = ex(body, 'Reservation [Ii][Dd][:\\s]+([0-9]+)');
  if (!reservationNo) { Logger.log('cancel: 予約番号を抽出できませんでした subject=' + subject); return; }
  Logger.log('キャンセル処理: ' + reservationNo);
  try {
    UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/rest/v1/reservations?reservation_no=eq.' + encodeURIComponent(reservationNo), {
      method:'PATCH',
      headers:{'Content-Type':'application/json','apikey':CONFIG.SUPABASE_KEY,'Authorization':'Bearer '+CONFIG.SUPABASE_KEY,'Prefer':'return=minimal'},
      payload: JSON.stringify({status:'cancelled'})
    });
    Logger.log('キャンセル完了: ' + reservationNo);
  } catch(e) { Logger.log('cancel error: ' + e + ' / ' + reservationNo); }
  try { deleteCalendarEvent(reservationNo); } catch(e) { Logger.log('calendar delete error: ' + e); }
}

function deleteCalendarEvent(reservationNo) {
  var calIds = [CONFIG.CAL1, CONFIG.CAL2, CONFIG.CAL3, CONFIG.CAL_STAFF];
  var now = new Date();
  var past = new Date(now.getFullYear()-1, now.getMonth(), now.getDate());
  var future = new Date(now.getFullYear()+2, now.getMonth(), now.getDate());
  for (var c = 0; c < calIds.length; c++) {
    try {
      var events = CalendarApp.getCalendarById(calIds[c]).getEvents(past, future);
      for (var e = 0; e < events.length; e++) {
        if (events[e].getDescription().indexOf(reservationNo) !== -1) events[e].deleteEvent();
      }
    } catch(err) {}
  }
}

// ============================================================
// ヘルパー
// ============================================================
function detectSource(s) {
  if (s.indexOf('公式HP')   !== -1) return '公式HP';
  if (s.indexOf('一休')     !== -1) return '一休';
  if (s.indexOf('楽天')     !== -1) return '楽天';
  if (s.indexOf('Booking')  !== -1) return 'Booking.com';
  if (s.indexOf('Agoda')    !== -1) return 'Agoda';
  if (s.indexOf('じゃらんnet_予約通知') !== -1) return '公式HP'; // じゃらんnet自社サイト予約
  if (s.indexOf('じゃらん') !== -1) return 'じゃらん';
  if (s.indexOf('Yahoo')    !== -1) return '一休';
  // 旧公式HPシステム
  if (s.indexOf('R-WITH')   !== -1) return '公式HP';  // 旧楽天R-WITHシステム
  if (s.indexOf('予約番')   !== -1) return '公式HP';  // 旧489banシステム
  return null;
}

function ex(t, p) {
  try { var m = t.match(new RegExp(p,'i')); return m ? m[1].trim() : ''; } catch(e) { return ''; }
}

function toYMD(str) {
  if (!str) return null;
  str = str.trim();
  var m;
  m = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');
  m = str.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) return m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');
  var months = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
  m = str.match(/(\d{1,2})-([A-Z][a-z]{2})-(\d{4})/);
  if (m) return m[3]+'-'+(months[m[2]]||'00')+'-'+m[1].padStart(2,'0');
  var mnames = {January:'01',February:'02',March:'03',April:'04',May:'05',June:'06',
                July:'07',August:'08',September:'09',October:'10',November:'11',December:'12'};
  m = str.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/);
  if (m) return m[3]+'-'+mnames[m[1]]+'-'+m[2].padStart(2,'0');
  return null;
}

function calcCheckOut(checkIn, nights) {
  if (!checkIn || !nights) return null;
  try {
    var d = new Date(checkIn);
    d.setDate(d.getDate() + parseInt(nights));
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  } catch(e) { return null; }
}

function toInt(v) { return v ? parseInt(v.toString().replace(/[,\.円\\¥]/g,'')) || 0 : 0; }

// ============================================================
// 顧客検索・新規作成
// ============================================================
// custExtra: {seiKana, meiKana, zip, pref, city, address, email}
function findOrCreateCustomerGAS(guestName, phone, email, custExtra) {
  var h = {
    'apikey': CONFIG.SUPABASE_KEY,
    'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY
  };
  var baseUrl = CONFIG.SUPABASE_URL + '/rest/v1/wassa_customers';

  var parts = (guestName || '').trim().split(/[\s　]+/);
  var sei = parts[0] || '';
  var mei = parts.slice(1).join(' ') || '';

  var ce = custExtra || {};
  var patchH = {'Content-Type':'application/json','apikey':CONFIG.SUPABASE_KEY,'Authorization':'Bearer '+CONFIG.SUPABASE_KEY,'Prefer':'return=minimal'};

  // 既存顧客に不足フィールドをパッチする内部ヘルパー
  function patchCustomerExtra(custId, existing) {
    var patch = {};
    if (ce.seiKana && !existing.sei_kana) patch.sei_kana = ce.seiKana;
    if (ce.meiKana && !existing.mei_kana) patch.mei_kana = ce.meiKana;
    if (ce.zip     && !existing.zip)      patch.zip      = ce.zip;
    if (ce.pref    && !existing.pref)     patch.pref     = ce.pref;
    if (ce.city    && !existing.city)     patch.city     = ce.city;
    if (ce.address && !existing.address)  patch.address  = ce.address;
    if (email      && !existing.email)    patch.email    = email;
    if (phone      && !existing.mobile)   patch.mobile   = phone;
    if (Object.keys(patch).length === 0) return;
    try {
      UrlFetchApp.fetch(baseUrl + '?id=eq.' + custId, {method:'PATCH', headers:patchH, payload:JSON.stringify(patch)});
      Logger.log('顧客補完パッチ: ' + custId + ' ' + JSON.stringify(patch));
    } catch(pe) { Logger.log('顧客パッチエラー: ' + pe); }
  }

  // 1. 電話番号で検索
  if (phone) {
    var tel = phone.replace(/[^\d]/g, '');
    try {
      var r1 = UrlFetchApp.fetch(baseUrl + '?mobile=eq.' + encodeURIComponent(phone) + '&select=id,sei_kana,mei_kana,zip,pref,city,address,email,mobile', {headers: h});
      var res1 = JSON.parse(r1.getContentText());
      if (res1.length > 0) { Logger.log('顧客マッチ(電話): ' + guestName); patchCustomerExtra(res1[0].id, res1[0]); return res1[0].id; }
    } catch(e) {}
    try {
      var r1b = UrlFetchApp.fetch(baseUrl + '?mobile=eq.' + encodeURIComponent(tel) + '&select=id,sei_kana,mei_kana,zip,pref,city,address,email,mobile', {headers: h});
      var res1b = JSON.parse(r1b.getContentText());
      if (res1b.length > 0) { Logger.log('顧客マッチ(電話数字): ' + guestName); patchCustomerExtra(res1b[0].id, res1b[0]); return res1b[0].id; }
    } catch(e) {}
  }

  // 2. メールで検索
  if (email) {
    try {
      var r2 = UrlFetchApp.fetch(baseUrl + '?email=eq.' + encodeURIComponent(email) + '&select=id,sei_kana,mei_kana,zip,pref,city,address,email,mobile', {headers: h});
      var res2 = JSON.parse(r2.getContentText());
      if (res2.length > 0) { Logger.log('顧客マッチ(メール): ' + guestName); patchCustomerExtra(res2[0].id, res2[0]); return res2[0].id; }
    } catch(e) {}
  }

  // 3. 氏名で検索
  if (sei) {
    try {
      var r3 = UrlFetchApp.fetch(baseUrl + '?sei=eq.' + encodeURIComponent(sei) + '&select=id,sei,mei,sei_kana,mei_kana,zip,pref,city,address,email,mobile', {headers: h});
      var res3 = JSON.parse(r3.getContentText());
      var fullName = (sei + mei).replace(/[\s　]/g, '');
      for (var i = 0; i < res3.length; i++) {
        var cName = ((res3[i].sei || '') + (res3[i].mei || '')).replace(/[\s　]/g, '');
        if (cName === fullName) { Logger.log('顧客マッチ(氏名): ' + guestName); patchCustomerExtra(res3[i].id, res3[i]); return res3[i].id; }
      }
    } catch(e) {}
  }

  // 4. 新規作成
  try {
    var newCust = {
      sei:      sei,
      mei:      mei,
      mobile:   phone || '',
      email:    email || '',
      sei_kana: ce.seiKana  || '',
      mei_kana: ce.meiKana  || '',
      zip:      ce.zip      || '',
      pref:     ce.pref     || '',
      city:     ce.city     || '',
      address:  ce.address  || ''
    };
    var rc = UrlFetchApp.fetch(baseUrl, {
      method: 'POST',
      headers: {'Content-Type':'application/json','apikey':CONFIG.SUPABASE_KEY,'Authorization':'Bearer '+CONFIG.SUPABASE_KEY,'Prefer':'return=representation'},
      payload: JSON.stringify(newCust)
    });
    var created = JSON.parse(rc.getContentText());
    if (created && created[0]) {
      Logger.log('新規顧客作成: ' + guestName + ' → ID:' + created[0].id);
      return created[0].id;
    }
  } catch(e) { Logger.log('顧客作成エラー: ' + e); }

  return null;
}

// ============================================================
// 日毎明細パーサー
// ============================================================
function parseDailyDetail(src, body) {
  var days = [];

  if (src === '楽天') {
    var blocks = body.split(/\((\d{4}-\d{2}-\d{2})\)/);
    for (var i = 1; i < blocks.length; i += 2) {
      var date = blocks[i], block = blocks[i+1]||'', items = [];
      var am = block.match(/大人[：:](\d[\d,]+)円[×x×Ｘ]\s*(\d+)/);
      if (am) items.push({item:'大人宿泊料金', qty:parseInt(am[2]), price:toInt(am[1])});
      var cQty=0, cPrice=0;
      var cmsPct = block.match(/小学校[低高]学年[：:]?\s*(\d[\d,]+)円[×x×Ｘ]\s*(\d+)％[×x×Ｘ]\s*(\d+)[人名]/g)||[];
      if(cmsPct.length>0){
        cmsPct.forEach(function(m){var c=m.match(/(\d[\d,]+)円[×x×Ｘ]\s*(\d+)％[×x×Ｘ]\s*(\d+)[人名]/);if(c){cQty+=parseInt(c[3]);cPrice=Math.round(toInt(c[1])*parseInt(c[2])/100);}});
      } else {
        var cms = block.match(/小学校[低高]学年[：:]?\s*(\d[\d,]+)円[×x×Ｘ]\s*(\d+)/g)||[];
        cms.forEach(function(m){ var c=m.match(/(\d[\d,]+)円[×x×Ｘ]\s*(\d+)/); if(c){cQty+=parseInt(c[2]);cPrice=toInt(c[1]);} });
      }
      if (cQty>0) items.push({item:'小学生宿泊料金', qty:cQty, price:cPrice});
      [
        {p:/幼児.食事・布団付.[：:]?\s*(\d[\d,]+)円[×x×Ｘ]\s*(\d+)/, it:'幼児（食事有・布団有）'},
        {p:/幼児.食事のみ.[：:]?\s*(\d[\d,]+)円[×x×Ｘ]\s*(\d+)/,    it:'幼児（食事有・布団無）'},
        {p:/幼児.布団のみ.[：:]?\s*(\d[\d,]+)円[×x×Ｘ]\s*(\d+)/,    it:'幼児（食事無・布団有）'},
        {p:/幼児.食事・布団不要.[：:]?\s*(\d[\d,]+)円[×x×Ｘ]\s*(\d+)/,it:'幼児（食事無・布団無）'}
      ].forEach(function(d){ var m=block.match(d.p); if(m) items.push({item:d.it,qty:parseInt(m[2]),price:toInt(m[1])}); });
      if (items.length>0) days.push({date:date, items:items});
    }

  } else if (src === '一休') {
    var blocks2 = body.split(/((?:\d{4}年\d{1,2}月\d{1,2}日)(?:（[月火水木金土日]）)?)/);
    for (var i2 = 1; i2 < blocks2.length; i2 += 2) {
      var date2 = toYMD(blocks2[i2]); if (!date2) continue;
      var block2 = blocks2[i2+1]||'', items2 = [];
      var am2 = block2.match(/\\ ?([\d,]+)\s*[×x×Ｘ]\s*(\d+)名/);
      if (am2) items2.push({item:'大人宿泊料金', qty:parseInt(am2[2]), price:toInt(am2[1])});
      var cms2 = block2.match(/小学[^\n]*\n\s*\\ ?([\d,]+)\s*[×x×Ｘ]\s*(\d+)名/g)||[];
      var cQty2=0, cPrice2=0;
      cms2.forEach(function(m){ var c=m.match(/\\ ?([\d,]+)\s*[×x×Ｘ]\s*(\d+)名/); if(c){cQty2+=parseInt(c[2]);cPrice2=toInt(c[1]);} });
      if (cQty2>0) items2.push({item:'小学生宿泊料金', qty:cQty2, price:cPrice2});
      [
        {p:/乳幼児[（(]食事・寝具利用[）)][^\n]*\n\s*\\ ?([\d,]+)\s*[×x×Ｘ]\s*(\d+)名/, it:'幼児（食事有・布団有）'},
        {p:/乳幼児[（(]食事のみ[）)][^\n]*\n\s*\\ ?([\d,]+)\s*[×x×Ｘ]\s*(\d+)名/,       it:'幼児（食事有・布団無）'},
        {p:/乳幼児[（(]布団のみ[）)][^\n]*\n\s*\\ ?([\d,]+)\s*[×x×Ｘ]\s*(\d+)名/,       it:'幼児（食事無・布団有）'},
        {p:/乳幼児[（(]食事・寝具なし[）)][^\n]*\n\s*\\ ?([\d,]+)\s*[×x×Ｘ]\s*(\d+)名/, it:'幼児（食事無・布団無）'}
      ].forEach(function(d) {
        var m = block2.match(d.p);
        if (m) items2.push({item:d.it, qty:parseInt(m[2]), price:toInt(m[1])});
      });
      if (items2.length > 0) days.push({date:date2, items:items2});
    }

  } else if (src === 'じゃらん') {
    var blocks3 = body.split(/(\d+泊目［[\s\S]*?］)/);
    var dateMatches3 = body.match(/(\d+泊目［[\s\S]*?］)/g)||[];
    for (var i3 = 0; i3 < dateMatches3.length; i3++) {
      var dm3 = dateMatches3[i3].match(/(\d{4}年\d{1,2}月\d{1,2}日)/);
      if (!dm3) continue;
      var date3 = toYMD(dm3[1]);
      var block3 = blocks3[i3*2+2]||'';
      var items3 = [];
      var am3 = block3.match(/([\d,]+)円（大人[^）]*）\s*[×x×Ｘ]\s*(\d+)名/);
      if (am3) items3.push({item:'大人宿泊料金', qty:parseInt(am3[2]), price:toInt(am3[1])});
      var cm3 = block3.match(/([\d,]+)円（小学生）\s*[×x×Ｘ]\s*(\d+)名/);
      if (cm3) items3.push({item:'小学生宿泊料金', qty:parseInt(cm3[2]), price:toInt(cm3[1])});
      [
        {p:/([\d,]+)円（幼児・食事布団付）\s*[×x×Ｘ]\s*(\d+)名/,   it:'幼児（食事有・布団有）'},
        {p:/([\d,]+)円（幼児・食事のみ）\s*[×x×Ｘ]\s*(\d+)名/,     it:'幼児（食事有・布団無）'},
        {p:/([\d,]+)円（幼児・布団のみ）\s*[×x×Ｘ]\s*(\d+)名/,     it:'幼児（食事無・布団有）'},
        {p:/([\d,]+)円（幼児・食事のみ）\s*[×x×Ｘ]\s*(\d+)名/,     it:'幼児（食事有・布団無）'},
        {p:/([\d,]+)円（幼児・食事のみ）\s*[×x×Ｘ]\s*(\d+)名/,     it:'幼児（食事有・布団無）'},
        {p:/([\d,]+)円（幼児・食事布団なし）\s*[×x×Ｘ]\s*(\d+)名/, it:'幼児（食事無・布団無）'}
      ].forEach(function(d){ var m=block3.match(d.p); if(m) items3.push({item:d.it,qty:parseInt(m[2]),price:toInt(m[1])}); });
      if (items3.length>0) days.push({date:date3, items:items3});
    }

  } else if (src === '公式HP') {
    // R-WITHフォーマット（本文が楽天形式）
    if (body.indexOf('楽天トラベル') !== -1 && body.indexOf('チェックイン日時') !== -1) {
      return parseDailyDetail('楽天', body);
    }
    // 489banフォーマット: [1泊目](YYYY/MM/DD)
    if (body.indexOf('[1泊目]') !== -1 || /\[\d+泊目\]\(\d{4}\//.test(body)) {
      var blocks4b = body.split(/\[\d+泊目\]\((\d{4}\/\d{1,2}\/\d{1,2})\)/);
      for (var i4b = 1; i4b < blocks4b.length; i4b += 2) {
        var date4b = toYMD(blocks4b[i4b]); if (!date4b) continue;
        var block4b = blocks4b[i4b+1]||'', items4b = [];
        // 男性・女性 → 合算して大人宿泊料金
        var _mM = block4b.match(/男性[\s　]+([\d,]+)円[\s　]*[×xｘＸ×][\s　]*(\d+)/);
        var _fM = block4b.match(/女性[\s　]+([\d,]+)円[\s　]*[×xｘＸ×][\s　]*(\d+)/);
        if (_mM || _fM) {
          var _aTotal = 0, _aQty = 0;
          if (_mM)  { _aTotal += toInt(_mM[1])  * parseInt(_mM[2]);  _aQty += parseInt(_mM[2]); }
          if (_fM)  { _aTotal += toInt(_fM[1])  * parseInt(_fM[2]);  _aQty += parseInt(_fM[2]); }
          if (_aQty > 0) items4b.push({item:'大人宿泊料金', qty:_aQty, price:Math.round(_aTotal/_aQty)});
        }
        var _cM4b = block4b.match(/小学生[\s　]+([\d,]+)円[\s　]*[×xｘＸ×][\s　]*(\d+)/);
        if (_cM4b) items4b.push({item:'小学生宿泊料金', qty:parseInt(_cM4b[2]), price:toInt(_cM4b[1])});
        var _iM4b = block4b.match(/子供\(3才未満\)[\s　]+([\d,]+)円[\s　]*[×xｘＸ×][\s　]*(\d+)/);
        if (_iM4b) items4b.push({item:'幼児（食事無・布団無）', qty:parseInt(_iM4b[2]), price:toInt(_iM4b[1])});
        if (items4b.length > 0) days.push({date:date4b, items:items4b});
      }
      return days;
    }
    // 新489banフォーマット: "1泊目 2024/12/20 [残室数...]"
    if (/\d+泊目\s+\d{4}\/\d{1,2}\/\d{1,2}\s*\[/.test(body)) {
      var re4c = /(\d+)泊目\s+(\d{4}\/\d{1,2}\/\d{1,2})\s*\[/g, m4c;
      var splits4c = [], pos4c = 0;
      while ((m4c = re4c.exec(body)) !== null) {
        splits4c.push({idx: m4c.index, date: toYMD(m4c[2]), end: re4c.lastIndex});
      }
      for (var ic = 0; ic < splits4c.length; ic++) {
        var date4c = splits4c[ic].date; if (!date4c) continue;
        var blockEnd4c = ic + 1 < splits4c.length ? splits4c[ic+1].idx : body.length;
        var block4c = body.slice(splits4c[ic].end, blockEnd4c);
        var items4c = [];
        var _mM4c = block4c.match(/男性[\s\S]{0,30}?([\d,]+)円[\s　]*[×x×Ｘ×][\s　]*(\d+)/);
        var _fM4c = block4c.match(/女性[\s\S]{0,30}?([\d,]+)円[\s　]*[×x×Ｘ×][\s　]*(\d+)/);
        if (_mM4c || _fM4c) {
          var _aT4c = 0, _aQ4c = 0;
          if (_mM4c) { _aT4c += toInt(_mM4c[1]) * parseInt(_mM4c[2]); _aQ4c += parseInt(_mM4c[2]); }
          if (_fM4c) { _aT4c += toInt(_fM4c[1]) * parseInt(_fM4c[2]); _aQ4c += parseInt(_fM4c[2]); }
          if (_aQ4c > 0) items4c.push({item:'大人宿泊料金', qty:_aQ4c, price:Math.round(_aT4c/_aQ4c)});
        }
        // 大人のみ記載パターン: "17,050円 × 2 = 34,100円"
        if (items4c.length === 0) {
          var _am4c = block4c.match(/([\d,]+)円[\s　]*[×x×Ｘ×][\s　]*(\d+)[\s　]*=/);
          if (_am4c) items4c.push({item:'大人宿泊料金', qty:parseInt(_am4c[2]), price:toInt(_am4c[1])});
        }
        var _cm4c = block4c.match(/小学生[\s\S]{0,30}?([\d,]+)円[\s　]*[×x×Ｘ×][\s　]*(\d+)/);
        if (_cm4c) items4c.push({item:'小学生宿泊料金', qty:parseInt(_cm4c[2]), price:toInt(_cm4c[1])});
        if (items4c.length > 0) days.push({date:date4c, items:items4c});
      }
      return days;
    }
    // じゃらんnet自社サイト予約フォーマット: "N泊目［YYYY年MM月DD日］"
    if (body.indexOf('じゃらんnet_予約通知') !== -1 || /\d+泊目[\s　]*[\[［]/.test(body)) {
      var re_jl = /(\d+)泊目[\s　]*[\[［][\s　]*([0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日)/g, m_jl;
      var splits_jl = [];
      while ((m_jl = re_jl.exec(body)) !== null) {
        splits_jl.push({date: toYMD(m_jl[2]), start: re_jl.lastIndex});
      }
      for (var ijl = 0; ijl < splits_jl.length; ijl++) {
        var date_jl = splits_jl[ijl].date; if (!date_jl) continue;
        var blockEnd_jl = ijl+1 < splits_jl.length ? splits_jl[ijl+1].start : body.length;
        var block_jl = body.slice(splits_jl[ijl].start, blockEnd_jl);
        var items_jl = [], totAd = 0, totAdP = 0;
        // "22,000円（大人：男 2、女 0）　×  2名＝ 44,000円"
        var rPat = /([\d,]+)円[（(]大人[：:]男[\s　]*(\d+)[、,]女[\s　]*(\d+)[）)][^=＝]*[×xｘＸ×][^=＝]*(\d+)名/g, rm;
        while ((rm = rPat.exec(block_jl)) !== null) {
          var p=parseInt(rm[1].replace(/,/g,'')), q=parseInt(rm[4]);
          totAd += q; totAdP += p*q;
        }
        if (totAd === 0) {
          var sp = /([\d,]+)円[^×xｘＸ×]*[×xｘＸ×][\s　]*(\d+)名[\s　]*＝/g, sm;
          while ((sm = sp.exec(block_jl)) !== null) {
            var q2=parseInt(sm[2]); totAd+=q2; totAdP+=parseInt(sm[1].replace(/,/g,''))*q2;
          }
        }
        if (totAd > 0) items_jl.push({item:'大人宿泊料金', qty:totAd, price:Math.round(totAdP/totAd)});
        var cPat = /([\d,]+)円[（(]小学生[）)][^=＝]*[×xｘＸ×][\s　]*(\d+)名/g, cm;
        while ((cm = cPat.exec(block_jl)) !== null) {
          items_jl.push({item:'小学生宿泊料金', qty:parseInt(cm[2]), price:parseInt(cm[1].replace(/,/g,''))});
        }
        if (items_jl.length > 0) days.push({date:date_jl, items:items_jl});
      }
      if (days.length > 0) return days;
    }
    // 現在の公式HPフォーマット
    var blocks4 = body.split(/\d+泊目\s*[：:]\s*(\d{4}\/\d{1,2}\/\d{1,2})/);
    for (var i4 = 1; i4 < blocks4.length; i4 += 2) {
      var date4 = toYMD(blocks4[i4]); if (!date4) continue;
      var block4 = blocks4[i4+1]||'', items4 = [];
      var am4 = block4.match(/大人[^：:]*[：:]\s*([\d,]+)円\s*[×x×Ｘ]\s*(\d+)名/);
      if (am4) items4.push({item:'大人宿泊料金', qty:parseInt(am4[2]), price:toInt(am4[1])});
      var cm4 = block4.match(/小学生[：:]\s*([\d,]+)円\s*[×x×Ｘ]\s*(\d+)名/);
      if (cm4) items4.push({item:'小学生宿泊料金', qty:parseInt(cm4[2]), price:toInt(cm4[1])});
      [
        {p:/幼児（食事有・布団有）[：:]\s*([\d,]+)円\s*[×x×Ｘ]\s*(\d+)名/, it:'幼児（食事有・布団有）'},
        {p:/幼児.食事有・布団無.[：:]\s*([\d,]+)円\s*[×x×Ｘ]\s*(\d+)名/,   it:'幼児（食事有・布団無）'},
        {p:/幼児.食事無・布団有.[：:]\s*([\d,]+)円\s*[×x×Ｘ]\s*(\d+)名/,   it:'幼児（食事無・布団有）'},
        {p:/幼児.食事無・布団無.[：:]\s*([\d,]+)円\s*[×x×Ｘ]\s*(\d+)名/,   it:'幼児（食事無・布団無）'}
      ].forEach(function(d){ var m=block4.match(d.p); if(m) items4.push({item:d.it,qty:parseInt(m[2]),price:toInt(m[1])}); });
      if (items4.length>0) days.push({date:date4, items:items4});
    }

  } else if (src === 'Booking.com') {
    var section = (body.split(/料金詳細[：:]/)[1]||'');
    var lines = section.match(/\d{4}\/\d{1,2}\/\d{1,2}[^\n]*?([\d,]+)円[×x×Ｘ](\d+)人/g)||[];
    lines.forEach(function(line) {
      var lm = line.match(/(\d{4}\/\d{1,2}\/\d{1,2})[^\n]*?([\d,]+)円[×x×Ｘ](\d+)人/);
      if (lm) {
        var d5 = toYMD(lm[1]);
        if (d5) days.push({date:d5, items:[{item:'大人宿泊料金', qty:parseInt(lm[3]), price:toInt(lm[2])}]});
      }
    });

  } else if (src === 'Agoda') {
    var mnames2 = {January:'01',February:'02',March:'03',April:'04',May:'05',June:'06',
                   July:'07',August:'08',September:'09',October:'10',November:'11',December:'12'};
    var pat = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})[\s\S]*?JPY[\s\n]*([\d,\.]+)[\s\S]*?JPY[\s\n]*([\d,\.]+)/g;
    var am6;
    while ((am6 = pat.exec(body)) !== null) {
      var d6 = am6[3]+'-'+mnames2[am6[1]]+'-'+am6[2].padStart(2,'0');
      var sellPrice = Math.max(toInt(am6[4]), toInt(am6[5]));
      days.push({date:d6, items:[{item:'大人宿泊料金', qty:1, price:sellPrice}]});
    }
  }

  return days;
}

// ============================================================
// 食事プラン判定
// ============================================================
function detectMealPlan(planName) {
  var p = planName || '';
  var hasBf  = /朝食|朝夕|2食|二食|両食|朝夕食|morning|breakfast/i.test(p);
  var hasDin = /夕食|ディナー|朝夕|2食|二食|両食|朝夕食|dinner|evening/i.test(p);
  return { hasBf: hasBf, hasDin: hasDin };
}

// ============================================================
// price_common から食事単価を取得（GAS用）
// ============================================================
function fetchMealPrices() {
  var mp = {bf_adult:2200, bf_child:2200, bf_infant:2200,
             din_adult:7700, din_child:3300, din_infant:3300};
  try {
    var res = UrlFetchApp.fetch(
      CONFIG.SUPABASE_URL + '/rest/v1/price_common?id=eq.1&select=bf_adult,bf_child,bf_infant,din_adult,din_child_price,din_child_rate,din_infant',
      {headers:{'apikey':CONFIG.SUPABASE_KEY,'Authorization':'Bearer '+CONFIG.SUPABASE_KEY}}
    );
    var pd = JSON.parse(res.getContentText());
    if (pd && pd[0]) {
      var d = pd[0];
      mp.bf_adult  = d.bf_adult  || 2200;
      mp.bf_child  = d.bf_child  || 2200;
      mp.bf_infant = d.bf_infant || 2200;
      mp.din_adult = d.din_adult || 7700;
      mp.din_child = d.din_child_price || Math.round((d.din_adult||7700) * (parseFloat(d.din_child_rate)||0.65));
      mp.din_infant= d.din_infant|| 3300;
    }
  } catch(e) { Logger.log('fetchMealPrices error: ' + e); }
  return mp;
}

// ============================================================
// billing組み立て
// ============================================================
function buildBillingFromEmail(data) {
  var pay  = data.payment || '事後決済';
  var rows = [];
  var days = parseDailyDetail(data.source, data._body || '');
  // data.meal が直接パースされている場合（489ban等）はそちらを優先
  var meal;
  if (data.meal && data.meal !== '') {
    meal = {
      hasBf:  data.meal === 'bf'   || data.meal === 'both',
      hasDin: data.meal === 'din'  || data.meal === 'both'
    };
  } else {
    meal = detectMealPlan(data.plan_name);
  }
  var mp   = (meal.hasBf || meal.hasDin) ? fetchMealPrices() : null;

  if (days.length > 0) {
    days.forEach(function(day) {
      var adultQty = 0, childQty = 0, infMealQty = 0;
      day.items.forEach(function(it) {
        if (it.item === '大人宿泊料金')              adultQty   += it.qty;
        if (it.item === '小学生宿泊料金')            childQty   += it.qty;
        if (it.item === '幼児（食事有・布団有）' ||
            it.item === '幼児（食事有・布団無）')    infMealQty += it.qty;
      });

      day.items.forEach(function(it) {
        if (mp) {
          // ── 食事付きプラン：元のOTA価格行を参考行として残す ──
          rows.push({cat:'宿泊料金', date:day.date, item:it.item, qty:it.qty, discount:0, price:it.price, payment:pay, is_ref:true});

          // 素泊まり料金を計算（OTA単価 - 食事単価合計）
          var mealDeduct = 0;
          if (it.item === '大人宿泊料金') {
            if (meal.hasDin) mealDeduct += mp.din_adult;
            if (meal.hasBf)  mealDeduct += mp.bf_adult;
          } else if (it.item === '小学生宿泊料金') {
            if (meal.hasDin) mealDeduct += mp.din_child;
            if (meal.hasBf)  mealDeduct += mp.bf_child;
          } else if (it.item === '幼児（食事有・布団有）' || it.item === '幼児（食事有・布団無）') {
            if (meal.hasDin) mealDeduct += mp.din_infant;
            if (meal.hasBf)  mealDeduct += mp.bf_infant;
          }
          var sonoLabel = it.item.replace('宿泊料金', '素泊まり料金');
          rows.push({cat:'宿泊料金', date:day.date, item:sonoLabel, qty:it.qty, discount:0, price:Math.max(0, it.price - mealDeduct), payment:pay});
        } else {
          // 素泊まりプラン：通常の宿泊料金行のみ
          rows.push({cat:'宿泊料金', date:day.date, item:it.item, qty:it.qty, discount:0, price:it.price, payment:pay});
        }
      });

      // 食事行を追加（管理設定の共通単価で）
      if (mp) {
        if (meal.hasBf) {
          if (adultQty > 0)   rows.push({cat:'朝食', date:day.date, item:'大人宿泊（朝食付き）',   qty:adultQty,   discount:0, price:mp.bf_adult,  payment:pay});
          if (childQty > 0)   rows.push({cat:'朝食', date:day.date, item:'朝食（小学生）', qty:childQty,   discount:0, price:mp.bf_child,  payment:pay});
          if (infMealQty > 0) rows.push({cat:'朝食', date:day.date, item:'朝食（幼児）',   qty:infMealQty, discount:0, price:mp.bf_infant, payment:pay});
        }
        if (meal.hasDin) {
          if (adultQty > 0)   rows.push({cat:'夕食', date:day.date, item:'夕食（大人）',   qty:adultQty,   discount:0, price:mp.din_adult,  payment:pay});
          if (childQty > 0)   rows.push({cat:'夕食', date:day.date, item:'夕食（小学生）', qty:childQty,   discount:0, price:mp.din_child,  payment:pay});
          if (infMealQty > 0) rows.push({cat:'夕食', date:day.date, item:'夕食（幼児）',   qty:infMealQty, discount:0, price:mp.din_infant, payment:pay});
        }
      }
    });
  } else if (data.total_amount) {
    var total = toInt(data.total_amount);
    if (total > 0) rows.push({cat:'宿泊料金', item:data.plan_name||'宿泊料金', qty:1, discount:0, price:total, payment:pay});
  }

  return rows;
}

// ============================================================
// メール解析（OTA別）
// ============================================================
function parseEmail(src, body) {
  var d = {source:src, status:'confirmed', _body:body};

  if (src === '楽天') {
    d.reservation_no = ex(body, '予約番号\\s+:\\s+([^\\n\\s]+)');
    d.phone          = ex(body, '宿泊者連絡先\\s+:\\s+([0-9][0-9\\-]+)')
                    || ex(body, '会員連絡先\\s+:\\s+([0-9][0-9\\-]+)');
    d.check_in       = toYMD(ex(body, 'チェックイン日時\\s+:\\s+([0-9]{4}-[0-9]{2}-[0-9]{2})'));
    d.check_in_time  = ex(body, 'チェックイン日時[^\\n]*\\s([0-9]{2}:[0-9]{2})');
    d.check_out      = toYMD(ex(body, 'チェックアウト日時\\s+:\\s+([0-9]{4}-[0-9]{2}-[0-9]{2})'));
    d.room_type      = ex(body, '部屋タイプ\\s+:\\s+([^\\n]+)').replace(/^\([^)]+\)/,'').trim();
    d.plan_name      = ex(body, '宿泊プラン\\s+:\\s+([^\\n]+)').replace(/^\([^)]+\)/,'').trim();
    d.adults         = parseInt(ex(body,'大人([0-9]+)[人名]') || ex(body,'人数[^\\n]*大人([0-9]+)[人名]'))||0;
    d.children       = parseInt(ex(body,'子供([0-9]+)[人名]'))||0;
    d.infants        = parseInt(ex(body,'幼児[^0-9（(]*([0-9]+)[人名]'))||0;
    d.total_amount   = ex(body, '合計\\(A\\)\\s+:\\s+([0-9,]+)円');
    d.payment        = ex(body, '決済方法\\s+:\\s+([^\\n]+)');
    d.points_amount  = toInt(ex(body, '楽天ポイント\\(B\\)\\s+:\\s+([0-9,]+)円')) || 0;
    d.guest_name     = ex(body, '会員氏名\\s+:\\s+([^\\n]+)').trim()
                    || ex(body, '宿泊者氏名\\s+:\\s+([^\\n]+)').trim()
                    || ex(body, '代表者氏名\\s+:\\s+([^\\n]+)').trim()
                    || ex(body, '申込者名\\s+:\\s+([^\\n]+)').trim()
                    || ex(body, '利用者名\\s+:\\s+([^\\n]+)').trim();
    d.email          = '';
    // (備考) 多行対応（次の空行または■まで）
    var _rkBikouIdx = body.indexOf('(備考)');
    if (_rkBikouIdx !== -1) {
      var _rkColon = body.indexOf(':', _rkBikouIdx);
      if (_rkColon !== -1) {
        var _rkStart = _rkColon + 1;
        var _rkEnd1 = body.indexOf('\n\n', _rkStart);
        var _rkEnd2 = body.indexOf('\n■', _rkStart);
        var _rkEnd = Math.min(
          _rkEnd1 === -1 ? body.length : _rkEnd1,
          _rkEnd2 === -1 ? body.length : _rkEnd2
        );
        var _rkBikouText = body.slice(_rkStart, _rkEnd).replace(/\r/g, '').trim();
        if (_rkBikouText) d.notes = _rkBikouText;
      }
    }

  } else if (src === '一休') {
    d.reservation_no = ex(body, '予約番号[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n\\s\\u3000]+)');
    d.guest_name     = ex(body, '宿泊代表者氏名[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n(（]+)');
    d.phone          = ex(body, '宿泊代表者連絡先[\\s\\u3000]*[：:][\\s\\u3000]*([0-9][0-9\\-]+)');
    d.check_in       = toYMD(ex(body, '到着日[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日)'));
    d.check_in_time  = ex(body, '到着予定時間[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]{2}:[0-9]{2})');
    d.check_out      = toYMD(ex(body, '出発日[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日)'));
    d.room_type      = ex(body, '部屋名称[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)');
    d.plan_name      = ex(body, 'プラン名称[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)');
    d.adults         = parseInt(ex(body,'大人[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]+)名'))||0;
    d.children       = parseInt(ex(body,'子供[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]+)名'))||0;
    d.infants        = parseInt(ex(body,'幼児[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]+)名'))||0;
    d.total_amount   = ex(body, '予約金額合計[\\s\\u3000]*[：:]?[\\s\\u3000]*\\\\([0-9,]+)')
                    || ex(body, '支払金額[\\s\\u3000]*[：:]?[\\s\\u3000]*\\\\([0-9,]+)');
    d.paid_amount    = toInt(ex(body, '支払金額[\\s\\u3000]*[：:]?[\\s\\u3000]*\\\\([0-9,]+)')) || 0;
    d.coupon_amount  = toInt(ex(body, 'ポイント[・･]割引クーポン利用額[\\s\\u3000]*[：:]?[\\s\\u3000]*[▲△]?\\\\([0-9,]+)')) || 0;
    d.payment        = '事前決済';
    d.email          = '';
    d.address        = ex(body, '宿泊代表者都道府県[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)');
    // ■質問・回答■ セクションを解析
    var _ikQaSec = body.match(/■質問[・･]回答■([\s\S]*?)(?=■|$)/);
    if (_ikQaSec) {
      var _ikParts = [];
      var _ikBulletPat = /[・･]([^\n⇒→]+)\n[\s　]*[⇒→][\s　]*([^\n]+)/g, _ikBM;
      while ((_ikBM = _ikBulletPat.exec(_ikQaSec[1])) !== null) {
        var _ikQ = _ikBM[1].trim(), _ikA = _ikBM[2].trim();
        if (_ikQ && _ikA && _ikA !== '（未回答）' && _ikA !== '(未回答)') {
          _ikParts.push(_ikQ + '：' + _ikA);
        }
      }
      if (_ikParts.length > 0) d.notes = _ikParts.join('\n');
    }

  } else if (src === '公式HP') {

    // ── フォーマット自動判定 ──────────────────────────────────
    // R-WITHフォーマット（旧楽天R-WITHシステム）：楽天パーサーに委譲
    if (body.indexOf('楽天トラベル') !== -1 && body.indexOf('チェックイン日時') !== -1) {
      return parseEmail('楽天', body);
    }
    // じゃらんnet自社サイト予約フォーマット（2024〜）
    if (body.indexOf('じゃらんnet_予約通知') !== -1) {
      d.reservation_no = ex(body, '予約番号[\\s\\u3000]+[：:][\\s\\u3000]+([A-Z0-9a-z]+)');
      var _jlName = ex(body, '宿泊代表者氏名[\\s\\u3000]+[：:][\\s\\u3000]+([^\\n（(]+)');
      d.guest_name = _jlName.replace(/[\\s　]*様[\\s　]*$/, '').trim();
      var _jlKana = ex(body, '宿泊代表者氏名（カナ）[\\s\\u3000]+[：:][\\s\\u3000]+([^\\n（(]+)').replace(/[\\s　]*様[\\s　]*$/, '').trim();
      if (_jlKana) { var _jlKP = _jlKana.split(/[\\s　]+/); d.sei_kana = _jlKP[0]||''; d.mei_kana = _jlKP.slice(1).join('')||''; }
      d.phone = ex(body, '宿泊代表者連絡先[\\s\\u3000]+[：:][\\s\\u3000]+([0-9][0-9\\-]+)');
      d.email = ex(body, '予約者Ｅメールアドレス[\\s\\u3000]*[：:][\\s\\u3000]*([^\\s\\n]+@[^\\s\\n]+)');
      var _jlDate = ex(body, '宿泊日時[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日)');
      d.check_in = toYMD(_jlDate);
      d.check_in_time = ex(body, '宿泊日時[^\\n]*([0-9]{2}:[0-9]{2})');
      var _jlNights = parseInt(ex(body, '泊数[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]+)泊')||'1');
      d.check_out = calcCheckOut(d.check_in, _jlNights);
      d.room_type = ex(body, '部屋タイプ[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)');
      d.plan_name = ex(body, 'プラン[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)').replace(/^■/, '').trim();
      var _jlMeal = ex(body, '食事[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)');
      if (/朝あり.*夕あり|夕あり.*朝あり/.test(_jlMeal)) d.meal = 'both';
      else if (/夕あり/.test(_jlMeal)) d.meal = 'din';
      else if (/朝あり/.test(_jlMeal)) d.meal = 'bf';
      else d.meal = 'none';
      var _jlAd = 0;
      var _jlRoomPat = /[0-9]+部屋目[\s\u3000]*[：:][\s\u3000]*大人[：:]([0-9]+)名/g, _jlRm;
      while ((_jlRm = _jlRoomPat.exec(body)) !== null) _jlAd += parseInt(_jlRm[1]);
      d.adults = _jlAd || parseInt(ex(body,'大人[：:]([0-9]+)名'))||0;
      d.children = parseInt(ex(body,'子供[：:]([0-9]+)名'))||0;
      d.infants  = parseInt(ex(body,'幼児[：:]([0-9]+)名'))||0;
      var _jlAddr = ex(body, '住所[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)');
      if (_jlAddr) {
        var _jlZip = _jlAddr.match(/〒([0-9]{3}-?[0-9]{4})/);
        d.zip = _jlZip ? _jlZip[1].replace(/-/,'') : '';
        var _jlRest = _jlAddr.replace(/〒[0-9-]+\s*/, '').trim();
        var _jlPref = _jlRest.match(/^([^\s　]*?[都道府県])/);
        d.pref = _jlPref ? _jlPref[1] : '';
        var _jlRest2 = _jlPref ? _jlRest.slice(d.pref.length).trim() : _jlRest;
        var _jlCity = _jlRest2.match(/^([^\s　]*?[市区町村郡])/);
        d.city = _jlCity ? _jlCity[1] : '';
        d.address = _jlCity ? _jlRest2.slice(d.city.length).trim() : _jlRest2;
      }
      var _jlPayTxt = ex(body, '決済情報[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n━]+)').trim();
      d.payment = /カード|精算不要|オンライン/.test(_jlPayTxt) ? '事前決済' : '現地決済';
      d.total_amount = toInt(ex(body, '合計[：:]([0-9,]+)円'));
      var _jlQSec = body.match(/■予約者に対する質問[：:]([\s\S]*?)(?=■|$)/);
      var _jlASec = body.match(/■予約者からの回答[：:]([\s\S]*?)(?=■|$)/);
      if (_jlQSec && _jlASec) {
        var _jlQLines = _jlQSec[1].replace(/\r/g,'').split('\n').map(function(s){return s.trim();}).filter(function(s){return /^[・･]/.test(s);});
        var _jlALines = _jlASec[1].replace(/\r/g,'').trim().split('\n').map(function(s){return s.trim();}).filter(Boolean);
        var _jlNotes = [];
        for (var _jlI=0; _jlI<_jlQLines.length; _jlI++) {
          var _jlQ = _jlQLines[_jlI].replace(/^[・･]/,'').trim();
          var _jlA = _jlALines[_jlI]||'';
          if (_jlQ && _jlA) _jlNotes.push(_jlQ+'：'+_jlA);
        }
        if (_jlNotes.length>0) d.notes = _jlNotes.join('\n');
      }
      return d;
    }
    // 489banフォーマット（旧公式HP予約システム、〜2024年）
    if (body.indexOf('[宿泊日]') !== -1 || body.indexOf('info@489ban.net') !== -1 || body.indexOf('予約番（株式会社') !== -1) {
      d.source         = '公式HP';
      d.reservation_no = ex(body, '\\[予約番号\\][\\s　]*[：:][\\s　]*([0-9]+)');
      d.plan_name      = (ex(body, '\\[プラン名\\][\\s　]*[：:][\\s　]*([^\\n]+)')
                       || ex(body, '\\[プラン\\][\\s　]*[：:][\\s　]*([^\\n]+)')).trim();
      d.room_type      = (ex(body, '\\[部屋タイプ\\][\\s　]*[：:][\\s　]*([^\\n]+)')
                       || ex(body, '\\[お部屋\\][\\s　]*[：:][\\s　]*([^\\n]+)')).trim();
      var _4d = ex(body, '\\[宿泊日\\][\\s　]*[：:][\\s　]*(\\d{4}年\\d{2}月\\d{2}日)')
             || ex(body, '\\[宿泊日\\][\\s　]*[：:][\\s　]*(\\d{4}\\/\\d{1,2}\\/\\d{1,2})');
      var _4n = parseInt(ex(body, 'から(\\d+)泊') || '1');
      if (_4d) { d.check_in = toYMD(_4d); d.check_out = calcCheckOut(d.check_in, _4n); }
      d.check_in_time  = ex(body, '\\[チェックイン予定時間\\][\\s　]*[：:][\\s　]*(\\d{1,2}:\\d{2})')
                      || ex(body, 'チェックイン予定時間[\\s　]*[：:][\\s　]*(\\d{1,2}:\\d{2})');
      var _4name = ex(body, '\\[氏名\\][\\s　]*[：:][\\s　]*([^（(\\n]+)').replace(/様\s*$/, '').trim();
      d.guest_name = _4name;
      var _4kana = ex(body, '\\[氏名\\][\\s　]*[：:][^（(]+[（(]([^）)]+)[）)]');
      if (_4kana) { var _4kp = _4kana.trim().split(/[\s　]+/); d.sei_kana = _4kp[0]||''; d.mei_kana = _4kp.slice(1).join('')||''; }
      d.email   = ex(body, '\\[Ｅメール\\][\\s　]*[：:][\\s　]*([^\\s\\n]+@[^\\s\\n]+)')
               || ex(body, '\\[メール\\][\\s　]*[：:][\\s　]*([^\\s\\n]+@[^\\s\\n]+)');
      d.phone   = ex(body, '携帯電話[\\s　]*[：:][\\s　]*([0-9][0-9\\-]+)')
               || ex(body, '自宅電話[\\s　]*[：:][\\s　]*([0-9][0-9\\-]+)')
               || ex(body, '連絡先（主）[\\s　]+([0-9][0-9\\-]+)')
               || ex(body, '連絡先\\(主\\)[\\s　]+([0-9][0-9\\-]+)');
      var _4zip  = ex(body, '\\[郵便番号\\][\\s　]*[：:][\\s　]*([0-9]+)');
      var _4addr = ex(body, '\\[ご住所\\][\\s　]*[：:][\\s　]*([^\\n]+)');
      d.zip = _4zip.replace(/-/,'');
      if (_4addr) { var _4pm = _4addr.match(/^([^\s　]*?[都道府県])/); d.pref = _4pm?_4pm[1]:''; var _4ar = _4pm?_4addr.slice(d.pref.length).trim():_4addr.trim(); var _4cm = _4ar.match(/^([^\s　]*?[市区町村郡])/); d.city = _4cm?_4cm[1]:''; d.address = _4cm?_4ar.slice(d.city.length).trim():_4ar; }
      var _4fd = ex(body, '\\[お食事\\][\\s　]*[：:][\\s　]*([^\\n]+)');
      if (/朝夕|朝・夕|両食|2食|二食/.test(_4fd)) d.meal = 'both';
      else if (/夕/.test(_4fd)) d.meal = 'din';
      else if (/朝/.test(_4fd)) d.meal = 'bf';
      else d.meal = 'none';
      var _4ml = parseInt(ex(body,'男性[\\s　]+(\\d+)名')||'0');
      var _4fl = parseInt(ex(body,'女性[\\s　]+(\\d+)名')||'0');
      d.adults   = (_4ml+_4fl) || parseInt(ex(body,'大人[^0-9]*(\\d+)名?')||'0');
      d.children = parseInt(ex(body,'小学生[^0-9]*(\\d+)名')||'0');
      d.infants  = parseInt(ex(body,'子供\\(3才未満\\)[\\s\\S]{0,30}(\\d+)名')||'0');
      d.total_amount = toInt(ex(body, '合計[：:]([0-9,]+)円'));
      d.payment      = '現地決済';
      var _4note = ex(body, '(?:備考|要望)[^：:]*[：:]([^\\n]+)');
      if (_4note && _4note.trim()) d.notes = _4note.trim();
      return d;
    }
    // ── 現在の公式HPフォーマット（以下既存コード） ──────────────

    d.reservation_no = ex(body, '予約番号[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n\\s\\u3000]+)');
    // 氏名（ふりがな付き）: "宇津 宏（ウヅヒロシ）" → guest_name=宇津 宏, kana=ウヅヒロシ
    d.guest_name     = (ex(body, '(?:宿泊者氏名|宿泊者名)[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n(（]+)') || '').trim();
    var _kanaRaw = ex(body, '(?:宿泊者氏名|宿泊者名)[\\s\\u3000]*[：:][\\s\\u3000]*[^（(]+[（(]([ァ-ヶーｦ-ﾟ\\u30A0-\\u30FF]+)[）)]');
    // ふりがなを姓・名に分割（氏名の字数比率で按分）
    var _nameParts = d.guest_name.split(/[\s　]+/);
    var _sei = _nameParts[0] || ''; var _mei = _nameParts.slice(1).join('') || '';
    if (_kanaRaw && _sei && _mei) {
      var _seiRatio = _sei.length / (_sei.length + _mei.length);
      var _seiKLen = Math.max(1, Math.round(_kanaRaw.length * _seiRatio));
      d.sei_kana = _kanaRaw.slice(0, _seiKLen);
      d.mei_kana = _kanaRaw.slice(_seiKLen);
    } else if (_kanaRaw) {
      d.sei_kana = _kanaRaw; d.mei_kana = '';
    }
    d.phone          = ex(body, '宿泊者連絡先[\\s\\u3000]*[：:][\\s\\u3000]*([0-9][0-9\\-]+)');
    // メールアドレス：markdown形式 [xxx@yyy](mailto:...) にも対応
    var _emailRaw = ex(body, '予約者メールアドレス[\\s\\u3000]*[：:][\\s\\u3000]*(?:\\[)?([^\\s\\n\\]\\(]+@[^\\s\\n\\]\\)]+)');
    d.email = _emailRaw || '';
    // 住所：予約者ご住所（郵便番号付き）を優先、宿泊者ご住所をfallback
    var _addrRaw = ex(body, '予約者ご住所[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)')
                || ex(body, '宿泊者ご住所[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)');
    if (_addrRaw) {
      var _zipM = _addrRaw.match(/^([0-9]{7})\s*/);
      d.zip  = _zipM ? _zipM[1] : '';
      var _aRest = _zipM ? _addrRaw.slice(_zipM[0].length).trim() : _addrRaw.trim();
      var _prefM = _aRest.match(/^([^\s　]*?[都道府県])/);
      d.pref = _prefM ? _prefM[1] : '';
      var _aRest2 = _prefM ? _aRest.slice(d.pref.length).trim() : _aRest;
      var _cityM = _aRest2.match(/^([^\s　]*?[市区町村郡])/);
      d.city = _cityM ? _cityM[1] : '';
      d.address = _cityM ? _aRest2.slice(d.city.length).trim() : _aRest2;
    }
    d.check_in       = toYMD(ex(body, 'チェックイン日時[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]{4}/[0-9]{1,2}/[0-9]{1,2})'));
    d.check_in_time  = ex(body, 'チェックイン日時[^\\n]*([0-9]{2}:[0-9]{2})');
    d.check_out      = toYMD(ex(body, 'チェックアウト日時[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]{4}/[0-9]{1,2}/[0-9]{1,2})'));
    d.room_type      = ex(body, '部屋タイプ[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)');
    d.plan_name      = ex(body, 'プラン名[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)');
    var male   = parseInt(ex(body,'男性\\(([0-9]+)\\)名'))||0;
    var female = parseInt(ex(body,'女性\\(([0-9]+)\\)名'))||0;
    d.adults   = male+female || parseInt(ex(body,'合計人数[：:]\\s*([0-9]+)名'))||0;
    d.children = parseInt(ex(body,'子供・幼児[：:]\\s*([0-9]+)名'))||0;
    d.infants  = 0;
    d.total_amount = ex(body, '合計金額.税込.[^\\n]*([0-9,]+)円');
    d.payment      = ex(body, '決済方法[\\s\\u3000]*[： :][\\s\\u3000]*([^\\n]+)');
    // 質問・回答 → 特記事項（notes）に転記（質問N/回答Nを個別抽出してペアリング）
    var _qMap = {}, _aMap = {};
    var _qPat2 = /質問(\d+)[\s　]*[：:][ \t]*([^\r\n]+)/g, _qM2;
    while ((_qM2 = _qPat2.exec(body)) !== null) { _qMap[_qM2[1]] = _qM2[2].trim(); }
    var _aPat2 = /回答(\d+)[\s　]*[：:][ \t]*([^\r\n]+)/g, _aM2;
    while ((_aM2 = _aPat2.exec(body)) !== null) { _aMap[_aM2[1]] = _aM2[2].trim(); }
    var _qaParts = [];
    var _qNums = Object.keys(_qMap).sort(function(a,b){return parseInt(a)-parseInt(b);});
    for (var _qi = 0; _qi < _qNums.length; _qi++) {
      var _qn = _qNums[_qi], _qTxt = _qMap[_qn], _aTxt = _aMap[_qn];
      if (_qTxt && _aTxt) _qaParts.push(_qTxt + '：' + _aTxt);
    }
    var _bikou = ex(body, '備考[：:][ \t]*([^\n■]+)');
    if (_bikou && _bikou.trim() && _bikou.trim() !== '(なし)' && _bikou.trim() !== 'なし') {
      _qaParts.push('備考：' + _bikou.trim());
    }
    if (_qaParts.length > 0) d.notes = _qaParts.join('\n');

  } else if (src === 'Booking.com') {
    d.reservation_no = ex(body, '予約番号[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n\\s\\u3000]+)');
    d.guest_name     = ex(body, 'お客様氏名[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n(（]+)');
    d.phone          = ex(body, '連絡電話[\\s\\u3000]*[：:][\\s\\u3000]*([0-9 ][0-9 \\-]+)')
                    || ex(body, '携帯電話[\\s\\u3000]*[：:][\\s\\u3000]*([0-9 ][0-9 \\-]+)');
    d.email          = ex(body, 'メールアドレス[\\s\\u3000]*[：:][\\s\\u3000]*([^\\s\\n]+@[^\\s\\n]+)');
    d.address        = ex(body, '住所[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)');
    d.check_in       = toYMD(ex(body, '予約日[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]{4}/[0-9]{1,2}/[0-9]{1,2})'));
    d.check_in_time  = ex(body, '到着時間[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]{2}:[0-9]{2})');
    d.check_out      = calcCheckOut(d.check_in, ex(body, '宿泊期間[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]+)泊'));
    d.room_type      = ex(body, '部屋タイプ[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)');
    d.plan_name      = ex(body, 'プラン[\\s\\u3000　]*[：:][\\s\\u3000]*([^\\n]+)');
    d.adults         = parseInt(ex(body, '宿泊人数[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]+)人'))||0;
    d.children       = parseInt(ex(body, '子供[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]+)人'))||0;
    d.infants        = parseInt(ex(body, '幼児[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]+)人'))||0;
    d.total_amount   = ex(body, '合計料金[\\s\\u3000]*[：:][\\s\\u3000]*([0-9,]+)円');
    d.payment        = '事前決済';

  } else if (src === 'じゃらん') {
    d.reservation_no = ex(body, '予約番号[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n\\s\\u3000]+)');
    d.guest_name     = ex(body, '宿泊代表者氏名[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n（(]+)').replace(/[\s　]*様[\s　]*$/,'').replace(/　/g,' ').trim();
    d.phone          = ex(body, '宿泊代表者連絡先[\\s\\u3000]*[：:][\\s\\u3000]*([0-9][0-9\\-]+)');
    d.email          = ex(body, '予約者[EＥe]メールアドレス[\\s\\u3000]*[：:][\\s\\u3000]*([^\\s\\n]+@[^\\s\\n]+)');
    d.address        = ex(body, '住所[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)');
    d.check_in       = toYMD(ex(body, '宿泊日時[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日)'));
    d.check_in_time  = ex(body, '宿泊日時[^\\n]*([0-9]{2}:[0-9]{2})');
    d.check_out      = calcCheckOut(d.check_in, ex(body, '泊数[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]+)泊'));
    d.room_type      = ex(body, '部屋タイプ[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)');
    d.plan_name      = ex(body, 'プラン[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n]+)').replace(/^[■▪・.]+/,'').trim();
    d.adults         = parseInt(ex(body, '１部屋目[\\s\\u3000]*[：:][\\s\\u3000]*大人[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]+)名'))||0;
    d.children       = parseInt(ex(body, '小学生[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]+)名'))||0;
    d.infants        = parseInt(ex(body, '幼児[\\s\\u3000]*[：:][\\s\\u3000]*([0-9]+)名'))||0;
    d.total_amount   = ex(body, '合計：([0-9,]+)円')
                    || ex(body, '宿泊者への請求額[\\s\\u3000]*[：:][\\s\\u3000]*([0-9,]+)円');
    d.points_amount  = toInt(ex(body, 'ポイント利用[\\s\\u3000]*[：:]?[\\s\\u3000]*([0-9,]+)')) || 0;
    d.payment        = ex(body, '決済情報[\\s\\u3000]*[：:][\\s\\u3000]*([^\\n━￣：:]+)')
                    || ex(body, '決済情報[\\s\\u3000]*\n[\\s\\u3000━￣]*\n([^\\n━￣]+)')
                    || '現地精算';
    // じゃらん Q&A → notes（質問リストと回答リストを位置でペアリング、不一致時は回答のみ保存）
    var _jlNoteParts = [];
    var _jlQSec = body.match(/■予約者に対する質問[：:]([\s\S]*?)(?=■予約者からの回答)/);
    var _jlASec = body.match(/■予約者からの回答[：:]([\s\S]*?)(?=\n■|\n━━|$)/);
    if (_jlQSec && _jlASec) {
      var _jlQs = (_jlQSec[1].match(/[・･]([^\n・･■━]+)/g)||[]).map(function(q){return q.replace(/^[・･]/,'').trim();});
      var _jlALines = _jlASec[1].replace(/^\r?\n/,'').split(/\r?\n/).map(function(l){return l.trim();});
      if (_jlQs.length === _jlALines.length) {
        // 行数が一致 → 位置でペアリング（空回答はスキップ）
        for (var _ji=0; _ji<_jlQs.length; _ji++) {
          if (_jlQs[_ji] && _jlALines[_ji]) _jlNoteParts.push(_jlQs[_ji]+'：'+_jlALines[_ji]);
        }
      } else {
        // 不一致 → 非空回答のみ保存
        _jlNoteParts = _jlALines.filter(function(l){return l;});
      }
    }
    // 宿への要望
    var _jlReqM = body.match(/■予約者から宿への要望([\s\S]*?)(?=\n■|\n━━|$)/);
    if (_jlReqM) {
      var _jlReq = _jlReqM[1].replace(/（必要があれば[^\n]*）[：:]?/g,'').replace(/\r/g,'').split('\n').map(function(l){return l.trim();}).filter(function(l){return l;}).join('\n');
      if (_jlReq) _jlNoteParts.push('要望：'+_jlReq);
    }
    if (_jlNoteParts.length > 0) d.notes = _jlNoteParts.join('\n');

  } else if (src === 'Agoda') {
    d.reservation_no = ex(body, '予約ID\\s*\\n(\\d+)');
    var m1 = body.match(/Customer First Name[^\n]+）\s+([^\n]+)/i);
    var m2 = body.match(/Customer Last Name[^\n]+）\s+([^\n]+)/i);
    d.guest_name = ((m1?m1[1].trim():'')+' '+(m2?m2[1].trim():'')).trim();
    if (!d.guest_name) d.guest_name = ex(body, '氏名:\\s*([^,\\n]+)');
    d.phone      = ex(body, '電話番号:\\s*([0-9][0-9 \\-]+)');
    d.email      = '';
    d.check_in   = toYMD(ex(body, 'Check-in[^\\n]*(\\d{1,2}-[A-Z][a-z]{2}-\\d{4})'));
    d.check_out  = toYMD(ex(body, 'Check-out[^\\n]*(\\d{1,2}-[A-Z][a-z]{2}-\\d{4})'));
    d.check_in_time = '';
    var rtm = body.match(/\n((?:Superior|Deluxe)[^\t\n:]*)/i);
    d.room_type  = rtm ? rtm[1].trim() : '';
    d.plan_name  = ex(body, '料金プラン名:\\s*([^\\n]+)');
    d.adults     = parseInt(ex(body, '(\\d+)\\s*Adults'))||0;
    d.children = 0; d.infants = 0;
    d.total_amount = ex(body, '表示販売料金[^\\n]*JPY\\s*([\\d,\\.]+)');
    d.payment = '事前払い';
  }

  d.adults   = parseInt(d.adults)  ||0;
  d.children = parseInt(d.children)||0;
  d.infants  = parseInt(d.infants) ||0;

  d.payment = normalizePayment(d.payment);
  return d;
}

function normalizePayment(raw) {
  if (!raw) return '';
  var s = String(raw).replace(/[\s　]/g, '');
  if (/現地|現金払い/.test(s)) return '現地精算';
  if (/事前払い|事前決済|クレジット決済|カード決済|OTA/.test(s)) return '事前決済';
  if (/振込/.test(s)) return '振込済み';
  return '';
}

// ============================================================
// Supabase保存（顧客自動検索・作成つき）
// ============================================================
function saveToSupabase(data) {
  try {
    var custExtra = {
      seiKana: data.sei_kana || '',
      meiKana: data.mei_kana || '',
      zip:     data.zip      || '',
      pref:    data.pref     || '',
      city:    data.city     || '',
      address: data.address  || ''
    };
    var customerId = findOrCreateCustomerGAS(data.guest_name, data.phone, data.email, custExtra);

    var billingData = buildBillingFromEmail(data);
    var _normPay = data.payment || '';
    var _prepaidAmt = (_normPay === '事前決済') ? (data.paid_amount || toInt(data.total_amount) || 0) : 0;
    var _billingPts = (_normPay !== '事前決済') ? (data.points_amount || 0) : 0;
    var _billingCpn = data.coupon_amount || 0;
    var _billingPayload = (_billingPts === 0 && _billingCpn === 0)
      ? billingData
      : {rows: billingData, coupon: _billingCpn, points: _billingPts, furusato: 0};
    var infMealBed = 0, infMealOnly = 0, infBedOnly = 0, infNone = 0;
    billingData.forEach(function(row) {
      if (row.item === '幼児（食事有・布団有）') infMealBed  += (row.qty || 0);
      if (row.item === '幼児（食事有・布団無）') infMealOnly += (row.qty || 0);
      if (row.item === '幼児（食事無・布団有）') infBedOnly  += (row.qty || 0);
      if (row.item === '幼児（食事無・布団無）') infNone     += (row.qty || 0);
    });
    var totalInfants = infMealBed + infMealOnly + infBedOnly + infNone || data.infants || 0;

    var payload = {
      source:         data.source,
      status:         data.status,
      reservation_no: data.reservation_no,
      guest_name:     data.guest_name,
      phone:          data.phone,
      email:          data.email,
      address:        data.address,
      check_in:       data.check_in,
      check_in_time:  data.check_in_time,
      check_out:      data.check_out,
      room_type:      data.room_type,
      plan_name:      data.plan_name,
      adults:         data.adults,
      children:       data.children,
      infants:        String(totalInfants),
      inf_meal_bed:   String(infMealBed),
      inf_meal_only:  String(infMealOnly),
      inf_bed_only:   String(infBedOnly),
      inf_none:       infNone,
      total_amount:   data.total_amount,
      payment:        data.payment,
      prepaid_amount: _prepaidAmt,
      billing:        _billingPayload,
      customer_id:    customerId,
      notes:          data.notes || ''
    };

    var r = UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/rest/v1/reservations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'apikey': CONFIG.SUPABASE_KEY,
        'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY,
        'Prefer': 'return=minimal'
      },
      payload: JSON.stringify(payload)
    });
    Logger.log('Supabase保存: ' + r.getResponseCode() + ' / ' + data.guest_name + ' / 顧客ID: ' + customerId);
  } catch(e) {
    Logger.log('Supabase error: ' + e);
  }
}

// ============================================================
// カレンダー登録
// ============================================================
// ★ addToCalendar / getAvailableCalId / updateRoomType が
//    コード.gs にすでに定義されている場合は、この3関数を削除してください。
// ============================================================
function addToCalendar(data) {
  if (!data.check_in || !data.check_out) return;
  try {
    var calId = (data.room_type && data.room_type.indexOf('デラックス') !== -1)
      ? CONFIG.CAL3 : getAvailableCalId(data.check_in, data.check_out);
    var roomLabel = calId===CONFIG.CAL3?'デラックスツイン':calId===CONFIG.CAL1?'スーペリアツイン01':'スーペリアツイン02';
    var title = (data.guest_name||'?')+' ['+data.source+']';

    var ownerDesc = '【予約経路】'+data.source+'\n【予約番号】'+(data.reservation_no||'-')+'\n\n'
      +'【チェックイン】'+(data.check_in||'-')+' '+(data.check_in_time||'')+'\n'
      +'【チェックアウト】'+(data.check_out||'-')+'\n\n'
      +'【プラン名】'+(data.plan_name||'-')+'\n【部屋】'+roomLabel+'\n\n'
      +'【人数】大人:'+data.adults+'名  小学生:'+data.children+'名  幼児:'+data.infants+'名\n'
      +'【合計請求金額】'+(data.total_amount||'-')+'円\n【決済方法】'+(data.payment||'-')+'\n\n'
      +'【氏名】'+(data.guest_name||'-')+'\n【電話】'+(data.phone||'-')+'\n'
      +'【メール】'+(data.email||'-')+'\n【住所】'+(data.address||'-')+'\n';

    CalendarApp.getCalendarById(calId).createAllDayEvent(
      title,
      new Date(data.check_in + 'T00:00:00'),
      new Date(data.check_out + 'T00:00:00'),
      {description: ownerDesc}
    );

    var ngFood = '';
    var custMemo = '';
    if (data.customer_id) {
      try {
        var custRes = UrlFetchApp.fetch(
          CONFIG.SUPABASE_URL+'/rest/v1/customers?id=eq.'+data.customer_id+'&select=ng_food,allergy,memo',
          {headers:{'apikey':CONFIG.SUPABASE_KEY,'Authorization':'Bearer '+CONFIG.SUPABASE_KEY}}
        );
        var custList = JSON.parse(custRes.getContentText());
        if (custList.length > 0) {
          ngFood   = custList[0].ng_food  || '';
          custMemo = custList[0].memo     || '';
        }
      } catch(ce) { Logger.log('顧客情報取得エラー: '+ce); }
    }
    var mealMap = {none:'素泊まり', bf:'朝食付き', din:'夕食付き', both:'朝夕食付き'};
    var mealLabel = mealMap[data.meal||'none'] || (data.plan_name||'-');
    var adultsLine  = '大人 '+(data.adults||0)+'名';
    if (data.children>0) adultsLine += '  小学生 '+data.children+'名';
    if (data.infants>0)  adultsLine += '  幼児 '+data.infants+'名';

    var staffTitle = (data.guest_name||'?')+' 様　'+(data.adults||0)+'名　['+roomLabel+']';
    var staffDesc = '━━━━━━━━━━━━━━━━\n'
      +'🏠 '+roomLabel+'\n'
      +'━━━━━━━━━━━━━━━━\n'
      +'📅 チェックイン:  '+(data.check_in||'-')+(data.check_in_time?' '+data.check_in_time:'')+'\n'
      +'📅 チェックアウト: '+(data.check_out||'-')+'\n\n'
      +'👥 人数: '+adultsLine+'\n'
      +'🍽 食事: '+mealLabel+'\n';
    if (ngFood) {
      staffDesc += '\n⚠️ アレルギー・NG食材\n　'+ngFood+'\n';
    }
    if (data.notes||custMemo) {
      staffDesc += '\n📝 備考・特記事項\n　'+(data.notes||custMemo)+'\n';
    }
    staffDesc += '\n【予約経路】'+data.source;

    CalendarApp.getCalendarById(CONFIG.CAL_STAFF).createAllDayEvent(
      staffTitle,
      new Date(data.check_in + 'T00:00:00'),
      new Date(data.check_out + 'T00:00:00'),
      {description: staffDesc}
    );

    updateRoomType(data.reservation_no, roomLabel);
    Logger.log('Calendar OK: ' + title + ' → ' + roomLabel);
  } catch(e) { Logger.log('Calendar error: ' + e); }
}

function getAvailableCalId(checkIn, checkOut) {
  try {
    var h = {'apikey':CONFIG.SUPABASE_KEY,'Authorization':'Bearer '+CONFIG.SUPABASE_KEY};
    var r2 = UrlFetchApp.fetch(CONFIG.SUPABASE_URL+'/rest/v1/reservations?status=eq.confirmed&room_type=eq.スーペリアツイン02&check_in=lt.'+checkOut+'&check_out=gt.'+checkIn+'&select=id',{headers:h});
    if (JSON.parse(r2.getContentText()).length===0) return CONFIG.CAL2;
    var r1 = UrlFetchApp.fetch(CONFIG.SUPABASE_URL+'/rest/v1/reservations?status=eq.confirmed&room_type=eq.スーペリアツイン01&check_in=lt.'+checkOut+'&check_out=gt.'+checkIn+'&select=id',{headers:h});
    if (JSON.parse(r1.getContentText()).length===0) return CONFIG.CAL1;
    Logger.log('警告: スーペリア両方埋まっています！');
    return CONFIG.CAL2;
  } catch(e) { return CONFIG.CAL2; }
}

function updateRoomType(reservationNo, roomLabel) {
  if (!reservationNo) return;
  try {
    UrlFetchApp.fetch(CONFIG.SUPABASE_URL+'/rest/v1/reservations?reservation_no=eq.'+encodeURIComponent(reservationNo),{
      method:'PATCH',
      headers:{'Content-Type':'application/json','apikey':CONFIG.SUPABASE_KEY,'Authorization':'Bearer '+CONFIG.SUPABASE_KEY,'Prefer':'return=minimal'},
      payload: JSON.stringify({room_type:roomLabel})
    });
  } catch(e) {}
}

// ============================================================
// 一括請求再取り込み（GASエディタから手動実行）
// ============================================================
//
// 使い方:
//   1. GASエディタで startBulkReprocessBilling() を選択して「実行」
//   2. 2分ごとに自動継続、完了時に wassa@wassa-okinawa.com にメール通知
//   3. 進捗確認: checkBulkBillingStatus() を実行
//   4. 中断したい場合: stopBulkReprocessBilling() を実行
//
// 対象: billing=null のOTA予約（楽天・じゃらん・一休・Booking.com・Agoda・公式HP）
// 直予約はスキップ
// メールが見つからない予約は billing=[] で保存（次回から除外）
// ============================================================

// yoyaku@ 用：2016年以降を処理
function startBulkReprocessBilling() {
  _startBulkWithRange('2016', '2099');
}

// 1年だけ処理（quota対策）例: startBulkYear2018() → 2018年だけ
function startBulkYear2015() { _startBulkWithRange('2015', '2015'); }
function startBulkYear2016() { _startBulkWithRange('2016', '2016'); }
function startBulkYear2017() { _startBulkWithRange('2017', '2017'); }
function startBulkYear2018() { _startBulkWithRange('2018', '2018'); }
function startBulkYear2019() { _startBulkWithRange('2019', '2019'); }
function startBulkYear2020() { _startBulkWithRange('2020', '2020'); }
function startBulkYear2021() { _startBulkWithRange('2021', '2021'); }
function startBulkYear2022() { _startBulkWithRange('2022', '2022'); }
function startBulkYear2023() { _startBulkWithRange('2023', '2023'); }
function startBulkYear2024() { _startBulkWithRange('2024', '2024'); }
function startBulkYear2025() { _startBulkWithRange('2025', '2025'); }
function startBulkYear2026() { _startBulkWithRange('2026', '2026'); }

// wassa@ 用：2015〜2016年を処理
function startBulkReprocessBillingWassa() {
  _startBulkWithRange('2015', '2016');
}

function _startBulkWithRange(minYear, maxYear) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('bulk_status',   'active');
  props.setProperty('bulk_done',     '0');
  props.setProperty('bulk_skip',     '0');
  props.setProperty('bulk_error',    '0');
  props.setProperty('bulk_min_year', minYear || '2000');
  props.setProperty('bulk_max_year', maxYear || '2099');
  Logger.log('=== 一括請求取り込み開始 ' + minYear + '〜' + maxYear + ' ===');
  continueBulkReprocessBilling();
}

function stopBulkReprocessBilling() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('bulk_status');
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'continueBulkReprocessBilling') ScriptApp.deleteTrigger(t);
  });
  Logger.log('一括処理を中断しました。done=' + props.getProperty('bulk_done')
    + ' skip=' + props.getProperty('bulk_skip'));
}

function checkBulkBillingStatus() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('bulk_status') !== 'active') {
    Logger.log('処理は実行中ではありません');
    return;
  }
  Logger.log('処理中 — 成功: ' + props.getProperty('bulk_done')
    + '件 / スキップ: ' + props.getProperty('bulk_skip')
    + '件 / エラー: ' + props.getProperty('bulk_error') + '件');
}

// 年単位バッチ方式：1年分のメールをまとめて取得→メモリ上で全予約とマッチング
// Gmail API呼び出し回数を大幅削減（1件ずつ検索→1年分まとめて検索）
function continueBulkReprocessBilling() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('bulk_status') !== 'active') return;

  var startTime = new Date().getTime();
  var timeLimit = 4.5 * 60 * 1000;

  var done   = parseInt(props.getProperty('bulk_done')  || '0');
  var skip   = parseInt(props.getProperty('bulk_skip')  || '0');
  var errors = parseInt(props.getProperty('bulk_error') || '0');
  var minYear = props.getProperty('bulk_min_year') || '2000';
  var maxYear = props.getProperty('bulk_max_year') || '2099';

  var otaSources = ['楽天', 'じゃらん', '一休', 'Booking.com', 'Agoda', '公式HP'];
  var srcParam   = '(' + otaSources.map(function(s){ return encodeURIComponent(s); }).join(',') + ')';

  var subjectMap = {
    '楽天': 'subject:楽天トラベル',
    'じゃらん': 'subject:じゃらん',
    '一休': 'subject:一休',
    'Booking.com': 'subject:Booking.com',
    'Agoda': 'subject:Agoda',
    '公式HP': 'from:info@489ban.net OR subject:予約番'
  };

  while (new Date().getTime() - startTime < timeLimit) {
    // billing=null の最古のチェックイン日を取得（年範囲フィルタ付き）
    var minUrl = CONFIG.SUPABASE_URL + '/rest/v1/reservations'
      + '?billing=is.null&source=in.' + srcParam
      + '&check_in=gte.' + minYear + '-01-01'
      + '&check_in=lte.' + maxYear + '-12-31'
      + '&select=check_in&order=check_in.asc&limit=1';
    var minRes = UrlFetchApp.fetch(minUrl, {
      headers: {'apikey': CONFIG.SUPABASE_KEY, 'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY},
      muteHttpExceptions: true
    });
    var minData = null;
    try { minData = JSON.parse(minRes.getContentText()); } catch(e) { errors++; break; }

    if (!minData || !Array.isArray(minData) || minData.length === 0) {
      _finalizeBulkBilling(props, done, skip, errors);
      return;
    }

    var year = minData[0].check_in.slice(0, 4);

    // その年のbilling=null予約を全件取得（最大1000件）
    var batchUrl = CONFIG.SUPABASE_URL + '/rest/v1/reservations'
      + '?billing=is.null&source=in.' + srcParam
      + '&check_in=gte.' + year + '-01-01'
      + '&check_in=lte.' + year + '-12-31'
      + '&select=id,source,guest_name,check_in,reservation_no'
      + '&order=check_in.asc&limit=1000';
    var batchRes = UrlFetchApp.fetch(batchUrl, {
      headers: {'apikey': CONFIG.SUPABASE_KEY, 'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY},
      muteHttpExceptions: true
    });
    var batch = null;
    try { batch = JSON.parse(batchRes.getContentText()); } catch(e) { errors++; break; }

    if (!batch || !Array.isArray(batch) || batch.length === 0) break;

    Logger.log('=== 年次バッチ: ' + year + ' (' + batch.length + '件) ===');

    // Gmail検索: その年の6ヶ月前〜翌年1月末 に絞る（3年分→約18ヶ月に削減）
    // 予約メールは通常CI日の半年以内に届く
    var afterDate  = (parseInt(year) - 1) + '/07/01';
    var beforeDate = (parseInt(year) + 1) + '/01/31';

    // この年のbatchで必要なsourceを収集
    var sourcesNeeded = {};
    batch.forEach(function(r) { sourcesNeeded[r.source] = true; });

    // emailCache: source -> [{check_in, guest_name, billingRows, plan_name}]
    var emailCache = {};
    var timeOver = false;

    var srcKeys = Object.keys(sourcesNeeded);
    for (var si = 0; si < srcKeys.length; si++) {
      if (new Date().getTime() - startTime > timeLimit) { timeOver = true; break; }
      var src = srcKeys[si];
      emailCache[src] = [];

      var queries = [];
      if (src === '公式HP') {
        queries.push('subject:公式HP予約システム after:' + afterDate + ' before:' + beforeDate);
        queries.push('from:info@489ban.net after:' + afterDate + ' before:' + beforeDate);
        queries.push('subject:R-WITH after:' + afterDate + ' before:' + beforeDate);
        queries.push('from:jalan-yoyakutsutsi@jalan.net after:' + afterDate + ' before:' + beforeDate);
      } else if (subjectMap[src]) {
        queries.push(subjectMap[src] + ' after:' + afterDate + ' before:' + beforeDate);
      }

      for (var qi = 0; qi < queries.length; qi++) {
        if (new Date().getTime() - startTime > timeLimit) { timeOver = true; break; }
        try {
          var start = 0;
          while (start < 200) {
            if (new Date().getTime() - startTime > timeLimit) { timeOver = true; break; }
            var threads = GmailApp.search(queries[qi], start, 50);
            if (!threads || threads.length === 0) break;
            for (var ti = 0; ti < threads.length; ti++) {
              var msgs = threads[ti].getMessages();
              for (var mi = 0; mi < msgs.length; mi++) {
                try {
                  var body = msgs[mi].getPlainBody();
                  var parsed = parseEmail(src, body);
                  if (parsed && parsed.check_in) {
                    parsed._body = body;
                    var billingRows = buildBillingFromEmail(parsed);
                    emailCache[src].push({
                      check_in:        parsed.check_in,
                      guest_name:      (parsed.guest_name || '').replace(/[\s　]/g, ''),
                      reservation_no:  parsed.reservation_no || '',
                      billingRows:     billingRows || [],
                      plan_name:       parsed.plan_name || ''
                    });
                  }
                } catch(e2) {}
              }
            }
            start += 50;
            if (threads.length < 50) break;
          }
        } catch(e) {
          Logger.log('Gmail検索エラー [' + queries[qi] + ']: ' + e);
        }
      }
      Logger.log('  ' + src + ': ' + (emailCache[src] || []).length + '件のメール取得');
    }

    if (timeOver) {
      // 時間切れ：この年の処理は次回に持ち越し（billing=nullのまま）
      props.setProperty('bulk_done',  done.toString());
      props.setProperty('bulk_skip',  skip.toString());
      props.setProperty('bulk_error', errors.toString());
      _setBulkBillingTrigger();
      Logger.log('時間切れ・継続予約。成功: ' + done + ' スキップ: ' + skip);
      return;
    }

    // 各予約をemailCacheとマッチング
    for (var bi = 0; bi < batch.length; bi++) {
      if (new Date().getTime() - startTime > timeLimit) { timeOver = true; break; }
      var resv = batch[bi];
      var ciDate    = (resv.check_in || '').slice(0, 10);
      var nameClean = (resv.guest_name || '').replace(/[\s　]/g, '');
      var name3     = nameClean.slice(0, 3);

      var matched = null;

      // guest_nameがない場合は予約番号でGmail直接検索
      if (!resv.guest_name && resv.reservation_no) {
        var rNo = resv.reservation_no.trim();
        var rQueries = [];
        if (resv.source === '楽天') {
          rQueries.push('subject:楽天トラベル "' + rNo + '" after:' + afterDate + ' before:' + beforeDate);
          rQueries.push('from:sales@travel.rakuten.co.jp "' + rNo + '" after:' + afterDate + ' before:' + beforeDate);
        } else if (resv.source === '公式HP') {
          rQueries.push('subject:R-WITH "' + rNo + '" after:' + afterDate + ' before:' + beforeDate);
          rQueries.push('subject:公式HP予約システム "' + rNo + '" after:' + afterDate + ' before:' + beforeDate);
          rQueries.push(subjectMap['公式HP'] + ' "' + rNo + '" after:' + afterDate + ' before:' + beforeDate);
        } else if (subjectMap[resv.source]) {
          rQueries.push(subjectMap[resv.source] + ' "' + rNo + '" after:' + afterDate + ' before:' + beforeDate);
        }
        for (var rqi = 0; rqi < rQueries.length && !matched; rqi++) {
          try {
            var rThreads = GmailApp.search(rQueries[rqi], 0, 3);
            for (var rti = 0; rti < rThreads.length && !matched; rti++) {
              var rMsgs = rThreads[rti].getMessages();
              for (var rmi = 0; rmi < rMsgs.length && !matched; rmi++) {
                var rBody = rMsgs[rmi].getPlainBody();
                var rParsed = parseEmail(resv.source, rBody);
                if (rParsed && rParsed.check_in && rParsed.check_in.slice(0,10) === ciDate) {
                  rParsed._body = rBody;
                  var rBilling = buildBillingFromEmail(rParsed);
                  if (rBilling && rBilling.length > 0) {
                    matched = {billingRows: rBilling, plan_name: rParsed.plan_name || '', guest_name: rParsed.guest_name || ''};
                    // guest_nameをDBに反映
                    if (rParsed.guest_name) {
                      try {
                        UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/rest/v1/reservations?id=eq.' + resv.id, {
                          method: 'PATCH', contentType: 'application/json',
                          headers: {'apikey': CONFIG.SUPABASE_KEY, 'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY, 'Prefer': 'return=minimal'},
                          payload: JSON.stringify({guest_name: rParsed.guest_name}),
                          muteHttpExceptions: true
                        });
                      } catch(e3) {}
                    }
                  }
                }
              }
            }
          } catch(e2) { Logger.log('予約番号検索エラー [' + rNo + ']: ' + e2); }
        }
      } else {
        // guest_nameあり → まず予約番号でマッチング、次に日付+名前
        var cache = emailCache[resv.source] || [];
        var resvNo = (resv.reservation_no || '').trim();
        for (var k = 0; k < cache.length; k++) {
          var em = cache[k];
          // 予約番号が一致すれば確定
          if (resvNo && em.reservation_no && em.reservation_no.toUpperCase() === resvNo.toUpperCase()) { matched = em; break; }
          // 日付+名前マッチング
          var dateMatch = em.check_in && em.check_in.slice(0, 10) === ciDate;
          var eName3    = em.guest_name.slice(0, 3);
          var nameMatch = name3.length >= 2 && eName3.length >= 2 &&
                          (em.guest_name.indexOf(name3) !== -1 || nameClean.indexOf(eName3) !== -1);
          if (dateMatch && nameMatch && !matched) matched = em;
        }
      }

      if (matched && matched.billingRows && matched.billingRows.length > 0) {
        var mealInfo = detectMealPlan(matched.plan_name || '');
        var mealCode = mealInfo.hasBf && mealInfo.hasDin ? 'both'
                     : mealInfo.hasDin ? 'din' : mealInfo.hasBf ? 'bf' : 'none';
        var patch = {billing: matched.billingRows};
        if (matched.plan_name) patch.plan_name = matched.plan_name;
        if (mealCode !== 'none' || matched.plan_name) patch.meal = mealCode;
        try {
          var patchRes = UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/rest/v1/reservations?id=eq.' + resv.id, {
            method: 'PATCH',
            contentType: 'application/json',
            headers: {'apikey': CONFIG.SUPABASE_KEY, 'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY, 'Prefer': 'return=minimal'},
            payload: JSON.stringify(patch),
            muteHttpExceptions: true
          });
          if (patchRes.getResponseCode() >= 300) {
            Logger.log('❌ PATCH失敗 HTTP' + patchRes.getResponseCode() + ': ' + patchRes.getContentText().slice(0, 200));
            errors++;
          } else {
            done++;
            Logger.log('✅ ' + resv.guest_name + ' ' + resv.check_in + ' (' + matched.billingRows.length + '行)');
          }
        } catch(e) {
          _markBillingEmpty(resv.id);
          errors++;
          Logger.log('❌ ' + (resv.guest_name||'?') + ': ' + e.toString());
        }
      } else {
        _markBillingEmpty(resv.id);
        skip++;
        Logger.log('⏭ ' + (resv.guest_name||'?') + ' ' + (resv.check_in||'?') + ': メール未発見');
      }
    }

    props.setProperty('bulk_done',  done.toString());
    props.setProperty('bulk_skip',  skip.toString());
    props.setProperty('bulk_error', errors.toString());
    Logger.log('年次バッチ完了: ' + year + ' 累計: done=' + done + ' skip=' + skip);
  }

  // 時間切れ（while条件）
  props.setProperty('bulk_done',  done.toString());
  props.setProperty('bulk_skip',  skip.toString());
  props.setProperty('bulk_error', errors.toString());
  _setBulkBillingTrigger();
  Logger.log('時間切れ・継続予約。成功: ' + done + ' スキップ: ' + skip);
}

function _markBillingEmpty(reservationId) {
  try {
    UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/rest/v1/reservations?id=eq.' + reservationId, {
      method: 'PATCH',
      contentType: 'application/json',
      headers: {'apikey': CONFIG.SUPABASE_KEY, 'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY, 'Prefer': 'return=minimal'},
      payload: JSON.stringify({billing: []}),
      muteHttpExceptions: true
    });
  } catch(e) {}
}

function _setBulkBillingTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'continueBulkReprocessBilling') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('continueBulkReprocessBilling').timeBased().after(2 * 60 * 1000).create();
}

function _finalizeBulkBilling(props, done, skip, errors) {
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'continueBulkReprocessBilling') ScriptApp.deleteTrigger(t);
  });
  props.deleteProperty('bulk_status');
  props.deleteProperty('bulk_done');
  props.deleteProperty('bulk_skip');
  props.deleteProperty('bulk_error');
  var msg = '一括請求取り込みが完了しました。\n\n'
    + '取り込み成功: ' + done + '件\n'
    + 'スキップ（メールなし）: ' + skip + '件\n'
    + 'エラー: ' + errors + '件';
  Logger.log('=== 完了 ===\n' + msg);
  GmailApp.sendEmail('wassa@wassa-okinawa.com', '【一括請求取り込み完了】' + done + '件成功', msg);
}
