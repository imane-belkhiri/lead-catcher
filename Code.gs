/**
 * Lead Catcher - Build 1, part 1
 *
 * What this file does, each time the Google Form is submitted:
 *   1. Gives the new row a Lead ID (LEAD-0001, LEAD-0002, ...) and the Status NEW.
 *   2. Basic check (no AI): empty fields, message too short, bad email -> REJECTED.
 *   3. Repeat check: same email + same message recently -> DUPLICATE.
 *   4. AI check (Gemini): is it a real lead? how urgent? one-line summary.
 *      Not a lead -> NOT A LEAD. AI not reachable -> stays NEW with the reason.
 *   5. Real lead -> email to the owner, then a confirmation email to the customer.
 *      Each send is stamped with its time, so a re-run never sends the same email twice.
 *   6. Saves the customer in HubSpot (CRM). All steps done -> DONE.
 *   7. Writes one line per step in the "Log" sheet.
 *
 * Safety nets (installed by setup):
 *   - Every 5 minutes, retryPending() re-tries any lead stuck in NEW (AI, Gmail or CRM was down).
 *     After 4 failed tries the lead becomes NEEDS HUMAN and the owner gets an email.
 *   - Every evening, dailySummary() emails the owner the requests the AI marked NOT A LEAD,
 *     so a real customer wrongly sorted by the AI is still seen by a human.
 *   - Demo switches: demoAiDown(), demoCrmDown(), demoAllUp() pretend a service is down.
 *
 * It only ADDS three columns at the end (Lead ID, Status, Reason).
 * It never deletes or changes what the person typed in the form.
 *
 */

// ---------- SETTINGS ----------
// Change these if your sheet or column names are different.
const CONFIG = {
  SPREADSHEET_ID: '1IGDYFNw_HusNGBVa9afk0IG7D33BET4dSkbxvQwsDN8', // the Lead Catcher sheet (from its URL)
  RESPONSES_SHEET: 'Réponses au formulaire 1', // where Google Forms saves the answers
  LOG_SHEET: 'Log',                            // created by the script if missing
  MIN_MESSAGE_LENGTH: 10,                      // shorter messages are REJECTED
  DUPLICATE_WINDOW_HOURS: 24,                  // same email + same message within this time = DUPLICATE
  LOCK_WAIT_SECONDS: 30,                       // how long to wait if another run is busy

  // Form columns (found by header name, so their order does not matter).
  COL_TIME: 'Horodateur',
  COL_NAME: 'Your name',
  COL_EMAIL: 'Your email',
  COL_PHONE: 'Your phone',
  COL_MESSAGE: 'What do you need?',

  // Columns the script adds at the end of the sheet if they are missing.
  COL_ID: 'Lead ID',
  COL_STATUS: 'Status',
  COL_REASON: 'Reason',
  COL_URGENCY: 'Urgency',
  COL_SUMMARY: 'Summary',
  COL_OWNER_SENT: 'Owner alerted',      // time the owner alert was sent (empty = not yet)
  COL_CUSTOMER_SENT: 'Customer emailed', // time the confirmation was sent (empty = not yet)
  COL_CRM: 'CRM contact',               // HubSpot contact ID (empty = not saved yet)
  COL_TRIES: 'Retries',                 // how many times retryPending() tried this lead

  // AI (Gemini). The key is NOT written here: it lives in
  // Project Settings > Script Properties, under the name GEMINI_API_KEY.
  // Emails.
  OWNER_EMAIL: 'imane.builds@gmail.com',   // who gets the alert for each real lead (ClimaFix's owner)
  BUSINESS_NAME: 'ClimaFix',
  // TEST MODE: while this is not empty, customer confirmations go to this address instead of
  // the customer (the test requests use fake emails like test1@example.com). Set to '' to go live.
  TEST_SEND_CUSTOMER_EMAILS_TO: 'imane.builds@gmail.com',

  // Retry and summary.
  RETRY_EVERY_MINUTES: 5,      // how often retryPending() runs
  MAX_TRIES: 4,                // after this many failed retries -> NEEDS HUMAN
  RETRY_MIN_AGE_MINUTES: 3,    // never retry a row younger than this (it may still be running)
  SUMMARY_HOUR: 18,            // dailySummary() runs around this hour (project time zone)

  // Tried in order. If one is busy or down (HTTP 429 or 5xx), the next one is used.
  // The fastest model goes first: a slow AI call keeps the lock and makes other leads wait.
  AI_MODELS: ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.8-flash'],
  AI_MAX_SECONDS: 90,          // stop trying more models after this long (the lead waits for a retry)
};


