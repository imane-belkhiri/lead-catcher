# Lead Catcher

A small system for a service business (example: ClimaFix, an AC repair company) that makes sure **no quote request is ever lost**, even when the AI, Gmail or the CRM is down.

Built with free tools: Google Forms, Google Sheets, Google Apps Script, Gemini (AI), HubSpot (CRM), Gmail.

## What it does

When a customer sends the quote form:

1. **Google saves the request in the sheet first**, before any of my code runs. If my code breaks, the request is still there.
2. The script gives it a **Lead ID** (LEAD-0001, LEAD-0002, …) and the status **NEW**.
3. **Basic check (no AI):** empty fields, message shorter than 10 characters, or a bad email → **REJECTED**.
4. **Duplicate check:** same email + same message within 1 hour → **DUPLICATE** (real double-sends happen within minutes). Duplicates are listed in the owner's daily email, so a real customer is never hidden.
5. **AI check (Gemini):** real customer or not, how urgent (high / normal / low), one-line summary. The AI must answer in a fixed format. Spam and ads → **NOT A LEAD**.
6. **Email to the owner** with the request and the AI summary. "URGENT" in the subject when urgency is high. Replying goes straight to the customer.
7. **Confirmation email to the customer.**
8. **Saved in HubSpot** as a contact (created, or updated if the email already exists), with the AI's notes (urgency + summary) and the customer's message.
9. All steps done → **DONE**.

Every step writes a line in the **Log** tab, so "what happened to this lead?" has an answer in 10 seconds.

## What happens when something breaks

| Problem | What the system does |
|---|---|
| My code crashes | The request is already in the sheet. The error is in the Log. `processMissedRows` labels any row the script missed. |
| Two requests arrive at the same second | A lock makes them run one after the other. |
| The AI is busy or down | It tries 3 Gemini models in order. If all fail, the lead stays **NEW** with the reason. |
| Gmail or HubSpot is down | The lead stays **NEW** with the reason. |
| A lead is stuck in NEW | Every 5 minutes, `retryPending` runs it again. Steps already done are skipped (each email and the CRM save are stamped), so nothing is sent twice. |
| Still failing after 4 retries | Status **NEEDS HUMAN** and the owner gets an email with the customer's details. |
| The AI wrongly says "not a lead", or a duplicate was really a new request | Every evening, `dailySummary` emails the owner the NOT A LEAD and DUPLICATE messages, so a human sees them. |

## Statuses

| Status | Meaning |
|---|---|
| NEW | Received, being processed, or waiting for a retry (see Reason) |
| REJECTED | Failed the basic check |
| DUPLICATE | Same as an earlier request (Reason says which) |
| NOT A LEAD | The AI says it is not a customer request (owner sees it in the daily summary) |
| DONE | Owner alerted, customer emailed, saved in the CRM |
| NEEDS HUMAN | Failed 4 retries, owner was emailed |

## How to run it

1. Create a Google Form with: Your name, Your email, Your phone, What do you need?. Link it to a Google Sheet.
2. In the sheet's Apps Script project, paste `Code.gs`.
   **Important:** keep the responses sheet as a normal range. If Google Sheets shows it as a "table" (coloured header with a table name), use the table menu → "Revert to unformatted data". Writing next to a table made every run hang for 6 minutes in my tests.
3. In `CONFIG` at the top, set `SPREADSHEET_ID`, `OWNER_EMAIL`, `BUSINESS_NAME`.
4. In **Project Settings → Script Properties**, add `GEMINI_API_KEY` and `HUBSPOT_TOKEN` (a HubSpot service key with `crm.objects.contacts.read` and `crm.objects.contacts.write`). Keys are never written in the code.
5. Run `setup` once and approve the permissions. It installs 3 triggers: on form submit, retry every 5 minutes, summary every day.
6. Test mode: while `TEST_SEND_CUSTOMER_EMAILS_TO` has an address, customer emails go there instead of to the customer. Set it to `''` to go live.

## How to check it works

- Send the form. Within a minute the row gets a Lead ID and a status, and the Log shows each step.
- See `TESTS.md` for every test and its result.
- Demo switches for testing failures: run `demoAiDown` or `demoCrmDown`, send the form, watch the lead wait and retry, then run `demoAllUp`.

## Limits (honest)

- Apps Script runs at most 6 minutes per run and has daily email quotas (about 100 emails/day on a free Google account).
- The AI can still be wrong. That is why NOT A LEAD messages go to the owner every day instead of being deleted.
- Time-based triggers in Apps Script can run a few minutes late.
