/**
 * Question Desk server code: session summaries by email.
 * Apps Script runs every server file as one program; see Code.js for settings and routing.
 */

// ---------------------------------------------------------------- summaries

function sendSummary_(session, recipients) {
  const to = parseEmails_(recipients);
  if (!to.length) return 0;
  checkQuota_(to.length);

  const brand = brand_(session);
  const filename = session.name.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-') || 'session';

  // Everyone gets their own language, and their own message, so outside recipients don't see
  // everyone else's address. The questions are read once per language, not once per person.
  const byLanguage = {};
  to.forEach(function (address) {
    const lang = appLanguage_(address);
    (byLanguage[lang] = byLanguage[lang] || []).push(address);
  });
  Object.keys(byLanguage).forEach(function (lang) {
    const content = summaryContent_(session, brand, lang);
    const csv = [content.header].concat(content.rows).map(function (r) { return r.map(csvCell_).join(','); }).join('\r\n');
    const blob = Utilities.newBlob('\ufeff' + csv, 'text/csv', filename + '-questions.csv');
    byLanguage[lang].forEach(function (address) {
      MailApp.sendEmail({
        to: address,
        subject: brand.eventName
          ? t_('mail.summarySubjectEvent', { event: brand.eventName, name: session.name }, lang)
          : t_('mail.summarySubject', { name: session.name }, lang),
        htmlBody: emailShell_(brand, t_('mail.summaryTitle', { name: esc_(session.name) }, lang), content.body),
        attachments: [blob],
        name: brand.orgName || 'Question Desk'
      });
    });
  });
  updateSession_(session.id, function (s) { s.summarySent = Date.now(); delete s.summaryPending; });
  return to.length;
}

/** One session's summary: the email body (topics and every question) and CSV rows. */
function summaryContent_(session, brand, lang) {
  flushInbox_(session.id);
  const rows = sessionRows_(session.id);
  const records = topicRecords_(session.id);
  const votes = votesFor_(session.id);
  const tz = Session.getScriptTimeZone();
  const fmt = function (ms) { return ms ? Utilities.formatDate(new Date(ms), tz, 'MMM d, yyyy h:mm a') : '—'; };
  const merged = function (t) { return records[t] && records[t].merged ? records[t].merged : ''; };

  const kept = rows.filter(function (q) { return q.status !== 'dismissed'; });
  const notGrouped = t_('mail.summaryNotGrouped', null, lang);
  const groups = {};
  kept.forEach(function (q) {
    const t = q.topic || notGrouped;
    (groups[t] = groups[t] || []).push(q);
  });
  const weight = function (t) { return groups[t].length + (votes[t] || 0); };
  const order = Object.keys(groups).sort(function (a, b) { return weight(b) - weight(a); });

  let body = '<p style="color:#5c6874;margin:0 0 20px">' +
    esc_(fmt(session.started)) + ' – ' + esc_(fmt(session.ended)) + '<br>' +
    esc_(t_('mail.summaryCounts', {
      questions: kept.length,
      topics: order.length,
      dismissed: rows.length - kept.length ? t_('mail.summaryDismissed', { n: rows.length - kept.length }, lang) : ''
    }, lang)) + '</p>';

  order.forEach(function (topic) {
    body += '<h2 style="font-size:16px;margin:24px 0 8px;border-left:4px solid ' + brand.accent + ';padding-left:8px">' + esc_(topic) +
      ' <span style="color:#5c6874;font-weight:400">(' + groups[topic].length +
      (votes[topic] ? esc_(t_('mail.summaryMeToo', { n: votes[topic] }, lang)) : '') + ')' +
      (records[topic] && records[topic].shown ? esc_(t_('mail.summaryShown', null, lang)) : '') + '</span></h2>';
    if (merged(topic)) {
      body += '<p style="background:#fffdf5;border-left:3px solid #d9c27a;padding:8px 12px;margin:0 0 8px">' +
        esc_(merged(topic)) + '</p>';
    }
    body += '<ul style="margin:0;padding-left:20px">' + groups[topic].map(function (q) {
      // Always keep what was actually asked. Non-English questions show the English
      // translation and the original wording; untranslated ones say so.
      const small = '<br><span style="color:#5c6874;font-size:13px">';
      const tick = q.status === 'answered' ? '<span style="color:' + brand.accent + '">✓ </span>' : '';
      let item;
      if (!q.translation) {
        item = esc_(q.text) + small + esc_(t_('mail.summaryUntranslated', null, lang)) +
          (q.lang ? esc_(t_('mail.summaryUntranslatedLang', { lang: q.lang }, lang)) : '') + '</span>';
      } else if (sameLanguage_(q)) {
        item = esc_(q.text);
      } else {
        item = esc_(q.translation) + small +
          esc_(t_('mail.summaryOriginal', { lang: q.lang || t_('mail.summaryUnknownLanguage', null, lang) }, lang)) +
          esc_(q.text) + '</span>';
      }
      const single = !q.topic && votes[singleKey_(q.id)]
        ? small + esc_(t_('mail.summarySingleMeToo', { n: votes[singleKey_(q.id)] }, lang)) + '</span>' : '';
      return '<li style="margin-bottom:8px">' + tick + item + single + '</li>';
    }).join('') + '</ul>';
  });

  const header = ['ID', 'Submitted', 'Status', 'Topic', 'Original language', 'Original question',
                  CONFIG.moderatorLanguage + ' translation', 'Merged question for topic', 'Me too (topic)',
                  'Topic shown on phones'];
  const csvRows = rows.map(function (q) {
    const translation = q.translation || (sameLanguage_(q) ? q.text : '(not translated)');
    return [q.id, fmt(q.submitted), q.status, q.topic, q.lang, q.text, translation, merged(q.topic),
            q.topic ? votes[q.topic] || 0 : votes[singleKey_(q.id)] || 0,
            (q.topic ? records[q.topic] && records[q.topic].shown : (session.shownQuestions || []).indexOf(q.id) !== -1) ? 'yes' : 'no'];
  });
  return { body: body, header: header, rows: csvRows, questions: kept.length, topics: order.length };
}

/** True when the question was asked in the moderator language (no separate translation needed). */
function sameLanguage_(q) {
  // Language wins when known: Gemini echoing a Korean question back is not a translation.
  if (q.lang) return String(q.lang).toLowerCase() === CONFIG.moderatorLanguage.toLowerCase();
  return !!q.translation && q.translation === q.text;
}

function emailShell_(brand, title, inner) {
  return '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#16202b;max-width:640px;line-height:1.5">' +
    '<div style="border-top:4px solid ' + brand.accent + ';padding-top:12px">' +
    '<p style="color:#5c6874;font-size:13px;margin:0 0 4px">' + esc_(brand.orgName || 'Question Desk') + '</p>' +
    '<h1 style="font-size:20px;margin:0 0 16px">' + title + '</h1>' + inner +
    (brand.footer ? '<p style="color:#5c6874;font-size:13px;margin:28px 0 0;border-top:1px solid #d9dee3;padding-top:10px">' + esc_(brand.footer) + '</p>' : '') +
    '</div></div>';
}

function checkQuota_(needed) {
  const left = MailApp.getRemainingDailyQuota();
  if (left < needed) throw new Error(t_('err.emailQuota', { left: left }));
}