// ---------- RUN ONCE BY HAND ----------
/**
 * Installs the trigger that runs handleNewLead on every form submission.
 * Safe to run again: it does nothing if the trigger already exists.
 */
function setup() {
  const alreadyThere = ScriptApp.getProjectTriggers()
    .some(t => t.getHandlerFunction() === 'handleNewLead');

  if (alreadyThere) {
    console.log('Trigger already installed. Nothing to do.');
  } else {
    ScriptApp.newTrigger('handleNewLead')
      .forSpreadsheet(getSpreadsheet_())
      .onFormSubmit()
      .create();
    console.log('Trigger installed.');
  }
  // Time triggers: retry every few minutes, summary once a day. Each is added only once.
  const handlers = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  if (!handlers.includes('retryPending')) {
    ScriptApp.newTrigger('retryPending').timeBased().everyMinutes(CONFIG.RETRY_EVERY_MINUTES).create();
    console.log('Retry trigger installed.');
  }
  if (!handlers.includes('dailySummary')) {
    ScriptApp.newTrigger('dailySummary').timeBased().everyDays(1).atHour(CONFIG.SUMMARY_HOUR).create();
    console.log('Daily summary trigger installed.');
  }
  getLogSheet_(); // create the Log sheet now so you can see it
}


// ---------- RUN BY HAND WHEN NEEDED ----------
/**
 * Labels every row that has no Lead ID yet (for example if a run failed or timed out).
 * Safe to run again: rows that already have an ID are skipped.
 */
function processMissedRows() {
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.RESPONSES_SHEET);
  const col = getColumns_(sheet);
  const last = sheet.getLastRow();
  for (let r = 2; r <= last; r++) {
    const id = sheet.getRange(r, col.id + 1).getValue();
    if (!id) handleNewLead({ range: sheet.getRange(r, 1) });
  }
}


// ---------- RUNS BY ITSELF (time triggers) ----------
/**
 * Every few minutes: finds leads stuck in NEW (a step failed) and runs them again.
 * Steps already done are skipped (emails and CRM are stamped), so nothing is sent twice.
 * After MAX_TRIES failed retries, the lead becomes NEEDS HUMAN and the owner gets an email.
 */
function retryPending() {
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.RESPONSES_SHEET);
  const col = getColumns_(sheet);
  const data = sheet.getDataRange().getValues();
  const minAgeMs = CONFIG.RETRY_MIN_AGE_MINUTES * 60 * 1000;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rowNumber = i + 1;
    if (!row[col.id] || row[col.status] !== 'NEW') continue;                    // only stuck leads
    if (Date.now() - new Date(row[col.time]).getTime() < minAgeMs) continue;   // maybe still running

    // The Retries column sits next to date columns and can inherit a date format, so read it carefully.
    const rawTries = row[col.tries];
    const tries = (typeof rawTries === 'number' && rawTries >= 0) ? rawTries : 0;
    if (tries >= CONFIG.MAX_TRIES) {
      setStatus_(sheet, rowNumber, col, 'NEEDS HUMAN', 'Failed ' + tries + ' retries. Last: ' + row[col.reason]);
      log_(row[col.id], 'retry', 'NEEDS HUMAN', 'Gave up after ' + tries + ' retries');
      try {
        sendNeedsHumanEmail_(row, col);
      } catch (mailErr) {
        log_(row[col.id], 'needs human email', 'ERROR', mailErr.message);
      }
      continue;
    }
    // If another run holds the lock, stop here: this does not count as a try, the next timer run will continue.
    const ran = handleNewLead({ range: sheet.getRange(rowNumber, 1) });
    if (ran === false) {   // (other early returns give undefined, which means it did run)
      log_(row[col.id], 'retry', 'SKIPPED', 'Another run is busy. Will try at the next timer run.');
      return;
    }
    sheet.getRange(rowNumber, col.tries + 1).setNumberFormat('0').setValue(tries + 1);
    log_(row[col.id], 'retry', 'OK', 'Try ' + (tries + 1) + ' of ' + CONFIG.MAX_TRIES + ' done');
  }
}

