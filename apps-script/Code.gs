/**
 * Esan SmartDNA — รับแบบฟอร์มขอใบเสนอราคา (Google Apps Script Web App)
 *
 * ทำหน้าที่แทน FormSubmit:
 *  - ตรวจข้อมูลซ้ำฝั่ง server (ข้ามการตรวจในเบราว์เซอร์ไม่ได้)
 *  - จำกัดจำนวนครั้งที่ส่ง (กันสแปม)
 *  - อีเมลผู้รับเก็บใน Script Properties ไม่ปรากฏในหน้าเว็บ
 *  - บันทึกลง Google Sheet ของทีม และลบข้อมูลที่เก่ากว่า RETENTION_DAYS อัตโนมัติ (PDPA)
 *
 * วิธีติดตั้ง (ทำครั้งเดียว):
 *  1. สร้าง Google Sheet ใหม่ในบัญชีของทีม > Extensions > Apps Script > วางโค้ดนี้แทนของเดิม
 *  2. Project Settings > Script Properties เพิ่ม:
 *       RECIPIENT = yaowapa.ra@ksu.ac.th      (อีเมลที่รับแบบฟอร์ม คั่นหลายอีเมลด้วย ,)
 *  3. เลือกฟังก์ชัน setup แล้วกด Run หนึ่งครั้ง (อนุญาตสิทธิ์ส่งอีเมลและแก้ Sheet)
 *  4. Deploy > New deployment > Web app
 *       Execute as: Me   |   Who has access: Anyone
 *  5. คัดลอก URL ที่ลงท้าย /exec ไปใส่ในตัวแปร FORM_ENDPOINT ใน index.html
 *  ถ้าแก้โค้ดนี้ภายหลัง ต้อง Deploy > Manage deployments > Edit > New version
 */

const RETENTION_DAYS = 365;          // ระยะเวลาเก็บข้อมูลตามประกาศ PDPA
const NOTICE_VERSION = '2569-11-14'; // ต้องตรงกับฉบับประกาศ PDPA ในหน้าเว็บ
const PER_CONTACT_COOLDOWN_SEC = 120; // อีเมล/เบอร์เดียวกันส่งซ้ำได้ทุก 2 นาที
const MAX_PER_HOUR = 30;              // ส่งได้รวมไม่เกินชั่วโมงละ 30 ครั้ง

const COURSES = [
  'SmartLocal for Smart City',
  'โรงเรียนผู้สูงอายุ',
  'การใช้เทคโนโลยีดิจิทัลสำหรับยกระดับสู่ Smart Office และ Smart People',
  'การพัฒนาข้อมูลเมือง (City Data Platform)',
  'การบริหารจัดการสิ่งปฏิกูลในหน่วยงาน อปท.',
  'การบริหารจัดการขยะด้วยนวัตกรรมและเทคโนโลยี'
];
const LIMITS = { org: 120, name: 80, tel: 16, email: 100, people: 4, place: 60, note: 1000 };
const EMAIL_RE = /^[A-Za-z0-9_%+-]+(\.[A-Za-z0-9_%+-]+)*@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
const TEL_RE = /^(0[689]\d{8}|0[2-7]\d{7})$/;
const HEADERS = ['เวลารับ (server)', 'หน่วยงาน', 'ผู้ประสานงาน', 'เบอร์โทร', 'อีเมล', 'หลักสูตร', 'จำนวนคน', 'จังหวัด', 'รายละเอียด', 'ความยินยอม PDPA', 'ฉบับประกาศ'];

function setup() {
  const sh = sheet_();
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'purgeOld') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('purgeOld').timeBased().everyDays(1).atHour(3).create();
  if (!PropertiesService.getScriptProperties().getProperty('RECIPIENT')) {
    throw new Error('ยังไม่ได้ตั้ง Script Property ชื่อ RECIPIENT');
  }
}

function doGet() {
  return json_({ ok: true, service: 'esan-smartdna-quote' });
}

