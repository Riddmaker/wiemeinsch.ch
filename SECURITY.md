# Sicherheitsrichtlinie

wiemeinsch.ch verarbeitet politische Meinungsäusserungen und freiwillige
demografische Angaben. Hinweise auf Schwachstellen nehmen wir deshalb ernst und
sind für jede vertrauliche Meldung dankbar.

*English summary: please report vulnerabilities privately via GitHub’s
“Report a vulnerability” button (see below), never as a public issue. Reports
in English are welcome.*

## Schwachstelle melden

**Bitte nicht als öffentliches Issue, Pull Request oder Diskussion.**

Melden Sie Schwachstellen vertraulich über GitHub:
**[Report a vulnerability](https://github.com/Riddmaker/wiemeinsch.ch/security/advisories/new)**
(Reiter *Security* → *Advisories* → *Report a vulnerability*).

Hilfreich sind:

- eine Beschreibung der Schwachstelle und der betroffenen Stelle
  (URL, Endpunkt, Datei im Code),
- die Schritte zur Reproduktion,
- Ihre Einschätzung der Auswirkung — was könnte eine angreifende Person damit
  erreichen?

## Was Sie von uns erwarten können

- Wir bestätigen den Eingang so rasch wie möglich, in der Regel innert einer
  Woche.
- Wir halten Sie über Einschätzung und Behebung auf dem Laufenden.
- Nach der Behebung veröffentlichen wir auf Wunsch ein Advisory und nennen Sie
  als meldende Person — oder eben nicht, wenn Sie anonym bleiben möchten.
- Es gibt kein Bug-Bounty-Programm.

## Geltungsbereich

**Im Geltungsbereich:** der Code in diesem Repository und die unter
wiemeinsch.ch betriebene Anwendung — insbesondere Zugriffskontrolle,
Offenlegung personenbezogener oder demografischer Daten, Injection (auch
Prompt-Injection in den Civic-Linter), XSS sowie Umgehung von Moderation oder
Rate-Limiting.

**Nicht im Geltungsbereich:**

- Denial-of-Service und Last- oder Volumentests,
- Social Engineering und Phishing,
- Schwachstellen bei Drittanbietern (z.B. Hosting, Cloudflare, Mistral), die
  bitte direkt dort gemeldet werden,
- automatisierte Scanner-Ergebnisse ohne nachgewiesene Auswirkung.

## Regeln für Tests in gutem Glauben

Wer in gutem Glauben und im Rahmen dieser Richtlinie nach Schwachstellen sucht,
handelt aus unserer Sicht erwünscht. Bitte dabei:

- nur mit eigenen Test-Konten arbeiten und nicht auf Daten anderer Personen
  zugreifen, sie verändern oder speichern — ist das unvermeidbar, sofort
  aufhören und es in der Meldung erwähnen,
- keine Inhalte publizieren, die andere Nutzende betreffen,
- den Betrieb nicht beeinträchtigen,
- Details erst veröffentlichen, wenn die Schwachstelle behoben ist oder wir uns
  abgesprochen haben.