/**
 * Once a day: emails the owner every request the AI marked NOT A LEAD in the last 24 hours,
 * plus any NEEDS HUMAN lead, so nothing the AI got wrong stays hidden in the sheet.
 */
function dailySummary() {
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.RESPONSES_SHEET);
  const col = getColumns_(sheet);
  const data = sheet.getDataRange().getValues();
  const since = Date.now() - 24 * 60 * 60 * 1000;

  const notLeads = [];
  const needsHuman = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const line = row[col.id] + ' | ' + row[col.name] + ' | ' + row[col.email] + ' | ' + row[col.message];
    if (row[col.status] === 'NEEDS HUMAN') needsHuman.push(line + ' | ' + row[col.reason]);
    if (row[col.status] === 'NOT A LEAD' && new Date(row[col.time]).getTime() >= since) {
      notLeads.push(line + ' | AI: ' + row[col.reason]);
    }
  }
  if (!notLeads.length && !needsHuman.length) {
    log_('', 'daily summary', 'OK', 'Nothing to report');
    return;
  }
  const body = [
    'Daily check of your quote form.',
    '',
    'Leads that need you (' + needsHuman.length + '):',
    needsHuman.length ? needsHuman.join('\n') : '(none)',
    '',
    'Messages the AI marked NOT A LEAD in the last 24 hours (' + notLeads.length + '):',
    notLeads.length ? notLeads.join('\n') : '(none)',
    '',
    'If one of them is a real customer, answer them from the sheet.',
  ].join('\n');
  MailApp.sendEmail(CONFIG.OWNER_EMAIL, CONFIG.BUSINESS_NAME + ' daily check: ' +
    needsHuman.length + ' need you, ' + notLeads.length + ' marked not a lead', body);
  log_('', 'daily summary', 'OK', needsHuman.length + ' needs human, ' + notLeads.length + ' not a lead');
}

/** Emails the owner when a lead could not be processed after all retries. */
function sendNeedsHumanEmail_(row, col) {
  const body = [
    'This request could not be processed automatically after ' + CONFIG.MAX_TRIES + ' retries.',
    'Please answer the customer yourself.',
    '',
    'Lead ID: ' + row[col.id],
    'Problem: ' + row[col.reason],
    '',
    'Name: ' + row[col.name],
    'Email: ' + row[col.email],
    'Phone: ' + (row[col.phone] || '(not given)'),
    'Message: ' + row[col.message],
  ].join('\n');
  MailApp.sendEmail({ to: CONFIG.OWNER_EMAIL, subject: 'NEEDS HUMAN: ' + row[col.id] + ' could not be processed',
    body: body, replyTo: String(row[col.email]) });
}


// ---------- DEMO SWITCHES (for the video) ----------
/** Pretend Gemini is down: new leads stay NEW, then retries, then NEEDS HUMAN. */
function demoAiDown() { setSwitch_('SIMULATE_AI_DOWN', 'yes'); }
/** Pretend HubSpot is down: emails still go out, the CRM step waits for a retry. */
function demoCrmDown() { setSwitch_('SIMULATE_CRM_DOWN', 'yes'); }
/** Turn every demo switch off: everything works normally again. */
function demoAllUp() {
  setSwitch_('SIMULATE_AI_DOWN', 'no');
  setSwitch_('SIMULATE_CRM_DOWN', 'no');
}
function setSwitch_(name, value) {
  PropertiesService.getScriptProperties().setProperty(name, value);
  console.log(name + ' = ' + value);
  log_('', 'demo switch', 'OK', name + ' = ' + value);
}


// ---------- RUNS ON EVERY FORM SUBMISSION ----------
/**
 * @param {Object} e  The event Google sends. e.range is the new row.
 *                    If you run this by hand (no e), it uses the last row.
 */
