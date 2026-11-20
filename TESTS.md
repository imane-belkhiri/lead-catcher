# Lead Catcher: tests

Every test was run through the real Google Form (not by calling the code directly), unless it says otherwise.
Customer emails are in test mode: they go to the owner's inbox with "[TEST, real customer: ...]" in the subject.

| # | Test | What I sent | Expected | Result | Date |
|---|---|---|---|---|---|
| 1 | Normal request | Name, email, "My AC stopped cooling, I need a repair quote this week" | Lead ID + NEW | ✅ LEAD-0002, NEW | 18 Nov |
| 2 | Same request twice | Exactly test 1 again, 24 s later | DUPLICATE, "Same as LEAD-0002" | ✅ LEAD-0003, DUPLICATE | 18 Nov |
| 3 | Message too short | "hi" | REJECTED, reason given | ✅ LEAD-0004, REJECTED, "Message is shorter than 10 characters" | 18 Nov |
| 4 | Two runs at the same time | Tests 1-3 sent within 40 s while the first run hung | Second run waits, then logs a lock error. No request lost | ✅ Lock errors in the Log, all 3 rows still in the sheet, labelled later with processMissedRows | 18 Nov |
| 5 | Spam | "We sell SEO packages, get 10,000 visitors to your website this month!" | NOT A LEAD | ✅ LEAD-0006, NOT A LEAD, "This is an advertisement…" | 18 Nov |
| 6 | AI model retired | Model gemini-2.5-flash | Error is caught, lead not lost | ✅ HTTP 404 caught. Fixed: switched model | 18 Nov |
| 7 | AI overloaded | Real Gemini 503 "high demand" (twice) | Error caught, lead stays NEW | ✅ 503 caught. Fixed: 3 models tried in order | 18 Nov |
| 8 | Urgent real lead, full path | "Our office AC is leaking water and not cooling, can someone come today?" | AI: lead, high. Owner email with URGENT. Customer confirmation | ✅ LEAD-0007. Both emails received | 20 Nov |
| 9 | Saved in CRM | "I want to install 2 new split AC units…" | HubSpot contact created, ID in "CRM contact", status DONE | ✅ LEAD-0008, DONE, contact 932818766071 (after a retry, see bug 4) | 20 Nov |
| 10 | Same customer again (CRM) | Same email, new message | Same HubSpot contact updated, not a second one | ✅ LEAD-0009 saved to the same contact 932818766071 | 20 Nov |
| 11 | AI down | demoAiDown, then send the form | Stays NEW "AI failed", retried every 5 min, NEEDS HUMAN after 4 retries + owner email | ✅ LEAD-0010: AI ERROR at 16:28, retries at 16:36, 16:41, 16:46, 16:51, NEEDS HUMAN at 16:56, owner email received. Then demoAllUp | 20 Nov |
| 12 | CRM down | demoCrmDown, then send the form | Emails still sent once, stays NEW "CRM failed", after demoAllUp the retry finishes it: DONE, no second email | ✅ LEAD-0009: emails sent, CRM ERROR. After demoAllUp, the 16:26 retry saved it in HubSpot, DONE, no email sent again | 20 Nov |
| 13 | Daily summary | Run dailySummary | Lists NOT A LEAD messages of the last 24 h and NEEDS HUMAN leads; says "Nothing to report" when empty | ✅ Ran, nothing in the last 24 h → logged "Nothing to report". Email path checked again after test 11 | 20 Nov |

## Bugs found while testing (and fixed)

1. **The script could not find the sheet** (`forSpreadsheet` error). The project was not attached to the sheet. Fix: open the sheet by its ID.
2. **The first run hung for 6 minutes.** The response sheet was formatted as a Google Sheets "table", and writing next to it made every save very slow. Fix: turned it back into a normal range. Runs now take a few seconds.
3. **Gemini model retired** (HTTP 404) and then **overloaded** (HTTP 503). Fix: a list of 3 models, tried in order.
4. **A slow AI call held the lock for 6 minutes** (LEAD-0008) and the retry timer wasted its tries waiting for the lock. Fix: fastest model first, stop after 90 s, and a busy lock no longer counts as a try.
5. **The Retries counter was read as a date** (the new column took the date format of the column next to it), so LEAD-0007 shows a strange number. Fix: read it only as a number, and write it with a number format.

## What these tests prove

- No request was lost in any test, including the crash, the 6-minute hang and the services being down.
- Re-running a lead never sent an email twice (LEAD-0007 and LEAD-0009 were re-run after their emails).