function doPost(e) {
  try {
    let p = {};
    if (e && e.postData && e.postData.contents) {
      try { p = JSON.parse(e.postData.contents); } catch (_) { p = e.parameter || {}; }
    } else if (e && e.parameter) {
      p = e.parameter;
    }

    // ช่องดักบอท: ตอบเหมือนสำเร็จ แต่ไม่บันทึกและไม่ส่งอีเมล
    if (clean_(p.qf_trap)) return json_({ ok: true });

    const d = {
      org: clean_(p.org), name: clean_(p.name), tel: normTel_(clean_(p.tel)),
      email: clean_(p.email), people: toAsciiDigits_(clean_(p.people)),
      place: clean_(p.place), note: clean_(p.note, true),
      courses: (Array.isArray(p.courses) ? p.courses : String(p.courses || '').split('|')).map(c => clean_(c)).filter(Boolean),
      consent: p.consent === true || p.consent === 'true' || p.consent === 'on'
    };

    const errs = [];
    if (!d.org) errs.push('กรุณากรอกชื่อหน่วยงาน');
    if (!d.name) errs.push('กรุณากรอกชื่อผู้ประสานงาน');
    if (!TEL_RE.test(d.tel)) errs.push('เบอร์โทรศัพท์ไม่ถูกต้อง');
    if (!EMAIL_RE.test(d.email)) errs.push('รูปแบบอีเมลไม่ถูกต้อง');
    if (d.people && !/^[1-9]\d{0,3}$/.test(d.people)) errs.push('จำนวนผู้เข้าอบรมต้องเป็นตัวเลข 1–9999');
    if (!d.courses.length || d.courses.some(c => COURSES.indexOf(c) < 0)) errs.push('กรุณาเลือกหลักสูตรจากรายการ');
    if (!d.consent) errs.push('ต้องให้ความยินยอมก่อนส่งข้อมูล');
    Object.keys(LIMITS).forEach(k => { if (String(d[k] || '').length > LIMITS[k]) errs.push('ข้อมูลยาวเกินกำหนด'); });
    if (errs.length) return json_({ ok: false, error: errs[0] });

    // จำกัดจำนวนครั้ง
    const cache = CacheService.getScriptCache();
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const keyContact = 'c_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, d.email.toLowerCase() + '|' + d.tel));
      if (cache.get(keyContact)) return json_({ ok: false, error: 'ได้รับข้อมูลจากท่านแล้ว กรุณารอสักครู่ก่อนส่งอีกครั้ง' });
      const hourKey = 'h_' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMddHH');
      const count = Number(cache.get(hourKey) || 0);
      if (count >= MAX_PER_HOUR) return json_({ ok: false, error: 'มีผู้ส่งข้อมูลจำนวนมากในขณะนี้ กรุณาลองใหม่ภายหลัง หรือโทร 065-2379665' });
      cache.put(hourKey, String(count + 1), 3600);
      cache.put(keyContact, '1', PER_CONTACT_COOLDOWN_SEC);
    } finally {
      lock.releaseLock();
    }

    const now = new Date();
    const stamp = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
    const consentText = 'ยินยอม ' + stamp + ' (Asia/Bangkok)';

    sheet_().appendRow([now, d.org, d.name, "'" + d.tel, d.email, d.courses.join(', '),
      d.people || '-', d.place || '-', d.note || '-', consentText, NOTICE_VERSION].map(sheetSafe_));

    const rows = [
      ['หน่วยงาน', d.org], ['ผู้ประสานงาน', d.name], ['เบอร์โทรศัพท์', d.tel], ['อีเมล', d.email],
      ['หลักสูตรที่สนใจ', d.courses.join(', ')], ['จำนวนผู้เข้าอบรม', d.people ? d.people + ' คน' : '-'],
      ['จังหวัดที่จัดอบรม', d.place || '-'], ['ช่วงเวลา / รายละเอียด', d.note || '-'],
      ['ความยินยอม PDPA', consentText + ' · ประกาศฉบับ ' + NOTICE_VERSION]
    ];
    const html = '<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">' +
      rows.map(r => '<tr><th style="text-align:left;padding:6px 10px;border:1px solid #ddd;background:#f3f7fc">' + esc_(r[0]) +
        '</th><td style="padding:6px 10px;border:1px solid #ddd;white-space:pre-wrap">' + esc_(r[1]) + '</td></tr>').join('') + '</table>';
    const text = rows.map(r => r[0] + ': ' + r[1]).join('\n');

    MailApp.sendEmail({
      to: PropertiesService.getScriptProperties().getProperty('RECIPIENT'),
      subject: 'ขอใบเสนอราคา: ' + d.org.slice(0, 80),
      body: text,
      htmlBody: html,
      replyTo: d.email,
      name: 'Esan SmartDNA แบบฟอร์มเว็บไซต์'
    });

    return json_({ ok: true });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'ระบบขัดข้องชั่วคราว กรุณาลองใหม่ หรือโทร 065-2379665' });
  }
}

/** ลบแถวที่เก่ากว่า RETENTION_DAYS (ทริกเกอร์รายวันจาก setup) */
function purgeOld() {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return;
  const cutoff = Date.now() - RETENTION_DAYS * 864e5;
  const dates = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = dates.length - 1; i >= 0; i--) {
    const t = dates[i][0] instanceof Date ? dates[i][0].getTime() : NaN;
    if (!isNaN(t) && t < cutoff) sh.deleteRow(i + 2);
  }
}

/* ---------- helpers ---------- */
function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName('คำขอใบเสนอราคา') || ss.insertSheet('คำขอใบเสนอราคา');
}
function clean_(v, multiline) {
  let s = String(v == null ? '' : v)
    .replace(/[​-‏‪-‮⁠-⁩﻿]/g, '') // zero-width + bidi override
    .replace(multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, ' ');
  return s.replace(/[ \t 　]+/g, ' ').trim();
}
function toAsciiDigits_(s) { return s.replace(/[๐-๙]/g, c => String(c.charCodeAt(0) - 0x0E50)); }
function normTel_(s) {
  s = toAsciiDigits_(s).replace(/[\s\-().]/g, '');
  if (/^\+660/.test(s)) s = s.slice(3); else if (/^\+66/.test(s)) s = '0' + s.slice(3);
  else if (/^00660/.test(s)) s = s.slice(4); else if (/^0066/.test(s)) s = '0' + s.slice(4);
  return s;
}
function esc_(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function sheetSafe_(v) { return (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v; } // กันสูตรใน Sheet
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