function handleNewLead(e) {
  // The lock makes sure two submissions never run at the same time.
  // If another run is busy, we wait. If it takes too long, we log it and stop.
  // The form answer is still safe in the sheet.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_SECONDS * 1000)) {
    const row = e && e.range ? e.range.getRow() : '?';
    log_('', 'lock', 'ERROR', 'Another run was busy too long. Row ' + row + ' was not processed (it stays safe in the sheet).');
    return false; // tells retryPending that nothing was done
  }

  let leadId = ''; // known after step 1, used in the log
  try {
    const sheet = getSpreadsheet_().getSheetByName(CONFIG.RESPONSES_SHEET);
    if (!sheet) throw new Error('Sheet not found: "' + CONFIG.RESPONSES_SHEET + '"');

    const col = getColumns_(sheet);                   // where each column is
    const data = sheet.getDataRange().getValues();    // all rows; data[0] is the header row
    const rowNumber = e && e.range ? e.range.getRow() : sheet.getLastRow();
    const row = data[rowNumber - 1];                  // rows start at 1, the list starts at 0

    // Step 1: label the row. Keep its ID if it already has one (for example a re-run).
    leadId = row[col.id] || nextLeadId_(data, col.id);
    sheet.getRange(rowNumber, col.id + 1).setValue(leadId);
    setStatus_(sheet, rowNumber, col, 'NEW', '');
    log_(leadId, 'received', 'OK', 'Row ' + rowNumber);

    // Step 2: basic check.
    const problem = basicCheck_(row, col);
    if (problem) {
      setStatus_(sheet, rowNumber, col, 'REJECTED', problem);
      log_(leadId, 'checked', 'REJECTED', problem);
      return;
    }
    log_(leadId, 'checked', 'OK', '');

    // Step 3: duplicate check.
    const originalId = findDuplicate_(data, rowNumber - 1, col);
    if (originalId) {
      setStatus_(sheet, rowNumber, col, 'DUPLICATE', 'Same as ' + originalId);
      log_(leadId, 'duplicate check', 'DUPLICATE', 'Same as ' + originalId);
      return;
    }
    log_(leadId, 'duplicate check', 'OK', 'No duplicate found');

    // Step 4: AI check. If the AI is down, the lead stays NEW (never lost) and the reason says why.
    let ai;
    try {
      ai = classifyWithAI_(row[col.message]);
    } catch (aiErr) {
      setStatus_(sheet, rowNumber, col, 'NEW', 'AI failed: ' + aiErr.message);
      log_(leadId, 'ai check', 'ERROR', aiErr.message);
      return;
    }
    sheet.getRange(rowNumber, col.urgency + 1).setValue(ai.urgency);
    sheet.getRange(rowNumber, col.summary + 1).setValue(ai.summary);
    if (!ai.is_lead) {
      setStatus_(sheet, rowNumber, col, 'NOT A LEAD', ai.reason);
      log_(leadId, 'ai check', 'NOT A LEAD', ai.reason);
      return;
    }
    setStatus_(sheet, rowNumber, col, 'NEW', 'Real lead (' + ai.urgency + ')');
    log_(leadId, 'ai check', 'OK', 'Lead, urgency ' + ai.urgency);

    // Step 5: alert the owner. The time is written in "Owner alerted", so a re-run never sends it twice.
    if (!row[col.ownerSent]) {
      try {
        sendOwnerAlert_(leadId, row, col, ai);
        sheet.getRange(rowNumber, col.ownerSent + 1).setValue(new Date());
        log_(leadId, 'owner alert', 'OK', 'Sent to ' + CONFIG.OWNER_EMAIL);
      } catch (mailErr) {
        setStatus_(sheet, rowNumber, col, 'NEW', 'Owner alert failed: ' + mailErr.message);
        log_(leadId, 'owner alert', 'ERROR', mailErr.message);
        return;
      }
    }

    // Step 6: confirm to the customer. Same rule: the time in "Customer emailed" stops a second send.
    if (!row[col.customerSent]) {
      try {
        const to = sendCustomerConfirmation_(row, col);
        sheet.getRange(rowNumber, col.customerSent + 1).setValue(new Date());
        log_(leadId, 'customer email', 'OK', 'Sent to ' + to);
      } catch (mailErr) {
        setStatus_(sheet, rowNumber, col, 'NEW', 'Customer email failed: ' + mailErr.message);
        log_(leadId, 'customer email', 'ERROR', mailErr.message);
        return;
      }
    }

    // Step 7: save the customer in HubSpot. "Upsert" = create, or update if the email already exists,
    // so a re-run never creates a second contact.
    if (!row[col.crm]) {
      try {
        const contactId = upsertHubSpotContact_(row, col);
        sheet.getRange(rowNumber, col.crm + 1).setValue(contactId);
        log_(leadId, 'crm', 'OK', 'HubSpot contact ' + contactId);
      } catch (crmErr) {
        setStatus_(sheet, rowNumber, col, 'NEW', 'CRM failed: ' + crmErr.message);
        log_(leadId, 'crm', 'ERROR', crmErr.message);
        return;
      }
    }
    setStatus_(sheet, rowNumber, col, 'DONE', 'Owner alerted, customer emailed, saved in CRM');
    log_(leadId, 'done', 'DONE', '');

  } catch (err) {
    // Something broke. Log it. The Status stays NEW, so the lead is not lost.
    log_(leadId, 'error', 'ERROR', err.message);
  } finally {
    SpreadsheetApp.flush(); // save all changes before the next run can start
    lock.releaseLock();
  }
  return true;
}


