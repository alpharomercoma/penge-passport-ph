# Law, the DFA's rules, and how much we ask of passport.gov.ph

This is research, not legal advice. It was done on 27 September 2026. Every quotation below was checked
against its source that day, unless it is marked otherwise. Where a question needs a lawyer, this page
says so rather than guessing.

## What PengePassportPH does, in the terms that matter

- It reads what the booking page on passport.gov.ph reads for any visitor: which dates an office has
  released, and the hours of a day. It calls the same public endpoints that page's own scripts call.
- It never selects, holds, books or sells a time slot. It never touches reCAPTCHA, which guards only the
  step that holds a slot, and it logs in nowhere.
- It is free: no fees, no ads, no donations.
- Every request says who is asking. The User-Agent names the software, links to the project's live
  website, and carries the operator's contact.
- It stores no personal data from the DFA. The only personal data it holds is its own subscribers' email
  addresses, which it encrypts, confirms by double opt-in, and deletes on unsubscribe (encrypted daily
  backups drop them within 14 days). The runbook lists
  [every place an address exists](../../deploy/README.md#where-a-subscribers-address-goes).

## What the DFA says

**There is no published rule on automated access.**
- passport.gov.ph has no `robots.txt`: it answered HTTP 404 on 27 September 2026.
- The site's terms of use ([12]) say only that "This appointment and scheduling system allocates slots
  on a first come, first served basis."
- Its privacy policy says it logs visitors' "originating IP address" ([12]).
- No DFA page found says anything about bots, scraping, request rates, or services that alert people
  when dates open.

**The DFA tells people to check often.** From the site's own FAQ ([11]):

> "Please CLICK REFRESH as online appointments become available from time to time. You can also CHECK
> THE NEXT OPENING as slots are made available at 12:00 noon and 9:00 p.m. Mondays to Saturdays except
> holidays."

**What it forbids is hoarding and paid help.**
- The same FAQ calls fixers and "passport appointment assistance services" illegal: "Yes, it is a
  violation of the law. Violators will be prosecuted and barred from applying for passport." ([11])
- Its consular site's terms for appointments are quoted in our research as saying: "Deliberate, multiple
  attempts to circumvent the system to secure a schedule for the purpose of blocking several dates in
  advance is detrimental to public service. Users who are found to have abused the system will be
  blocked" ([13]). That site refuses automated requests and has no archived copy, so this was read in a
  browser and not re-checked here.
- In March 2022 the DFA said it was working "to put a stop to the abuse of appointment slots by
  enterprising individuals and groups" ([14]).

## Philippine law

### RA 11983, the New Philippine Passport Act (2024)

Section 22(d) ([1]) makes it a crime when a person:

- "(3) Offers, for any material gain or consideration, to escort a passport applicant, or assist the same
  in booking an appointment, filling out an application form, making payments, handling application
  documents, or any other action relating to passport application"
- "(4) Hoards and/or sells online passport appointment slots for pecuniary gain or advantage"

The penalty is "Imprisonment of not less than six (6) years and one (1) day but not more than twelve (12)
years and a fine of not less than One hundred thousand pesos (P100,000.00) but not more than Two hundred
fifty thousand pesos (P250,000.00)".

**What it means for us.** Both offences turn on gain: "material gain or consideration", or "pecuniary gain
or advantage". PengePassportPH stays free and never books a slot for anyone.

**Open question.** The DFA's FAQ calls "passport appointment assistance services" illegal. That wording is
wider than the Act's. A lawyer should say whether a free service that only tells people when dates open
counts as "assistance".

### RA 10175, the Cybercrime Prevention Act (2012)

From the text on LawPhil ([2]):

- **"Without right"** (Sec. 3(h)): "Either: (i) conduct undertaken without or in excess of authority; or
  (ii) conduct not covered by established legal defenses, excuses, court orders, justifications, or
  relevant principles under the law."
- **Illegal access** (Sec. 4(a)(1)): "The access to the whole or any part of a computer system without
  right."
- **System interference** (Sec. 4(a)(4)): "The intentional alteration or reckless hindering or
  interference with the functioning of a computer or computer network by inputting, transmitting,
  damaging, deleting, deteriorating, altering or suppressing computer data or program, electronic
  document, or electronic data message, without right or authority, including the introduction or
  transmission of viruses."

**What the Supreme Court said.** In *Disini v. Secretary of Justice* (2014), the Court upheld the
illegal-access provision as punishing "accessing the computer system of another without right". It
added: "Since the ethical hacker does his job with prior permission from the client, such permission
would insulate him from the coverage of Section 4(a)(1)." ([3]) The decision does not deal with public
websites or automated reading.

**How the treaty behind it reads "without right".** The Philippines is a party to the Budapest Convention
on Cybercrime. Its Explanatory Report ([4]) is an aid to interpreting the Convention, not Philippine law,
but it speaks directly to this:

- ¶47: "there is no criminalisation for accessing a computer system that permits free and open access
  by the public, as such access is 'with right.'"
- ¶48: "The application of specific technical tools may result in an access under Article 2, such as the
  access of a web page, directly or through hypertext links, including deep-links or the application of
  'cookies' or 'bots' to locate and retrieve information on behalf of communication. The application of
  such tools per se is not 'without right'. The maintenance of a public web site implies consent by the
  web site-owner that it can be accessed by any other web-user."
- ¶67 sets a bar for interference. The hindering must be "serious", which the drafters described as "the
  sending of data to a particular system in such a form, size or frequency that it has a significant
  detrimental effect on the ability of the owner or operator to use the system".

**What it means for us.** Reading a public page is, on the treaty's reading, "with right". The real limit
on how much we ask is system interference. RA 10175 punishes "reckless hindering or interference" and,
unlike the Convention, has no "serious" threshold. So we must never plausibly hinder the site. That is
why we keep requests spaced out, back off on errors, rest when the site struggles, and say who we are
(see [Our limits](#our-limits-and-why)).

### RA 12254, the E-Governance Act (2025)

From the text on LawPhil ([5]):

- Section 21(c): government websites shall "Include the ability to provide access to public information
  via an API".
- Section 23: "Access to and use of the resources, information, and data in the government information
  systems shall be limited to the government and its duly authorized officers and agents, in accordance
  with all relevant laws, rules, and regulations on data and information privacy and the pertinent rules
  on confidentiality of government information".

**Open question.** Section 23 sits uneasily beside Section 21(c) and beside the public booking page
itself. A lawyer should say how Section 23 applies to reading information any visitor can see.

### RA 10173, the Data Privacy Act (2012)

"Personal information" (Sec. 3(g), [6]) is "any information whether recorded in a material form or not,
from which the identity of an individual is apparent or can be reasonably and directly ascertained by
the entity holding the information, or when put together with other information would directly and
certainly identify an individual."

- Which dates an office has open identifies nobody.
- Our subscribers' email addresses do, so the Act covers how we handle them.

### DICT

No DICT circular, order or plan found says anything about bots, crawling, rate limits, or acceptable use
of government websites. The research read DICT MC 005 (2017), DICT MC 2017-004, ICTO MC 2015-001, AO 39
(2013), EO 58 (2024), and RA 12254 with its implementing rules. There is no official number to follow.

## How others set limits

**Crawling norms.** Google says: "Googlebot shouldn't access your site more than once every few seconds
on average." ([7]) RFC 9110 says: "A robotic user agent SHOULD send a valid From header field so that
the person responsible for running the robot can be contacted if problems occur on servers, such as if
the robot is sending excessive, unwanted, or invalid requests." ([8])

**The European Statistical System's guidelines** ([9], issued 1 April 2022) ask anyone retrieving web
content to:
- "seek to minimise the impact on the web servers";
- "inform website owners directly and individually when the content retrieval from the website is
  expected to have a significant impact on the web server, e.g. when a website is scraped with a high
  frequency";
- apply measures such as "adding idle time between requests" and "retrieving content at times when the
  web server is not expected to be subject to a heavy load";
- identify themselves "via the user-agent string of the web bot" with a link to a page on the purpose
  and contact details.

**Published government limits** are for APIs built for machine traffic, so they don't transfer to a
booking website. The research found, for example:

| Source | Limit |
|---|---|
| US SEC EDGAR | 10 requests a second |
| UK Companies House | 600 requests in 5 minutes |
| api.data.gov (US) | 1,000 requests an hour per key |

The DFA publishes no API and no limit.

## What governments abroad have done

- **United Kingdom, driving tests.** Since 12 May 2026 the UK's driving test agency says: "You are not
  allowed to use unofficial services that scan the driving test booking service for appointments. This
  includes driving test cancellation finder websites or apps." ([10]) A government can ban read-only
  scanners outright. The Philippines has not.
- **Spain, immigration appointments.** On 12 May 2023, 69 people were arrested over bots that
  "obtenían la práctica totalidad de las citas personales disponibles" (took practically every
  appointment). As a result, "el sistema quedaba inaccesible para los usuarios" (the system became
  inaccessible to users). The charges were criminal organisation and "daños informáticos" (computer
  damage) ([15]).
- **India, US visas.** In March 2025 the US Embassy said: "Consular Team India is canceling about 2000
  visa appointments made by bots. We have zero tolerance for agents and fixers that violate our
  scheduling policies." ([16])

All of these cases involved taking or selling appointments, or a flat ban. None punished a free service
that only reads.

## What is known about the DFA's system

We don't assume its servers are old or weak. What the record shows:

- **Operator.** The DFA's privacy policy names "APO Production Unit ("APO"), a Government-owned
  corporation and a recognized Government printer and authorized data processor of the DFA" ([12]). The
  site's certificate is issued to APO Production Unit, Inc.
- **Hosting.** `passport.gov.ph`, the address the DFA tells people to use, answers directly from a Globe
  Telecom address with no CDN in front. `www.passport.gov.ph` is behind Cloudflare, which challenges
  scripts. So our requests reach the site's own server, not a cache in front of it.
- **Volume.**
  - "replenishing at least 10,000 slots at 12 noon and 9 p.m., Monday to Saturday, except holidays"
    (2018, [17]);
  - "daily appointments for passport services online could reach at least 14,855" (2022, [14]).
- **Capacity.** It is not published anywhere we found. Outages are on record: after large slot releases
  in 2018, from a power failure in 2022, and during maintenance in 2024. None was blamed on third-party
  traffic.
- **What we have measured** (26–27 September 2026, while scanning every 15 minutes):
  - 185 requests in an hour, never closer than 3.0 seconds apart;
  - errors on 5 of 2,236 office checks (0.22%): two HTTP 500s and three connection timeouts in one scan;
  - never an HTTP 429 ("too many requests").

## Our limits, and why

| | Setting |
|---|---|
| Scans | Every 5 minutes, about 45 requests each, taking about 2.5 minutes |
| Scans' budget | At most 720 requests in any rolling hour, on their own rate limiter (a full hour of scans needs 696 at most) |
| Visitors' lookups | At most 1,000 requests in any rolling hour, on a separate rate limiter; each answer shared for 3 minutes |
| Spacing | At least 3 seconds between requests on each limiter |
| Worst case | 1,720 requests an hour if both budgets were ever used up (one every 2.1 s on average); scans alone are about 540 |
| Errors | Backoff doubling from 5 s to 10 minutes; the site's `Retry-After` honoured up to an hour; after 5 failures in a row, a 15-minute pause |
| When the site struggles | After a scan with 3 or more offices still failing, or a paused limiter, scans rest 10 minutes; a scan still running when the next is due is skipped |
| Hard ceiling | The library refuses more than 1,200 requests an hour on any one limiter |
| Identity | User-Agent: `penge-passport-ph/<version> (+https://alphaexperimental.org/pengepassportph/; read-only availability checker; <contact>)` |

**Why these numbers.** On 27 September 2026 the maintainer moved from 15-minute scans and 300 requests an
hour in total to the settings above.
- **The case for.** Openings are short-lived: of the openings our scans saw on 26–27 September, 60% were
  gone by the next scan 15 minutes later. Scanning more often catches more of them, sooner.
- **The case for caution.** Our requests reach the site's origin server directly. The law's line is "reckless
  hindering". The UK shows a government can ban scanners. The DFA does not yet know this service exists.
- The rest of this page's open items follow from that.

## Lines we do not cross

- No fees, ads or donations tied to appointments, ever (RA 11983).
- Never select, hold, book or sell a slot, or act for an applicant.
- Never get past reCAPTCHA, a Cloudflare challenge, or any other barrier the DFA puts up.
- Never hide who is asking.
- If the DFA or APO asks us to slow down or stop, we do it at once, then talk.
  - `systemctl disable --now penge-check.timer` stops the scans.
  - `systemctl stop penge-api` stops visitors' lookups too, and the website with them.

## Open items

1. **Tell the DFA.** Write to the DFA Office of Consular Affairs, and to APO if possible. Say what the
   service does, how often it asks, and who to contact; offer to slow down or stop. Ask whether they
   would publish an official feed, which RA 12254 Section 21(c) calls for. The ESS guidelines ask for
   exactly this when scraping is frequent.
2. **Ask a lawyer** two questions: whether a free alert service is "assistance" under RA 11983 Section
   22(d)(3), and how RA 12254 Section 23 applies to reading public pages.
3. **Consider sending a `From` header** with a monitored address, as RFC 9110 recommends. Today the
   contact is in the User-Agent only.

## References

Checked on 27 September 2026 unless marked.

1. RA 11983, New Philippine Passport Act (11 March 2024). https://www.lawphil.net/statutes/repacts/ra2024/ra_11983_2024.html
2. RA 10175, Cybercrime Prevention Act of 2012. https://lawphil.net/statutes/repacts/ra2012/ra_10175_2012.html
3. *Disini v. Secretary of Justice*, G.R. No. 203335, 11 February 2014. https://lawphil.net/judjuris/juri2014/feb2014/gr_203335_2014.html
4. Council of Europe, Explanatory Report to the Convention on Cybercrime, ¶47–48 and ¶67. https://www.oas.org/juridico/english/cyb_pry_explanatory.pdf
5. RA 12254, E-Governance Act (2025), Sections 21(c) and 23. https://lawphil.net/statutes/repacts/ra2025/ra_12254_2025.html
6. RA 10173, Data Privacy Act of 2012, Section 3(g). https://lawphil.net/statutes/repacts/ra2012/ra_10173_2012.html
7. Google Search Central, "Googlebot". https://developers.google.com/search/docs/crawling-indexing/googlebot
8. RFC 9110, HTTP Semantics, Section 10.1.2. https://www.rfc-editor.org/rfc/rfc9110.html
9. European Statistical System, Web content retrieval guidelines (1 April 2022). https://cros.ec.europa.eu/system/files/2025-03/web_content_retrieval_guidelines_20220401_0.pdf
10. GOV.UK, "Changes to driving test booking rules in 2026". https://www.gov.uk/guidance/changes-to-driving-test-booking-rules-in-2026
11. DFA passport FAQ. https://passport.gov.ph/faqs_2
12. DFA Online Passport Appointment System: terms at https://passport.gov.ph/appointment, privacy policy at https://passport.gov.ph/privacy-policy/linkages-characteristics
13. DFA Office of Consular Affairs, "Reminders for Securing Passport Appointment". https://consular.dfa.gov.ph/reminders-for-securing-passport-appointment/ (read in a browser; not re-checked)
14. Philippine News Agency, 24 March 2022. https://www.pna.gov.ph/articles/1170546
15. elDiario.es, 12 May 2023. https://www.eldiario.es/comunitat-valenciana/69-detenidos-desmantelamiento-entramado-bloqueaba-sistema-citas-online-extranjeria-acapararlas-revenderlas_1_10198315.html
16. The Tribune (India), 27 March 2025. https://www.tribuneindia.com/news/world/zero-tolerance-for-agents-and-fixers-us-cancels-over-2k-visa-appointments-by-bots
17. Philippine News Agency, 27 September 2018. https://www.pna.gov.ph/articles/1049317