// ---------- HELPERS ----------
// (A name ending in "_" hides the function from the Run menu.)

/** Opens the Lead Catcher sheet by its ID (works even if the script is not attached to the sheet). */
function getSpreadsheet_() {
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

/**
 * Finds every column by its header name and returns its position (0 = column A).
 * Adds Lead ID, Status and Reason at the end if they are missing.
 */
function getColumns_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h).trim());

  [CONFIG.COL_ID, CONFIG.COL_STATUS, CONFIG.COL_REASON, CONFIG.COL_URGENCY, CONFIG.COL_SUMMARY,
   CONFIG.COL_OWNER_SENT, CONFIG.COL_CUSTOMER_SENT, CONFIG.COL_CRM, CONFIG.COL_TRIES].forEach(name => {
    if (!headers.includes(name)) {
      headers.push(name);
      sheet.getRange(1, headers.length).setValue(name);
    }
  });

  const find = name => {
    const i = headers.indexOf(name);
    if (i === -1) throw new Error('Column not found: "' + name + '"');
    return i;
  };

  return {
    time: find(CONFIG.COL_TIME),
    name: find(CONFIG.COL_NAME),
    email: find(CONFIG.COL_EMAIL),
    phone: find(CONFIG.COL_PHONE),
    message: find(CONFIG.COL_MESSAGE),
    id: find(CONFIG.COL_ID),
    status: find(CONFIG.COL_STATUS),
    reason: find(CONFIG.COL_REASON),
    urgency: find(CONFIG.COL_URGENCY),
    summary: find(CONFIG.COL_SUMMARY),
    ownerSent: find(CONFIG.COL_OWNER_SENT),
    customerSent: find(CONFIG.COL_CUSTOMER_SENT),
    crm: find(CONFIG.COL_CRM),
    tries: find(CONFIG.COL_TRIES),
  };
}

/** Looks at all existing IDs and returns the next one, e.g. LEAD-0007. */
function nextLeadId_(data, idCol) {
  let highest = 0;
  data.forEach(r => {
    const match = String(r[idCol]).match(/^LEAD-(\d+)$/);
    if (match) highest = Math.max(highest, Number(match[1]));
  });
  return 'LEAD-' + String(highest + 1).padStart(4, '0');
}

/** Writes the Status and Reason cells of one row. */
function setStatus_(sheet, rowNumber, col, status, reason) {
  sheet.getRange(rowNumber, col.status + 1).setValue(status);
  sheet.getRange(rowNumber, col.reason + 1).setValue(reason);
}

/** Returns the reason the request is rejected, or '' if it looks fine. */
function basicCheck_(row, col) {
  const name = String(row[col.name]).trim();
  const email = String(row[col.email]).trim();
  const message = String(row[col.message]).trim();

  if (!name) return 'Name is empty';
  if (!email) return 'Email is empty';
  if (!message) return 'Message is empty';
  if (message.length < CONFIG.MIN_MESSAGE_LENGTH) {
    return 'Message is shorter than ' + CONFIG.MIN_MESSAGE_LENGTH + ' characters';
  }
  // Simple shape: something@something.something, no spaces.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Email format is not valid';
  return '';
}

/**
 * Looks for an earlier row (not REJECTED, already labelled) with the same email
 * and the same message, sent within the duplicate window. Returns its Lead ID, or ''.
 */
function findDuplicate_(data, index, col) {
  const me = data[index];
  const email = cleanEmail_(me[col.email]);
  const message = cleanMessage_(me[col.message]);
  const myTime = new Date(me[col.time]).getTime();
  const windowMs = CONFIG.DUPLICATE_WINDOW_HOURS * 60 * 60 * 1000;

  for (let i = 1; i < data.length; i++) { // start at 1 to skip the header row
    const other = data[i];
    if (i === index || !other[col.id] || other[col.status] === 'REJECTED') continue;

    const age = myTime - new Date(other[col.time]).getTime(); // how much earlier it was sent
    if (!(age >= 0 && age <= windowMs)) continue;              // later, too old, or no date

    if (cleanEmail_(other[col.email]) === email &&
        cleanMessage_(other[col.message]) === message) {
      return other[col.id];
    }
  }
  return '';
}

/** "  Bob@Mail.com " -> "bob@mail.com" */
function cleanEmail_(value) {
  return String(value).trim().toLowerCase();
}

/** "  Need   a QUOTE " -> "need a quote" */
function cleanMessage_(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Asks Gemini whether the message is a real customer request.
 * The AI must answer in a fixed shape (JSON with exactly these fields), so the code
 * never has to guess what it meant. Throws an error if the AI is unreachable or
 * answers in the wrong shape; the caller keeps the lead safe in that case.
 */
function classifyWithAI_(message) {
  if (isSwitchOn_('SIMULATE_AI_DOWN')) throw new Error('AI is down (demo switch SIMULATE_AI_DOWN is on)');
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY is missing in Script Properties');

  const prompt =
    'You sort messages sent through the quote form of ClimaFix, a small AC repair company.\n' +
    'Decide if the message is a real customer request for ClimaFix (repair, install, service, quote),\n' +
    'how urgent it is, and summarise it in one short sentence.\n' +
    'Spam, tests, ads, job offers and messages unrelated to AC work are not leads.\n' +
    'Urgency: high = no cooling or heating now, leak, or the customer says it is urgent;\n' +
    'normal = wants work soon; low = questions or no date.\n\n' +
    'Message:\n"""' + String(message) + '"""';

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          is_lead: { type: 'BOOLEAN' },
          urgency: { type: 'STRING', enum: ['high', 'normal', 'low'] },
          summary: { type: 'STRING' },
          reason: { type: 'STRING' },
        },
        required: ['is_lead', 'urgency', 'summary', 'reason'],
      },
    },
  };

  // Try each model in order. A busy model (429) or a server error (5xx) moves on to the next one.
  // Any other error (wrong key, bad request) stops right away: another model would not fix it.
  let res = null;
  const errors = [];
  const started = Date.now();
  for (const model of CONFIG.AI_MODELS) {
    if (Date.now() - started > CONFIG.AI_MAX_SECONDS * 1000) {
      errors.push('stopped after ' + CONFIG.AI_MAX_SECONDS + ' s');
      break;
    }
    res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': key },   // the key travels in a header, never in the URL
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
      });
    const code = res.getResponseCode();
    if (code === 200) break;
    errors.push(model + ' HTTP ' + code);
    if (code !== 429 && code < 500) {
      throw new Error('Gemini HTTP ' + code + ': ' + res.getContentText().slice(0, 200));
    }
    res = null;
  }
  if (!res) throw new Error('All AI models busy or down: ' + errors.join(', '));

  const text = JSON.parse(res.getContentText()).candidates[0].content.parts[0].text;
  const out = JSON.parse(text);
  if (typeof out.is_lead !== 'boolean' || !['high', 'normal', 'low'].includes(out.urgency)) {
    throw new Error('Gemini answered in the wrong shape: ' + text.slice(0, 200));
  }
  return out;
}

/** Emails the owner: who, how urgent, what they need, and how to reply. */
function sendOwnerAlert_(leadId, row, col, ai) {
  const urgent = ai.urgency === 'high' ? 'URGENT ' : '';
  const subject = urgent + 'New quote request ' + leadId + ': ' + ai.summary;
  const body = [
    'New request from your quote form.',
    '',
    'Lead ID: ' + leadId,
    'Urgency: ' + ai.urgency,
    'Summary: ' + ai.summary,
    '',
    'Name: ' + row[col.name],
    'Email: ' + row[col.email],
    'Phone: ' + (row[col.phone] || '(not given)'),
    'Message: ' + row[col.message],
    '',
    'Reply to this email to answer the customer directly.',
  ].join('\n');
  MailApp.sendEmail({ to: CONFIG.OWNER_EMAIL, subject: subject, body: body, replyTo: String(row[col.email]) });
}

/** Emails the customer a short confirmation. Returns the address it was sent to. */
function sendCustomerConfirmation_(row, col) {
  const to = CONFIG.TEST_SEND_CUSTOMER_EMAILS_TO || String(row[col.email]);
  const testNote = CONFIG.TEST_SEND_CUSTOMER_EMAILS_TO ? '[TEST, real customer: ' + row[col.email] + '] ' : '';
  const body = [
    'Hello ' + row[col.name] + ',',
    '',
    'Thank you for contacting ' + CONFIG.BUSINESS_NAME + '. We received your request:',
    '"' + row[col.message] + '"',
    '',
    'We will reply within 24 hours. If it is urgent, reply to this email.',
    '',
    CONFIG.BUSINESS_NAME,
  ].join('\n');
  MailApp.sendEmail({
    to: to,
    subject: testNote + 'We received your request - ' + CONFIG.BUSINESS_NAME,
    body: body,
    replyTo: CONFIG.OWNER_EMAIL,
    name: CONFIG.BUSINESS_NAME,
  });
  return to;
}

/**
 * Creates the customer in HubSpot, or updates them if a contact with this email already exists.
 * Returns the HubSpot contact ID. Throws if HubSpot is unreachable or refuses.
 */
function upsertHubSpotContact_(row, col) {
  if (isSwitchOn_('SIMULATE_CRM_DOWN')) throw new Error('CRM is down (demo switch SIMULATE_CRM_DOWN is on)');
  const token = PropertiesService.getScriptProperties().getProperty('HUBSPOT_TOKEN');
  if (!token) throw new Error('HUBSPOT_TOKEN is missing in Script Properties');

  const email = cleanEmail_(row[col.email]);
  const body = {
    inputs: [{
      idProperty: 'email',
      id: email,
      properties: {
        email: email,
        firstname: String(row[col.name]).trim(),
        phone: String(row[col.phone] || '').trim(),
        message: String(row[col.message]).trim(),
      },
    }],
  };
  const res = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('HubSpot HTTP ' + code + ': ' + res.getContentText().slice(0, 200));
  }
  return JSON.parse(res.getContentText()).results[0].id;
}

/** True if a demo switch (a Script Property) is set to "yes". */
function isSwitchOn_(name) {
  return PropertiesService.getScriptProperties().getProperty(name) === 'yes';
}

/** Run by hand to check the AI works: look at the Execution log. */
function testAI() {
  console.log(JSON.stringify(classifyWithAI_('My AC stopped cooling, I need a repair quote this week')));
  console.log(JSON.stringify(classifyWithAI_('Buy cheap followers now!!! click here')));
}

/** Adds one line to the Log sheet: Time, Lead ID, Step, Result, Details. */
function log_(leadId, step, result, details) {
  getLogSheet_().appendRow([new Date(), leadId, step, result, details]);
}

/** Returns the Log sheet, creating it with its headers if it does not exist. */
function getLogSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.LOG_SHEET);
    sheet.appendRow(['Time', 'Lead ID', 'Step', 'Result', 'Details']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Run by hand: lists the Gemini models this key can use (names only). */
function listModels() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true });
  const models = (JSON.parse(res.getContentText()).models || [])
    .filter(x => (x.supportedGenerationMethods || []).includes('generateContent'))
    .map(x => x.name.replace('models/', ''));
  console.log(models.join('\n'));
}

/** Run by hand: says which keys are set (never prints the keys themselves) and lists the triggers. */
function checkSetup() {
  const props = PropertiesService.getScriptProperties();
  ['GEMINI_API_KEY', 'HUBSPOT_TOKEN', 'SIMULATE_AI_DOWN', 'SIMULATE_CRM_DOWN'].forEach(name => {
    const value = props.getProperty(name);
    const shown = name.startsWith('SIMULATE') ? String(value) : (value ? 'set' : 'MISSING');
    console.log(name + ': ' + shown);
  });
  console.log('Triggers: ' + ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction()).join(', '));
}
